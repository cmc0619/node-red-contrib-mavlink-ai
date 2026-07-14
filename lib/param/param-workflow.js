'use strict';

const { MavlinkError } = require('../util/errors');
const enumResolver = require('../protocol/enum-resolver');

/**
 * PARAM protocol workflows (DESIGN.md §13, planner #8).
 *
 *   read   -> PARAM_REQUEST_READ  -> PARAM_VALUE
 *   set    -> PARAM_SET           -> PARAM_VALUE (echo)
 *   list   -> PARAM_REQUEST_LIST  -> PARAM_VALUE * param_count
 *
 * Like the mission protocol, PARAM handling is stateful and timeout-driven, so
 * it lives behind an explicit workflow instead of being smeared across the
 * transport or the node. Building/sending stays in the connection; these
 * workflows only orchestrate the request/response exchange and assemble the
 * result.
 */

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RETRIES = 3;

// PARAM_VALUE.param_index sentinel for "not part of a list read" (uint16 -1).
// Stacks emit it for unsolicited value notifications; it is never a real index.
const PARAM_INDEX_NONE = 65535;

// MAV_PARAM_TYPE values for the fixed-width integer types that fit the 4-byte
// param-value union, mapped to their DataView accessor suffix. The 64-bit
// types (7/8) cannot ride the classic PARAM protocol and are left untouched.
const INT_PARAM_TYPES = new Map([
  [1, 'Uint8'],
  [2, 'Int8'],
  [3, 'Uint16'],
  [4, 'Int16'],
  [5, 'Uint32'],
  [6, 'Int32']
]);

const _union = new DataView(new ArrayBuffer(4));

/**
 * True if a MAV_PARAM_TYPE number is an integer type that uses the byte-union
 * convention on PX4.
 *
 * @param {number} typeNum
 * @returns {boolean}
 */
function isIntParamType(typeNum) {
  return INT_PARAM_TYPES.has(typeNum);
}

/**
 * PX4 byte-union decode: reinterpret the raw bytes of a wire float32
 * param_value as the integer of the given MAV_PARAM_TYPE. PX4 (without the
 * C-cast capability) packs integer params into the union byte-wise, so an
 * INT32 value of 1 arrives as the float 1.4e-45 — reading it as a float is
 * garbage; reading its bytes as the declared type recovers the real value.
 *
 * @param {number} floatValue  wire param_value
 * @param {number} typeNum     MAV_PARAM_TYPE number
 * @returns {number}
 */
function unionFloatToInt(floatValue, typeNum) {
  const kind = INT_PARAM_TYPES.get(typeNum);
  if (!kind) {
    return floatValue;
  }
  _union.setFloat32(0, floatValue, true);
  return _union[`get${kind}`](0, true);
}

/**
 * PX4 byte-union encode: pack an integer into the 4-byte union and read it
 * back as the float32 to place in PARAM_SET.param_value.
 *
 * @param {number} intValue  integer parameter value
 * @param {number} typeNum   MAV_PARAM_TYPE number
 * @returns {number}
 */
function unionIntToFloat(intValue, typeNum) {
  const kind = INT_PARAM_TYPES.get(typeNum);
  if (!kind) {
    return intValue;
  }
  _union.setUint32(0, 0, true);
  _union[`set${kind}`](0, intValue, true);
  return _union.getFloat32(0, true);
}

const PARAM_STATES = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  RECEIVING: 'receiving',
  COMPLETE: 'complete',
  FAILED: 'failed'
};

/**
 * Trim a decoded PARAM_VALUE.param_id to a clean string. The wire field is a
 * fixed 16-byte char array, so a short id comes back NUL-padded.
 *
 * @param {*} raw
 * @returns {string}
 */
function trimParamId(raw) {
  if (raw == null) {
    return '';
  }
  return String(raw).split('\u0000')[0].trim();
}

/**
 * Project a decoded PARAM_VALUE fields object into the compact param shape used
 * in workflow results. Adds the readable MAV_PARAM_TYPE name when the dialect
 * enum index is available.
 *
 * @param {object} fields  decoded §14.1 PARAM_VALUE fields
 * @param {object} [enums]  dialect enum index (for MAV_PARAM_TYPE name)
 * @param {object} [opts]
 * @param {string} [opts.firmware]  profile firmware; 'px4' enables byte-union
 *   decoding of integer-typed values
 * @returns {object}
 */
