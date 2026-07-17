'use strict';

const { MavlinkError } = require('../util/errors');
const enumResolver = require('../protocol/enum-resolver');
const { commandPriority } = require('../runtime/send-priority');

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
   * @param {string|object} [opts.vehicleProfile]  Vehicle Profile reference
   *   (config-node id) carried on every send so the connection encodes with
   *   that profile's dialect instead of its default
   * @param {string|object} [opts.localIdentity]  explicit Local Identity
   *   reference carried on every send; omit to transmit as the connection's
   *   default identity (#228)
   * @param {number} opts.targetSystem
   * @param {number} opts.targetComponent
   * @param {number} [opts.sourceSystem]     this GCS's own system id, matched
   *   against the ACK's target_system so an ACK meant for another GCS on the
   *   same link is ignored (#99)
   * @param {number} [opts.sourceComponent]  this GCS's own component id
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
    this.vehicleProfile = opts.vehicleProfile == null || opts.vehicleProfile === '' ? null : opts.vehicleProfile;
    this.localIdentity = opts.localIdentity == null || opts.localIdentity === '' ? null : opts.localIdentity;
    this.targetSystem = Number(opts.targetSystem);
    this.targetComponent = Number(opts.targetComponent);
    // Our own identity (this profile's source system/component). Used to reject
    // a COMMAND_ACK addressed to a different GCS when two GCSs share one link
    // and issue the same command to the same vehicle (#99).
    this.sourceSystem = opts.sourceSystem == null ? null : Number(opts.sourceSystem);
    this.sourceComponent = opts.sourceComponent == null ? null : Number(opts.sourceComponent);
    this.enums = opts.enums || null;
    this.useInt = opts.useInt === true;
    this.fields = opts.fields && typeof opts.fields === 'object' ? opts.fields : {};
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    // Clamp timeout/retries so bad input can't disable the retry ceiling.
    const timeoutMs = Number(opts.timeoutMs == null ? DEFAULT_TIMEOUT_MS : opts.timeoutMs);
    const maxRetries = Number(opts.maxRetries == null ? DEFAULT_MAX_RETRIES : opts.maxRetries);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.trunc(maxRetries) : DEFAULT_MAX_RETRIES;

    /**
     * Resolve the command to its number up front: the ack is matched on the
     * numeric MAV_CMD, and an unresolvable name must fail loudly here rather
     * than serialize garbage. Names resolve against MavCmd ONLY (#153) — the
     * global index would turn a member of an unrelated enum into a
     * wrong-but-valid command number (e.g. 'MAV_STATE_EMERGENCY' silently
     * became command 4). Numbers and numeric strings pass through, so raw or
     * dialect-external command ids remain usable.
     */
    this.commandRef = opts.command;
    const resolved = this.enums
      ? enumResolver.resolveInEnum(this.enums, 'MavCmd', opts.command)
      : opts.command;
    const n = Number(resolved);
    if (resolved === undefined || !Number.isFinite(n)) {
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
    /**
     * Set once a MAV_RESULT_IN_PROGRESS ack arrives: from then on the vehicle
     * owns the operation, so timeouts extend the wait instead of retransmitting
     * (a retransmit could restart a calibration/motor-test mid-run, #144).
     * `_inProgressWaits` bounds the post-IN_PROGRESS silence so a vehicle that
     * goes quiet still fails rather than hanging forever; each fresh
     * IN_PROGRESS resets it.
     */
    this._inProgress = false;
    this._inProgressWaits = 0;
    this._settled = false;
    this._resolve = null;
    this._reject = null;
    this._lock = null;
  }

  /**
   * Run the workflow: send, retransmit on timeout, settle on COMMAND_ACK.
   *
   * COMMAND_ACK carries no transaction id, so two concurrent workflows for the
   * same (target sysid, target compid, MAV_CMD) cannot tell whose ack arrived —
   * both would consume the same one and both report success (#82). A per
   * connection lock keyed on that triple makes the second identical request
   * fail fast (COMMAND_BUSY) before anything is sent, while different commands
   * or targets stay fully concurrent. The lock is released on every settle
   * path (accepted, rejected, timeout, send failure, abort).
   *
   * @returns {Promise<object>} resolves with `{ topic: 'command/ack', payload }`
   *   on MAV_RESULT_ACCEPTED; rejects with COMMAND_BUSY / COMMAND_REJECTED /
   *   COMMAND_TIMEOUT
   */
  run() {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      try {
        if (typeof this.connection.acquireLock === 'function') {
          const lockKey = `command:${this.targetSystem}:${this.targetComponent}:${this.command}`;
          try {
            this._lock = this.connection.acquireLock(lockKey, `command-${this.command}`);
          } catch (err) {
            if (!err || err.code !== 'LOCK_HELD') {
              throw err; // e.g. CONNECTION_INVALID — not a busy condition
            }
            throw new MavlinkError(
              'COMMAND_BUSY',
              `An identical command ${this._commandLabel()} to system ${this.targetSystem} component ${this.targetComponent} is already awaiting its ACK; its response would be indistinguishable from this one.`,
              {
                command: this.command,
                command_name: this._commandName(),
                target_system: this.targetSystem,
                target_component: this.targetComponent
              }
            );
          }
        }
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
   * Abort the workflow (e.g. the owning node closed mid-flight) with a
   * `COMMAND_ABORTED` error. Settle-once: cleans up the timer, subscriptions,
   * and lock exactly like any other completion path; a no-op if already
   * settled.
   *
   * @param {string} [reason]
   * @returns {void}
   */
  abort(reason) {
    this._fail(new MavlinkError('COMMAND_ABORTED', reason || 'Command workflow aborted.'));
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
    const message = { name, fields };
    if (this.vehicleProfile != null) {
      message.vehicleProfile = this.vehicleProfile;
    }
    if (this.localIdentity != null) {
      message.localIdentity = this.localIdentity;
    }
    /**
     * Priority band from the shared policy (#241): arm/disarm, mode change,
     * flight termination, and parachute ride the CRITICAL band so they can't
     * sit behind a backlog of routine traffic; everything else rides NORMAL.
     * `this.command` was resolved to its numeric id in the constructor, so
     * this is an exact id match, never a guess. Retransmits keep the band.
     */
    this.connection
      .send(message, { priority: commandPriority(this.command) })
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
      if (this._inProgress) {
        /**
         * After IN_PROGRESS the command protocol says to extend the wait and
         * never retransmit. Keep re-arming until a terminal ack arrives, but
         * give up after `maxRetries` consecutive silent windows so a vehicle
         * that stops reporting still fails cleanly (#144).
         */
        if (this._inProgressWaits >= this.maxRetries) {
          this._fail(
            new MavlinkError(
              'COMMAND_TIMEOUT',
              `No further COMMAND_ACK after IN_PROGRESS for command ${this._commandLabel()} in state '${this.state}'.`,
              {
                command: this.command,
                command_name: this._commandName(),
                target_system: this.targetSystem,
                target_component: this.targetComponent,
                state: this.state
              }
            )
          );
          return;
        }
        this._inProgressWaits += 1;
        this._armTimeout();
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
    if (!this._addressedToUs(f)) {
      return; // ack for the same command but addressed to another GCS (#99)
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
      /**
       * The vehicle is working on it; progress (0-100) rides in f.progress.
       * Latch in-progress so timeout expiry extends the wait instead of
       * retransmitting (a retry would restart the operation, #144), and reset
       * the silence budget since this fresh progress proves the vehicle is
       * still alive.
       */
      this.state = COMMAND_STATES.IN_PROGRESS;
      this._inProgress = true;
      this._inProgressWaits = 0;
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

  /**
   * True if a COMMAND_ACK is addressed to this GCS (or is broadcast/older
   * variant without the addressing fields). COMMAND_ACK's target_system/
   * target_component are extension fields naming the intended GCS; on a shared
   * link a second GCS issuing the same command to the same vehicle would
   * otherwise settle this workflow with the vehicle's reply to it (#99).
   * Absent fields, an unknown own-identity, or 0 (broadcast) all pass, matching
   * the permissive mission-protocol precedent for older MAVLink variants.
   *
   * @param {object} f  decoded COMMAND_ACK fields
   * @returns {boolean}
   */
  _addressedToUs(f) {
    if (this.sourceSystem != null && f.target_system !== undefined) {
      const ts = Number(f.target_system);
      if (ts !== 0 && ts !== this.sourceSystem) {
        return false;
      }
    }
    if (this.sourceComponent != null && f.target_component !== undefined) {
      const tc = Number(f.target_component);
      if (tc !== 0 && tc !== this.sourceComponent) {
        return false;
      }
    }
    return true;
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
    if (this._lock) {
      const lock = this._lock;
      this._lock = null;
      lock.release();
    }
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
  MAV_RESULT_ACCEPTED,
  MAV_RESULT_IN_PROGRESS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  CommandSend
};
