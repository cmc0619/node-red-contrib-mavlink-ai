'use strict';

const { MavlinkError } = require('../util/errors');

/**
 * Shared mission-protocol scaffolding (DESIGN.md §24). Mission handling is
 * stateful, timeout-driven, and easy to make awful, so it lives here behind an
 * explicit state machine instead of being smeared across the transport layer.
 */

const DOWNLOAD_STATES = {
  IDLE: 'idle',
  REQUEST_LIST_SENT: 'request_list_sent',
  WAITING_COUNT: 'waiting_count',
  REQUESTING_ITEM: 'requesting_item',
  WAITING_ITEM: 'waiting_item',
  ASSEMBLING: 'assembling',
  SENDING_ACK: 'sending_ack',
  COMPLETE: 'complete',
  FAILED: 'failed'
};

const UPLOAD_STATES = {
  IDLE: 'idle',
  COUNT_SENT: 'count_sent',
  WAITING_REQUEST: 'waiting_request',
  SENDING_ITEM: 'sending_item',
  WAITING_ACK: 'waiting_ack',
  COMPLETE: 'complete',
  FAILED: 'failed'
};

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RETRIES = 3;

const MISSION_TYPE_NAMES = {
  mission: 0,
  fence: 1,
  rally: 2,
  all: 255
};

/**
 * Resolve a mission type to its numeric MAV_MISSION_TYPE value. Accepts the
 * short profile names (mission/fence/rally/all), the MAV_MISSION_TYPE_* enum
 * name, or a number.
 */
function missionTypeToNumber(value, enums) {
  if (typeof value === 'number') {
    return value;
  }
  if (value == null) {
    return 0;
  }
  const s = String(value).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MISSION_TYPE_NAMES, s)) {
    return MISSION_TYPE_NAMES[s];
  }
  if (enums) {
    const resolved = enums.byFullName.get(String(value).trim().toUpperCase());
    if (resolved !== undefined) {
      return resolved;
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Base workflow: owns subscriptions, a single active timeout, retry counting,
 * and progress emission. Subclasses implement the protocol steps.
 */
class MissionWorkflow {
  constructor(opts = {}) {
    this.connection = opts.connection;
    this.targetSystem = Number(opts.targetSystem);
    this.targetComponent = Number(opts.targetComponent);
    this.missionTypeName = opts.missionType;
    this.missionType = missionTypeToNumber(opts.missionType, opts.enums);
    this.useInt = opts.useInt !== false; // prefer *_INT messages
    this.timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.maxRetries = Number(opts.maxRetries == null ? DEFAULT_MAX_RETRIES : opts.maxRetries);
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

    this.state = 'idle';
    this._subs = [];
    this._timer = null;
    this._retries = 0;
    this._settled = false;
    this._resolve = null;
    this._reject = null;
  }

  run() {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      try {
        this._start();
      } catch (err) {
        this._fail(err);
      }
    });
  }

  // --- subclass hooks -------------------------------------------------------
  _start() {
    throw new Error('not implemented');
  }

  // --- helpers --------------------------------------------------------------
  _setState(state) {
    this.state = state;
  }

  _progress(extra) {
    this.onProgress({
      topic: 'mission/progress',
      payload: Object.assign({ state: this.state, mission_type: this.missionTypeName }, extra)
    });
  }

  _subscribe(filter, cb) {
    const id = this.connection.subscribe(filter, cb);
    this._subs.push(id);
    return id;
  }

  _matchesTarget(payload) {
    // Inbound packets come *from* the vehicle, so its sysid/compid is the
    // mission target we addressed.
    return Number(payload.sysid) === this.targetSystem;
  }

  _send(name, fields) {
    return this.connection.send({
      name,
      fields: Object.assign(
        {
          target_system: this.targetSystem,
          target_component: this.targetComponent,
          mission_type: this.missionType
        },
        fields
      )
    });
  }

  _armTimeout(onTimeout) {
    this._clearTimeout();
    this._timer = setTimeout(() => {
      if (this._settled) {
        return;
      }
      if (this._retries >= this.maxRetries) {
        this._fail(
          new MavlinkError('MISSION_TIMEOUT', `Mission ${this.constructor.name} timed out in state '${this.state}'.`, {
            target_system: this.targetSystem,
            target_component: this.targetComponent,
            mission_type: this.missionTypeName,
            state: this.state
          })
        );
        return;
      }
      this._retries += 1;
      try {
        onTimeout();
      } catch (err) {
        this._fail(err);
      }
    }, this.timeoutMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  _clearTimeout() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _cleanup() {
    this._clearTimeout();
    for (const id of this._subs) {
      this.connection.unsubscribe(id);
    }
    this._subs = [];
  }

  _complete(result) {
    if (this._settled) {
      return;
    }
    this._settled = true;
    this._setState('complete');
    this._cleanup();
    this._resolve(result);
  }

  _fail(err) {
    if (this._settled) {
      return;
    }
    this._settled = true;
    this._setState('failed');
    this._cleanup();
    this._reject(err instanceof MavlinkError ? err : new MavlinkError('MISSION_FAILED', err.message));
  }

  abort(reason) {
    this._fail(new MavlinkError('MISSION_ABORTED', reason || 'Mission workflow aborted.'));
  }
}

module.exports = {
  DOWNLOAD_STATES,
  UPLOAD_STATES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  MISSION_TYPE_NAMES,
  missionTypeToNumber,
  MissionWorkflow
};