function projectParam(fields, enums, opts = {}) {
  const typeNum = Number(fields.param_type);
  const out = {
    param_id: trimParamId(fields.param_id),
    param_value: fields.param_value,
    param_type: typeNum,
    param_index: Number(fields.param_index),
    param_count: Number(fields.param_count)
  };
  if (opts.firmware === 'px4' && isIntParamType(typeNum)) {
    // PX4 byte-union convention: the wire float's bytes carry the integer.
    out.param_value = unionFloatToInt(Number(fields.param_value), typeNum);
    out.param_raw_value = fields.param_value;
  }
  if (enums) {
    const name = enumResolver.nameFor(enums, 'MavParamType', typeNum);
    if (name) {
      out.param_type_name = name;
    }
  }
  return out;
}

/**
 * Base workflow: owns the PARAM_VALUE subscription, a single active timeout,
 * retry counting, progress emission, and settle-once semantics. Subclasses
 * implement the protocol steps.
 */
class ParamWorkflow {
  /**
   * @param {object} opts
   * @param {object} opts.connection            connection runtime API (§12)
   * @param {string|object} [opts.profile]      profile reference (config-node
   *   id) carried on every send so the connection encodes with the workflow's
   *   profile, not its default
   * @param {number} opts.targetSystem
   * @param {number} opts.targetComponent
   * @param {object} [opts.enums]               dialect enum index
   * @param {string} [opts.firmware]            profile firmware ('px4' enables
   *   byte-union integer param encoding/decoding)
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries]
   * @param {function(object): void} [opts.onProgress]
   */
  constructor(opts = {}) {
    this.connection = opts.connection;
    this.profile = opts.profile == null || opts.profile === '' ? null : opts.profile;
    this.targetSystem = Number(opts.targetSystem);
    this.targetComponent = Number(opts.targetComponent);
    this.enums = opts.enums || null;
    this.firmware = opts.firmware || 'generic';
    // Clamp timeout/retries so bad input can't disable the retry ceiling
    // (NaN >= n is always false, which would retry forever).
    const timeoutMs = Number(opts.timeoutMs == null ? DEFAULT_TIMEOUT_MS : opts.timeoutMs);
    const maxRetries = Number(opts.maxRetries == null ? DEFAULT_MAX_RETRIES : opts.maxRetries);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.trunc(maxRetries) : DEFAULT_MAX_RETRIES;
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

    this.state = PARAM_STATES.IDLE;
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
   * @returns {Promise<object>} resolves with the result message, rejects with a
   *   {@link MavlinkError}
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
   * Emit a `param/progress` event for the current state plus extra fields.
   *
   * @param {object} extra  e.g. { received, count }
   * @returns {void}
   */
  _progress(extra) {
    this.onProgress({
      topic: 'param/progress',
      payload: Object.assign({ state: this.state }, extra)
    });
  }

  /**
   * Subscribe to PARAM_VALUE from the target system and track the id for
   * teardown. The workflow filters by source sysid; component is checked in the
   * handler so a broadcast component id still matches.
   *
   * @param {function(object): void} onValue  invoked with each PARAM_VALUE payload
   * @returns {void}
   */
  _subscribeValues(onValue) {
    const id = this.connection.subscribe(
      { messageNames: ['PARAM_VALUE'], sysid: this.targetSystem },
      (msg) => onValue(msg.payload)
    );
    this._subs.push(id);
  }

  /**
   * True if a decoded packet came from the vehicle this workflow addresses.
   *
   * @param {object} payload  decoded §14.1 payload
   * @returns {boolean}
   */
  _matchesTarget(payload) {
    return Number(payload.sysid) === this.targetSystem;
  }

  /**
   * True if a decoded PARAM_VALUE came from the component this workflow
   * addresses (#67). A specific target component must be answered by that
   * component: on a system with several parameter-bearing components (autopilot
   * plus a gimbal/companion) a PARAM_VALUE from the wrong one that happens to
   * carry the same param_id must not settle the workflow. A broadcast target
   * component (0) or an unknown one accepts any responder, as does a packet
   * with no readable compid.
   *
   * @param {object} payload  decoded §14.1 payload
   * @returns {boolean}
   */
  _matchesComponent(payload) {
    if (!Number.isFinite(this.targetComponent) || this.targetComponent === 0) {
      return true;
    }
    const compid = Number(payload.compid);
    return !Number.isFinite(compid) || compid === this.targetComponent;
  }

  /**
   * Send a PARAM-protocol message with the workflow's target pre-filled.
   *
   * @param {string} name  MAVLink message name
   * @param {object} [fields]
   * @returns {Promise<void>}
   */
  _send(name, fields) {
    const message = {
      name,
      fields: Object.assign(
        { target_system: this.targetSystem, target_component: this.targetComponent },
        fields
      )
    };
    if (this.profile != null) {
      message.profile = this.profile;
    }
    return this.connection.send(message);
  }

  /**
   * Arm a single response timeout. On expiry, retry `onTimeout` up to
   * `maxRetries` times, then fail with `PARAM_TIMEOUT`.
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
          new MavlinkError('PARAM_TIMEOUT', `PARAM ${this.constructor.name} timed out in state '${this.state}'.`, {
            target_system: this.targetSystem,
            target_component: this.targetComponent,
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
    this._setState(PARAM_STATES.COMPLETE);
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
    this._setState(PARAM_STATES.FAILED);
    this._cleanup();
    this._reject(err instanceof MavlinkError ? err : new MavlinkError('PARAM_FAILED', err.message));
  }

  /**
   * Abort the workflow with a `PARAM_ABORTED` error.
   *
   * @param {string} [reason]
   * @returns {void}
   */
  abort(reason) {
    this._fail(new MavlinkError('PARAM_ABORTED', reason || 'PARAM workflow aborted.'));
  }
}

/**
 * Read a single parameter by name (`paramId`) or by index (`paramIndex`).
 * Resolves with `{ topic: 'param/value', payload: <param> }`.
 */
class ParamRead extends ParamWorkflow {
  /**
   * @param {object} opts  ParamWorkflow opts plus one of:
   * @param {string} [opts.paramId]     read by name (param_index sent as -1)
   * @param {number} [opts.paramIndex]  read by index
   */
  constructor(opts = {}) {
    super(opts);
    // Param ids are conventionally uppercase on the vehicle; normalize so a
    // lowercase-typed id still matches the echoed PARAM_VALUE.param_id.
    this.paramId = opts.paramId != null ? String(opts.paramId).trim().toUpperCase() : '';
    this.paramIndex = opts.paramIndex == null ? null : Number(opts.paramIndex);
    if (!this.paramId && this.paramIndex == null) {
      throw new MavlinkError('BAD_PARAM_READ', 'Param read requires a param_id or param_index.');
    }
  }

