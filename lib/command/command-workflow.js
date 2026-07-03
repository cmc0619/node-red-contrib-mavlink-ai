'use strict';

const { MavlinkError } = require('../util/errors');
const enumResolver = require('../protocol/enum-resolver');

/**
 * MAVLink command protocol workflow (issue #16).
 *
 *   COMMAND_LONG/COMMAND_INT -> COMMAND_ACK
 *
 * The command protocol is request/response: the vehicle answers with a
 * COMMAND_ACK carrying a MAV_RESULT, and the sender retransmits with an
 * incrementing `confirmation` on timeout (COMMAND_LONG only — COMMAND_INT has
 * no confirmation field and is resent unchanged). Like the mission/param
 * workflows this is stateful and timeout-driven, so it lives behind an
 * explicit workflow with settle-once semantics rather than in the node.
 */

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RETRIES = 3;

// MAV_RESULT values the workflow branches on.
const MAV_RESULT_ACCEPTED = 0;
const MAV_RESULT_IN_PROGRESS = 5;

const COMMAND_STATES = {
  IDLE: 'idle',
  WAITING_ACK: 'waiting_ack',
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete',
  FAILED: 'failed'
};

class CommandSend {
  /**
   * @param {object} opts
   * @param {object} opts.connection        connection runtime API (§12)
   * @param {number} opts.targetSystem
   * @param {number} opts.targetComponent
   * @param {string|number} opts.command    MAV_CMD name or number
   * @param {object} [opts.fields]          full command fields (param1..7 or
   *   frame/x/y/z for COMMAND_INT); target/confirmation are managed here
   * @param {boolean} [opts.useInt]         send COMMAND_INT instead of COMMAND_LONG
   * @param {object} [opts.enums]           dialect enum index
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries]
   * @param {function(object): void} [opts.onProgress]
   */
  constructor(opts = {}) {
    this.connection = opts.connection;
    this.targetSystem = Number(opts.targetSystem);
    this.targetComponent = Number(opts.targetComponent);
    this.enums = opts.enums || null;
    this.useInt = opts.useInt === true;
    this.fields = opts.fields && typeof opts.fields === 'object' ? opts.fields : {};
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    // Clamp timeout/retries so bad input can't disable the retry ceiling.
    const timeoutMs = Number(opts.timeoutMs == null ? DEFAULT_TIMEOUT_MS : opts.timeoutMs);
    const maxRetries = Number(opts.maxRetries == null ? DEFAULT_MAX_RETRIES : opts.maxRetries);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.trunc(maxRetries) : DEFAULT_MAX_RETRIES;

    // Resolve the command to its number up front: the ack is matched on the
    // numeric MAV_CMD, and an unresolvable name must fail loudly here rather
    // than serialize garbage.
    this.commandRef = opts.command;
    const resolved = this.enums
      ? enumResolver.resolveEnumValue(this.enums, opts.command)
      : opts.command;
    const n = Number(resolved);
    if (!Number.isFinite(n)) {
      throw new MavlinkError('BAD_COMMAND', `Cannot resolve command '${opts.command}' to a MAV_CMD number.`, {
        command: opts.command
      });
    }
    this.command = n;

    this.state = COMMAND_STATES.IDLE;
    this._confirmation = 0;
    this._subs = [];
    this._timer = null;
    this._retries = 0;
    this._settled = false;
    this._resolve = null;
    this._reject = null;
  }

