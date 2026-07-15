'use strict';

/**
 * Reversible JSON representation for the non-finite IEEE-754 float values
 * (`NaN`, `+Infinity`, `-Infinity`) that MAVLink `float`/`double` fields carry
 * legitimately — NaN is the protocol's "ignore this value" sentinel on setpoint,
 * gimbal-rate and many other fields (DESIGN.md §14.1).
 *
 * JavaScript's `JSON.stringify` maps every non-finite number to `null`, which
 * both loses the value (a NaN sentinel becomes indistinguishable from an
 * intentional null) and collapses NaN/Infinity/-Infinity to one token so
 * changed-only filtering can't see a NaN→Infinity transition. Mirroring the
 * 64-bit decimal-string convention, the public decoded payload represents these
 * as the strings "NaN" / "Infinity" / "-Infinity", and the outbound builder
 * accepts the same strings back on float fields so the round-trip is lossless.
 */

/**
 * The canonical string for a non-finite number. The caller guarantees the value
 * is a number that is not finite (NaN or ±Infinity).
 *
 * @param {number} n  a non-finite number
 * @returns {string} "NaN" | "Infinity" | "-Infinity"
 */
function nonFiniteFloatToString(n) {
  if (Number.isNaN(n)) {
    return 'NaN';
  }
  return n > 0 ? 'Infinity' : '-Infinity';
}

/**
 * Parse a float sentinel string back to its non-finite number, or return
 * undefined for anything that is not one of the recognized tokens. The token set
 * is deliberately a tight whitelist (case-insensitive, with the common `inf`
 * abbreviation and an optional leading `+`) so an arbitrary typo can never turn
 * into a silent NaN — only an explicit sentinel does.
 *
 * @param {string} value  a trimmed candidate string
 * @returns {number|undefined} NaN | Infinity | -Infinity, or undefined
 */
function parseFloatSentinel(value) {
  if (/^nan$/i.test(value)) {
    return NaN;
  }
  if (/^\+?(infinity|inf)$/i.test(value)) {
    return Infinity;
  }
  if (/^-(infinity|inf)$/i.test(value)) {
    return -Infinity;
  }
  return undefined;
}

module.exports = { nonFiniteFloatToString, parseFloatSentinel };