  /** @returns {void} */
  _start() {
    this._subscribeValues((payload) => this._onValue(payload));
    this._request();
  }

  /** @returns {void} */
  _request() {
    this._setState(PARAM_STATES.REQUESTING);
    this._progress({ param_id: this.paramId || undefined, param_index: this.paramIndex });
    // Read by name uses param_index -1; read by index leaves the id blank.
    this._send('PARAM_REQUEST_READ', {
      param_id: this.paramId,
      param_index: this.paramIndex == null ? -1 : this.paramIndex
    })
      .then(() => this._armTimeout(() => this._request()))
      .catch((err) => this._fail(err));
  }

  /**
   * @param {object} payload  decoded PARAM_VALUE payload
   * @returns {void}
   */
  _onValue(payload) {
    if (!this._matchesTarget(payload) || !this._matchesComponent(payload)) {
      return;
    }
    const f = payload.fields;
    const matches =
      this.paramIndex != null
        ? Number(f.param_index) === this.paramIndex
        : trimParamId(f.param_id).toUpperCase() === this.paramId;
    if (!matches) {
      return;
    }
    this._complete({ topic: 'param/value', payload: projectParam(f, this.enums, { firmware: this.firmware }) });
  }
}

/**
 * Set a single parameter and confirm via the echoed PARAM_VALUE.
 * Resolves with `{ topic: 'param/set', payload: <param + requested> }`.
 */
class ParamSet extends ParamWorkflow {
  /**
   * @param {object} opts  ParamWorkflow opts plus:
   * @param {string} opts.paramId
   * @param {number} opts.value                 new value
   * @param {string|number} [opts.paramType]    MAV_PARAM_TYPE (default REAL32)
   */
  constructor(opts = {}) {
    super(opts);
    // Param ids are conventionally uppercase on the vehicle; normalize so a
    // lowercase-typed id still matches the echoed PARAM_VALUE.param_id.
    this.paramId = opts.paramId != null ? String(opts.paramId).trim().toUpperCase() : '';
    if (!this.paramId) {
      throw new MavlinkError('BAD_PARAM_SET', 'Param set requires a param_id.');
    }
    if (opts.value == null || !Number.isFinite(Number(opts.value))) {
      throw new MavlinkError('BAD_PARAM_SET', `Param set requires a numeric value (got '${opts.value}').`);
    }
    this.value = Number(opts.value);
    // Connection.send resolves enum-name strings, so a name or number both work.
    this.paramType = opts.paramType == null ? 'MAV_PARAM_TYPE_REAL32' : opts.paramType;
  }