  /**
   * Run the workflow: send, retransmit on timeout, settle on COMMAND_ACK.
   *
   * @returns {Promise<object>} resolves with `{ topic: 'command/ack', payload }`
   *   on MAV_RESULT_ACCEPTED; rejects with COMMAND_REJECTED / COMMAND_TIMEOUT
   */
  run() {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      try {
        this._subs.push(
          this.connection.subscribe(
            { messageNames: ['COMMAND_ACK'], sysid: this.targetSystem },
            (msg) => this._onAck(msg.payload)
          )
        );
        this._sendCommand();
      } catch (err) {
        this._fail(err);
      }
    });
  }

  /**
   * Send the command with the current confirmation counter and arm the
   * retransmit timeout.
   *
   * @returns {void}
   */
  _sendCommand() {
    this.state = COMMAND_STATES.WAITING_ACK;
    const name = this.useInt ? 'COMMAND_INT' : 'COMMAND_LONG';
    const fields = Object.assign({}, this.fields, {
      command: this.command,
      target_system: this.targetSystem,
      target_component: this.targetComponent
    });
    if (!this.useInt) {
      // Retransmissions increment confirmation per the command protocol so the
      // vehicle can tell a retry from a new command.
      fields.confirmation = this._confirmation;
    }
    this.onProgress({
      topic: 'command/progress',
      payload: { state: this.state, command: this.command, confirmation: this._confirmation }
    });
    this.connection
      .send({ name, fields })
      .then(() => this._armTimeout())
      .catch((err) => this._fail(err));
  }

  /** @returns {void} */
  _armTimeout() {
    if (this._settled) {
      return; // an early ack can settle before connection.send() resolves
    }
    this._clearTimeout();
    this._timer = setTimeout(() => {
      if (this._settled) {
        return;
      }
      if (this._retries >= this.maxRetries) {
        this._fail(
          new MavlinkError('COMMAND_TIMEOUT', `No COMMAND_ACK for command ${this._commandLabel()} in state '${this.state}'.`, {
            command: this.command,
            command_name: this._commandName(),
            target_system: this.targetSystem,
            target_component: this.targetComponent,
            state: this.state
          })
        );
        return;
      }
      this._retries += 1;
      this._confirmation = (this._confirmation + 1) & 0xff;
      this._sendCommand();
    }, this.timeoutMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  /**
   * Handle an inbound COMMAND_ACK for our command: complete on ACCEPTED, keep
   * waiting on IN_PROGRESS (progress event, timeout re-armed without a
   * retransmit), fail with the readable result otherwise.
   *
   * @param {object} payload  decoded §14.1 COMMAND_ACK payload
   * @returns {void}
   */
  _onAck(payload) {
    if (Number(payload.sysid) !== this.targetSystem) {
      return;
    }
    // Another component on the same system (e.g. a gimbal) may ack the same
    // MAV_CMD; only the addressed component's ack settles this workflow.
    // Component 0 means we broadcast to the whole system, so any responder
    // counts.
    const ackComponent = Number(payload.compid);
    if (
      this.targetComponent !== 0 &&
      Number.isFinite(this.targetComponent) &&
      Number.isFinite(ackComponent) &&
      ackComponent !== this.targetComponent
    ) {
      return;
    }
    const f = payload.fields;
    if (Number(f.command) !== this.command) {
      return; // ack for some other command
    }
    const result = Number(f.result);
    const ack = {
      command: this.command,
      command_name: this._commandName(),
      result,
      result_name: this._resultName(result),
      progress: f.progress,
      result_param2: f.result_param2
    };

    if (result === MAV_RESULT_IN_PROGRESS) {
      // The vehicle is working on it; progress (0-100) rides in f.progress.
      // Re-arm the wait without retransmitting (a retry would restart it).
      this.state = COMMAND_STATES.IN_PROGRESS;
      this._retries = 0;
      this.onProgress({ topic: 'command/progress', payload: Object.assign({ state: this.state }, ack) });
      this._clearTimeout();
      this._armTimeout();
      return;
    }

    this._clearTimeout();
    if (result === MAV_RESULT_ACCEPTED) {
      this._complete({ topic: 'command/ack', payload: ack });
    } else {
      this._fail(
        new MavlinkError(
          'COMMAND_REJECTED',
          `Command ${this._commandLabel()} rejected: ${ack.result_name || `MAV_RESULT ${result}`}.`,
          ack
        )
      );
    }
  }

  /** @returns {?string} readable MAV_CMD name */
  _commandName() {
    if (typeof this.commandRef === 'string' && !/^\d+$/.test(this.commandRef)) {
      return String(this.commandRef).toUpperCase();
    }
    return this.enums ? enumResolver.nameFor(this.enums, 'MavCmd', this.command) : undefined;
  }

  /** @returns {string} label for error messages */
  _commandLabel() {
    const name = this._commandName();
    return name ? `${name} (${this.command})` : String(this.command);
  }

  /** @returns {?string} readable MAV_RESULT name */
  _resultName(result) {
    return this.enums ? enumResolver.nameFor(this.enums, 'MavResult', result) : undefined;
  }

  /** @returns {void} */
  _clearTimeout() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** @returns {void} */
  _cleanup() {
    this._clearTimeout();
    for (const id of this._subs) {
      this.connection.unsubscribe(id);
    }
    this._subs = [];
  }

  /** @returns {void} */
  _complete(result) {
    if (this._settled) {
      return;
    }
    this._settled = true;
    this.state = COMMAND_STATES.COMPLETE;
    this._cleanup();
    this._resolve(result);
  }

  /** @returns {void} */
  _fail(err) {
    if (this._settled) {
      return;
    }
    this._settled = true;
    this.state = COMMAND_STATES.FAILED;
    this._cleanup();
    this._reject(err instanceof MavlinkError ? err : new MavlinkError('COMMAND_FAILED', err.message));
  }
}

module.exports = {
  COMMAND_STATES,
  MAV_RESULT_ACCEPTED,
  MAV_RESULT_IN_PROGRESS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  CommandSend
};
