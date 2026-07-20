'use strict';

/**
 * Editor↔runtime numeric acceptance rules (#210). Each predicate answers one
 * question: would the runtime use this raw field value verbatim, or silently
 * clamp/default it? The node editors mirror these in their `validate:`
 * functions so the edit dialog rejects exactly the values the runtime would
 * quietly replace — the editor stops lying about what the runtime accepts.
 *
 * Blank (empty string / null / undefined) is always acceptable: every field
 * covered here has a runtime default that a blank value falls back to, so the
 * editor must not block an intentionally-empty field.
 *
 * This module is the SOURCE OF TRUTH. The node .html editors run in the
 * browser and cannot `require` it, so each inlines a byte-mirror copy;
 * test/unit/numeric-bounds-editor-spec.test.js extracts every inline copy and
 * asserts it agrees with this module (same drift guard as the transport-field
 * and bitmask editor specs).
 */

/**
 * @param {*} v
 * @returns {boolean} true when v should fall back to the runtime default
 */
function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

/**
 * @param {*} v
 * @returns {boolean} finite and strictly greater than zero (blank allowed)
 */
function acceptsPositive(v) {
  if (isBlank(v)) {
    return true;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/**
 * @param {*} v
 * @returns {boolean} an integer >= 0 (blank allowed; fractional rejected)
 */
function acceptsNonNegativeInteger(v) {
  if (isBlank(v)) {
    return true;
  }
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}

/**
 * @param {*} v
 * @returns {boolean} finite and >= 0 (blank allowed; zero allowed)
 */
function acceptsNonNegative(v) {
  if (isBlank(v)) {
    return true;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

/**
 * @param {number} min
 * @returns {function(*): boolean} finite and >= min (blank allowed)
 */
function acceptsAtLeast(min) {
  return function accepts(v) {
    if (isBlank(v)) {
      return true;
    }
    const n = Number(v);
    return Number.isFinite(n) && n >= min;
  };
}

/**
 * @param {number} min
 * @returns {function(*): boolean} an integer >= min (blank allowed)
 */
function acceptsIntegerAtLeast(min) {
  return function accepts(v) {
    if (isBlank(v)) {
      return true;
    }
    const n = Number(v);
    return Number.isInteger(n) && n >= min;
  };
}

module.exports = {
  isBlank,
  acceptsPositive,
  acceptsNonNegativeInteger,
  acceptsNonNegative,
  acceptsAtLeast,
  acceptsIntegerAtLeast
};