  /**
   * Resolve the configured param type to its MAV_PARAM_TYPE number, or null
   * when it cannot be resolved (no enum index and a non-numeric name).
   *
   * @returns {?number}
   */
  _paramTypeNum() {
    if (typeof this.paramType === 'number') {
      return this.paramType;
    }
    const resolved = this.enums ? enumResolver.lookup(this.enums, String(this.paramType)) : undefined;
    if (resolved !== undefined) {
      return resolved;
    }
    const n = Number(this.paramType);
    return Number.isFinite(n) ? n : null;
  }

  /** @returns {void} */
  _start() {
    this._subscribeValues((payload) => this._onValue(payload));
    this._request();
  }

  /** @returns {void} */
  _request() {
    this._setState(PARAM_STATES.REQUESTING);
    this._progress({ param_id: this.paramId, param_value: this.value });
    const typeNum = this._paramTypeNum();
    // PX4 byte-union: integer params travel as their bytes reinterpreted as
    // float32, not as a numeric cast.
    const wireValue =
      this.firmware === 'px4' && typeNum != null && isIntParamType(typeNum)
        ? unionIntToFloat(this.value, typeNum)
        : this.value;
    this._send('PARAM_SET', {
      param_id: this.paramId,
      param_value: wireValue,
      param_type: this.paramType
    })
      .then(() => this._armTimeout(() => this._request()))
      .catch((err) => this._fail(err));
  }

  /**
   * @param {object} payload  decoded PARAM_VALUE payload
   * @returns {void}
   */
  _onValue(payload) {
    if (!this._matchesTarget(payload) || !this._matchesComponent(payload)) {
      return;
    }
    const f = payload.fields;
    if (trimParamId(f.param_id).toUpperCase() !== this.paramId) {
      return;
    }
    const param = projectParam(f, this.enums, { firmware: this.firmware });
    const typeNum = Number(f.param_type);
    // The wire value is float32, so compare at float32 precision — a float64
    // request of 0.1 legitimately echoes back as fround(0.1). Byte-union
    // integers are exact and must not be squeezed through fround (it loses
    // precision above 2^24).
    const applied =
      this.firmware === 'px4' && isIntParamType(typeNum)
        ? param.param_value === this.value
        : Math.fround(param.param_value) === Math.fround(this.value);
    // The vehicle may clamp/round the value; report what it actually stored plus
    // whether it matched the request so a flow can react to a rejected write.
    this._complete({
      topic: 'param/set',
      payload: Object.assign({ requested_value: this.value, applied }, param)
    });
  }
}

/**
 * Request the full parameter list and assemble it. Resolves with
 * `{ topic: 'param/list', payload: { count, params: [...] } }`.
 *
 * PARAM_VALUE messages stream back with `param_count` and per-item
 * `param_index`. Dropped items are re-requested individually (by index) once
 * the stream stalls, so a lossy link still completes. The retry counter resets
 * whenever a new item arrives, so a long list isn't cut short by the per-stall
 * ceiling.
 */
class ParamList extends ParamWorkflow {
  /** @returns {void} */
  _start() {
    this.count = null;
    this.received = new Map(); // param_index -> projected param
    this._subscribeValues((payload) => this._onValue(payload));
    this._requestList();
  }

  /** @returns {void} */
  _requestList() {
    this._setState(PARAM_STATES.REQUESTING);
    this._progress({ received: this.received.size, count: this.count });
    this._send('PARAM_REQUEST_LIST', {})
      .then(() => this._armTimeout(() => this._onStall()))
      .catch((err) => this._fail(err));
  }

  /**
   * Re-request a single missing parameter by index (gap refill on a lossy link).
   *
   * @param {number} index
   * @returns {void}
   */
  _requestIndex(index) {
    this._setState(PARAM_STATES.RECEIVING);
    this._send('PARAM_REQUEST_READ', { param_id: '', param_index: index })
      .then(() => this._armTimeout(() => this._onStall()))
      .catch((err) => this._fail(err));
  }

  /**
   * Timeout handler: if the count is still unknown re-request the whole list;
   * otherwise re-request the first missing index.
   *
   * @returns {void}
   */
  _onStall() {
    if (this.count == null) {
      this._requestList();
      return;
    }
    const missing = this._firstMissingIndex();
    if (missing == null) {
      this._finish();
      return;
    }
    this._requestIndex(missing);
  }

  /**
   * @returns {?number} the lowest not-yet-received index, or null if complete
   */
  _firstMissingIndex() {
    for (let i = 0; i < this.count; i += 1) {
      if (!this.received.has(i)) {
        return i;
      }
    }
    return null;
  }

