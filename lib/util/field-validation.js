'use strict';

const { MavlinkError } = require('./errors');

/**
 * Workflow-level field validation (issue #55).
 *
 * The low-level encoder (lib/protocol/message-validator + the normalizer) stays
 * deliberately permissive: MAVLink zero-fills absent fields, so under-specified
 * messages are valid wire traffic. That flexibility is right for the raw/advanced
 * builder (mavlink-ai-build), but it lets user-facing action nodes send commands
 * with out-of-range or nonsensical values that only fail later — or worse, encode
 * as "valid" MAVLink with unsafe defaults.
 *
 * These reusable helpers add stricter, structured checks for the high-risk
 * user-facing paths (command presets, mission upload items, fan-out coordinate
 * targets). They throw a {@link MavlinkError} with code `INVALID_FIELD` and a
 * context carrying the field name, the offending value, and the expected
 * range/type, so nodes can surface an actionable `mavlink/error` instead of an
 * opaque serialization failure. Raw/advanced builders simply don't call them.
 */

const CODE = 'INVALID_FIELD';

/**
 * Coerce to a number without the loose `Number('')===0` / `Number(null)===0`
 * traps: only numbers and non-empty numeric strings convert; everything else is
 * NaN.
 *
 * @param {*} value
 * @returns {number}
 */
function toNumberStrict(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return NaN;
}

/**
 * @param {string} field
 * @param {*} value
 * @param {string} expected  human-readable expectation
 * @param {object} [ctx]     extra error context (e.g. { seq, sysid })
 * @returns {MavlinkError}
 */
function invalid(field, value, expected, ctx) {
  return new MavlinkError(CODE, `'${field}' ${expected} (got ${JSON.stringify(value)}).`, Object.assign({
    field,
    value,
    expected
  }, ctx));
}

/**
 * Require a finite number, returning the coerced value.
 *
 * @param {*} value
 * @param {string} field
 * @param {object} [ctx]
 * @returns {number}
 * @throws {MavlinkError} INVALID_FIELD
 */
function requireFinite(value, field, ctx) {
  const n = toNumberStrict(value);
  if (!Number.isFinite(n)) {
    throw invalid(field, value, 'must be a finite number', ctx);
  }
  return n;
}

/**
 * Require a finite number within [min, max].
 *
 * @param {*} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {object} [ctx]
 * @returns {number}
 * @throws {MavlinkError} INVALID_FIELD
 */
function requireRange(value, field, min, max, ctx) {
  const n = requireFinite(value, field, ctx);
  if (n < min || n > max) {
    throw invalid(field, n, `must be between ${min} and ${max}`, ctx);
  }
  return n;
}

/**
 * Require an integer within [min, max].
 *
 * @param {*} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {object} [ctx]
 * @returns {number}
 * @throws {MavlinkError} INVALID_FIELD
 */
function requireIntRange(value, field, min, max, ctx) {
  const n = requireRange(value, field, min, max, ctx);
  if (!Number.isInteger(n)) {
    throw invalid(field, n, 'must be an integer', ctx);
  }
  return n;
}

/**
 * Validate a MAVLink target system id (0 = broadcast, 1..255 a system).
 *
 * @param {*} value
 * @param {object} [ctx]
 * @returns {number}
 */
function validateTargetSystem(value, ctx) {
  return requireIntRange(value, 'target_system', 0, 255, ctx);
}

/**
 * Validate a MAVLink target component id (0 = broadcast, up to 255).
 *
 * @param {*} value
 * @param {object} [ctx]
 * @returns {number}
 */
function validateTargetComponent(value, ctx) {
  return requireIntRange(value, 'target_component', 0, 255, ctx);
}

/**
 * Validate a latitude in float degrees (-90..90).
 *
 * @param {*} value
 * @param {object} [ctx]
 * @param {string} [field='lat']
 * @returns {number}
 */
function validateLatitude(value, ctx, field = 'lat') {
  return requireRange(value, field, -90, 90, ctx);
}

/**
 * Validate a longitude in float degrees (-180..180).
 *
 * @param {*} value
 * @param {object} [ctx]
 * @param {string} [field='lon']
 * @returns {number}
 */
function validateLongitude(value, ctx, field = 'lon') {
  return requireRange(value, field, -180, 180, ctx);
}

module.exports = {
  requireFinite,
  requireRange,
  requireIntRange,
  validateTargetSystem,
  validateTargetComponent,
  validateLatitude,
  validateLongitude
};
