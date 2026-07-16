'use strict';

const { MavlinkError } = require('../util/errors');
const enumResolver = require('../protocol/enum-resolver');

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

// 10s matches the legacy (aigen) mission timeout and is safe for real
// telemetry links, radios, and high-latency serial — 3s was only comfortable
// on SITL/fast local links (#58). Raise per-node in the editor for very slow
// links; lower it for SITL.
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 3;

const MISSION_TYPE_NAMES = {
  mission: 0,
  fence: 1,
  rally: 2,
  all: 255
};

// MAV_MISSION_RESULT_ACCEPTED.
const MAV_MISSION_ACCEPTED = 0;

// MAV_FRAME values whose x/y carry latitude/longitude (vs local meters):
// GLOBAL, GLOBAL_RELATIVE_ALT, GLOBAL_INT, GLOBAL_RELATIVE_ALT_INT,
// GLOBAL_TERRAIN_ALT, GLOBAL_TERRAIN_ALT_INT. Whether the values are degE7
// int32 or float degrees is decided by the *message* (MISSION_ITEM_INT vs
// MISSION_ITEM), not the frame — the _INT frame variants are deprecated
// aliases and vehicles routinely send MISSION_ITEM_INT with frame 3.
const GLOBAL_FRAMES = new Set([0, 3, 5, 6, 10, 11]);

/**
 * Resolve a mission type to its numeric MAV_MISSION_TYPE value. Accepts the
 * short profile names (mission/fence/rally/all), the MAV_MISSION_TYPE_* enum
 * name, or a number. Unknown non-numeric strings throw rather than silently
 * defaulting to the regular mission, so a typo fails fast.
 *
 * @param {string|number} value
 * @param {object} [enums]  dialect enum index for MAV_MISSION_TYPE_* lookups
 * @returns {number}
 * @throws {MavlinkError} BAD_MISSION_TYPE for unrecognized strings
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
  if (Number.isFinite(n)) {
    return n;
  }
  throw new MavlinkError('BAD_MISSION_TYPE', `Unknown mission type '${value}'.`, { mission_type: value });
}

/**
 * Base workflow: owns subscriptions, a single active timeout, retry counting,
 * and progress emission. Subclasses implement the protocol steps.
 */
class MissionWorkflow {
  constructor(opts = {}) {
    this.connection = opts.connection;
    // Vehicle Profile reference (config-node id) carried on every send so the
    // connection encodes with the workflow's profile, not its default
    // (`opts.profile` is the deprecated alias).
    const vehicleProfile = opts.vehicleProfile != null && opts.vehicleProfile !== '' ? opts.vehicleProfile : opts.profile;
    this.vehicleProfile = vehicleProfile == null || vehicleProfile === '' ? null : vehicleProfile;
    // Explicit Local Identity reference carried on every send when the caller
    // requested one; the connection default applies otherwise (#228).
    this.localIdentity = opts.localIdentity == null || opts.localIdentity === '' ? null : opts.localIdentity;
    this.targetSystem = Number(opts.targetSystem);
    this.targetComponent = Number(opts.targetComponent);
    // Our own identity, used to verify inbound protocol messages are addressed
    // to this GCS and not to another requester talking to the same vehicle.
    this.sourceSystem = opts.sourceSystem == null ? null : Number(opts.sourceSystem);
    this.sourceComponent = opts.sourceComponent == null ? null : Number(opts.sourceComponent);
    this.missionTypeName = opts.missionType;
    this.missionType = missionTypeToNumber(opts.missionType, opts.enums);
    this.enums = opts.enums || null;
    this.useInt = opts.useInt !== false; // prefer *_INT messages
    // Clamp timeout/retries: non-numeric input must not become NaN, which would
    // make `_retries >= maxRetries` never true and retry forever.
    const timeoutMs = Number(opts.timeoutMs == null ? DEFAULT_TIMEOUT_MS : opts.timeoutMs);
    const maxRetries = Number(opts.maxRetries == null ? DEFAULT_MAX_RETRIES : opts.maxRetries);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.trunc(maxRetries) : DEFAULT_MAX_RETRIES;
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

    this.state = 'idle';
    this._subs = [];
    this._timer = null;
    this._retries = 0;
    this._settled = false;
    this._resolve = null;
    this._reject = null;
  }

  /**
   * Run the workflow to completion.
   *
   * @returns {Promise<object>} resolves with the workflow result message, or
   *   rejects with a {@link MavlinkError}
   */
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

  /**
   * Subclass hook: kick off the protocol exchange. Must be implemented.
   *
   * @returns {void}
   */
  _start() {
    throw new Error('not implemented');
  }

  /**
   * Set the current workflow state.
   *
   * @param {string} state
   * @returns {void}
   */
  _setState(state) {
    this.state = state;
  }

  /**
   * Emit a `mission/progress` event for the current state plus extra fields.
   *
   * @param {object} extra  e.g. { seq, count }
   * @returns {void}
   */
  _progress(extra) {
    this.onProgress({
      topic: 'mission/progress',
      payload: Object.assign({ state: this.state, mission_type: this.missionTypeName }, extra)
    });
  }

  /**
   * Subscribe to the connection and track the id for teardown.
   *
   * @param {object} filter
   * @param {function(object): void} cb
   * @returns {number} subscription id
   */
  _subscribe(filter, cb) {
    const id = this.connection.subscribe(filter, cb);
    this._subs.push(id);
    return id;
  }