  /**
   * @param {object} payload  decoded PARAM_VALUE payload
   * @returns {void}
   */
  _onValue(payload) {
    if (!this._matchesTarget(payload) || !this._matchesComponent(payload)) {
      return;
    }
    const f = payload.fields;
    const index = Number(f.param_index);
    // Unsolicited PARAM_VALUE notifications carry the "no index" sentinel.
    // Counting one toward completeness would let received.size reach count
    // while a real index is still missing, so skip it entirely.
    if (index === PARAM_INDEX_NONE) {
      return;
    }
    const count = Number(f.param_count);
    if (Number.isFinite(count)) {
      this.count = count;
    }
    if (!this.received.has(index)) {
      this.received.set(index, projectParam(f, this.enums, { firmware: this.firmware }));
      this._retries = 0; // progress made; reset the per-stall retry ceiling
      this._setState(PARAM_STATES.RECEIVING);
      this._progress({ received: this.received.size, count: this.count });
    }
    if (this.count != null && this.received.size >= this.count) {
      this._finish();
      return;
    }
    // Keep waiting for the stream; re-arm the stall timer.
    this._armTimeout(() => this._onStall());
  }

  /**
   * Assemble the received params (ordered by index) and resolve.
   *
   * @returns {void}
   */
  _finish() {
    const params = [...this.received.values()].sort((a, b) => a.param_index - b.param_index);
    this._complete({
      topic: 'param/list',
      payload: { count: this.count == null ? params.length : this.count, params }
    });
  }
}

/**
 * Set a parameter whose wire type is detected from the vehicle first: read the
 * current PARAM_VALUE to learn its MAV_PARAM_TYPE, then set with that type. The
 * operator never has to know whether a parameter is INT8/UINT8/REAL32 — which
 * matters on PX4, where an integer param is byte-union encoded and a wrong type
 * writes a garbage value.
 *
 * It composes a {@link ParamRead} and a {@link ParamSet} rather than extending
 * {@link ParamWorkflow}, exposing the same `run()`/`abort()` interface so the
 * node drives and aborts it exactly like the single-shot workflows, under the
 * one lock the node already holds.
 */
class ParamSetAuto {
  /**
   * @param {object} opts  ParamSet opts; `paramType` is ignored (detected here)
   */
  constructor(opts = {}) {
    this._opts = opts;
    this._child = null;
    this._aborted = false;
    this._abortReason = null;
    /**
     * Fail fast on the same preconditions ParamSet enforces, so a bad request
     * errors before the detour read rather than after.
     */
    if (opts.paramId == null || String(opts.paramId).trim() === '') {
      throw new MavlinkError('BAD_PARAM_SET', 'Param set requires a param_id.');
    }
    if (opts.value == null || !Number.isFinite(Number(opts.value))) {
      throw new MavlinkError('BAD_PARAM_SET', `Param set requires a numeric value (got '${opts.value}').`);
    }
  }

  /**
   * @returns {Promise<object>} resolves with the {@link ParamSet} result
   */
  async run() {
    this._throwIfAborted();
    const reader = new ParamRead(Object.assign({}, this._opts, { paramIndex: undefined }));
    this._child = reader;
    const read = await reader.run();
    this._throwIfAborted();
    const typeNum = Number(read.payload && read.payload.param_type);
    if (!Number.isFinite(typeNum)) {
      throw new MavlinkError('PARAM_TYPE_UNKNOWN', `Auto set could not determine the type of '${this._opts.paramId}'.`, {
        param_id: this._opts.paramId
      });
    }
    const setter = new ParamSet(Object.assign({}, this._opts, { paramType: typeNum }));
    this._child = setter;
    this._throwIfAborted();
    return setter.run();
  }

  /**
   * Abort the in-flight child workflow (and any not yet started).
   *
   * @param {string} [reason]
   * @returns {void}
   */
  abort(reason) {
    this._aborted = true;
    this._abortReason = reason || 'PARAM workflow aborted.';
    if (this._child) {
      this._child.abort(this._abortReason);
    }
  }

  /** @returns {void} */
  _throwIfAborted() {
    if (this._aborted) {
      throw new MavlinkError('PARAM_ABORTED', this._abortReason);
    }
  }
}

module.exports = {
  PARAM_STATES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  PARAM_INDEX_NONE,
  isIntParamType,
  unionFloatToInt,
  unionIntToFloat,
  trimParamId,
  projectParam,
  ParamWorkflow,
  ParamRead,
  ParamSet,
  ParamSetAuto,
  ParamList
};