  /**
   * True if a decoded packet came from the vehicle this workflow is addressing.
   * Inbound packets come *from* the vehicle, so its sysid is our mission target.
   *
   * @param {object} payload  decoded §14.1 payload
   * @returns {boolean}
   */
  _matchesTarget(payload) {
    return Number(payload.sysid) === this.targetSystem;
  }

  /**
   * True if a decoded packet came from the component this workflow addresses.
   * A system may carry several parameter/mission-bearing components (autopilot,
   * companion computer, a camera with its own mission service); without this,
   * mission traffic from a different component on the same system could advance
   * or settle the workflow. Mirrors the param workflow's component guard (#67).
   * A broadcast target (component 0), an unknown target, or an absent responder
   * compid all pass.
   *
   * @param {object} payload  decoded §14.1 payload
   * @returns {boolean}
   */
  _matchesComponent(payload) {
    const comp = Number(payload.compid);
    if (
      this.targetComponent !== 0 &&
      Number.isFinite(this.targetComponent) &&
      Number.isFinite(comp) &&
      comp !== this.targetComponent
    ) {
      return false;
    }
    return true;
  }

  /**
   * True if an inbound protocol message is addressed to us (or broadcast).
   * Mission messages carry target_system/target_component naming the intended
   * recipient; when two requesters talk to the same vehicle concurrently, a
   * response addressed to the other one must not advance our state machine.
   * Absent fields, an unknown own-identity, or 0 (broadcast) all pass.
   *
   * @param {object} payload  decoded §14.1 payload
   * @returns {boolean}
   */
  _addressedToUs(payload) {
    const f = payload.fields || {};
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

  /**
   * True when a response's mission_type matches this workflow's. mission_type
   * is a MAVLink 2 *extension* field: a MAVLink 1 response cannot carry it and
   * decodes as 0 (truncated payloads are zero-filled). For a fence/rally
   * (nonzero mission_type) workflow that silently dropped every response and
   * burned the retries into a bare MISSION_TIMEOUT — detect the v1 case and
   * fail with an actionable error instead.
   *
   * @param {object} payload  decoded §14.1 payload
   * @returns {boolean}
   */
  _matchesMissionType(payload) {
    const got = Number(payload.fields.mission_type);
    if (got === this.missionType) {
      return true;
    }
    if (this.missionType > 0 && got === 0 && payload.raw && Number(payload.raw.magic) === 0xfe) {
      this._fail(
        new MavlinkError(
          'MISSION_TYPE_REQUIRES_MAVLINK2',
          `mission_type '${this.missionTypeName}' requires MAVLink 2 on this link: the vehicle answered with ` +
            'MAVLink 1 frames, which cannot carry a mission_type.',
          { mission_type: this.missionTypeName }
        )
      );
    }
    return false;
  }

  /**
   * Resolve a numeric MAV_MISSION_RESULT to its enum name when the dialect
   * enum index is available (e.g. 13 -> MAV_MISSION_RESULT_INVALID_SEQUENCE).
   *
   * @param {number} result
   * @returns {?string}
   */
  _missionResultName(result) {
    if (!this.enums) {
      return undefined;
    }
    return enumResolver.nameFor(this.enums, 'MavMissionResult', Number(result));
  }

  /**
   * Send a mission-protocol message addressed to the target with the workflow's
   * mission type pre-filled.
   *
   * @param {string} name  MAVLink message name
   * @param {object} [fields]
   * @returns {Promise<void>}
   */
  _send(name, fields) {
    const message = {
      name,
      fields: Object.assign(
        {
          target_system: this.targetSystem,
          target_component: this.targetComponent,
          mission_type: this.missionType
        },
        fields
      )
    };
    if (this.vehicleProfile != null) {
      message.vehicleProfile = this.vehicleProfile;
    }
    if (this.localIdentity != null) {
      message.localIdentity = this.localIdentity;
    }
    return this.connection.send(message);
  }

  /**
   * Arm a single response timeout. On expiry, retry `onTimeout` up to
   * `maxRetries` times, then fail the workflow with `MISSION_TIMEOUT`.
   *
   * @param {function(): void} onTimeout  retransmit action
   * @returns {void}
   */
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

  /**
   * Cancel the active response timeout, if any.
   *
   * @returns {void}
   */
  _clearTimeout() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Clear the timeout and drop all subscriptions made by this workflow.
   *
   * @returns {void}
   */
  _cleanup() {
    this._clearTimeout();
    for (const id of this._subs) {
      this.connection.unsubscribe(id);
    }
    this._subs = [];
  }

  /**
   * Settle the workflow successfully (idempotent).
   *
   * @param {object} result  the result message to resolve with
   * @returns {void}
   */
  _complete(result) {
    if (this._settled) {
      return;
    }
    this._settled = true;
    this._setState('complete');
    this._cleanup();
    this._resolve(result);
  }

  /**
   * Settle the workflow as failed (idempotent), normalizing to a MavlinkError.
   *
   * @param {Error} err
   * @returns {void}
   */
  _fail(err) {
    if (this._settled) {
      return;
    }
    this._settled = true;
    this._setState('failed');
    this._cleanup();
    this._reject(err instanceof MavlinkError ? err : new MavlinkError('MISSION_FAILED', err.message));
  }

  /**
   * Abort the workflow with a `MISSION_ABORTED` error.
   *
   * @param {string} [reason]
   * @returns {void}
   */
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
  MAV_MISSION_ACCEPTED,
  GLOBAL_FRAMES,
  missionTypeToNumber,
  MissionWorkflow
};
