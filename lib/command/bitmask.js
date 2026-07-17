'use strict';

/**
 * Unsigned 32-bit bitmask math (#242).
 *
 * MAVLink metadata bitmasks are unsigned uint32_t, but JavaScript's bitwise
 * operators work on SIGNED 32-bit integers — so bit 31 flips a value negative
 * through `|`/`&`, and an "other/unknown bits" residual that includes bit 31
 * renders as a negative number. Every operation here normalizes with `>>> 0`
 * so all 32 bits round-trip exactly.
 *
 * The command editor (nodes/mavlink-ai-command.html) runs in the browser and
 * can't require this module, so it inlines byte-for-byte copies of these
 * helpers; test/unit/bitmask-editor-spec.test.js extracts the editor's copies
 * and runs the same acceptance matrix against both to guard against drift
 * (the transport-fields spec test established this pattern, #103).
 */

/**
 * Parse an operator-entered or flow-stored bitmask value into a uint32, or
 * null when invalid. Accepts a number or a decimal/hex string ('4294967295',
 * '0xFFFFFFFF' — uint32 values are exactly representable in doubles, so no
 * precision is lost). Blank, fractional, negative, non-finite, and > uint32
 * input returns null rather than being silently truncated by a bitwise op.
 *
 * @param {*} v
 * @returns {?number} uint32 or null
 */
function parseBitmaskValue(v) {
  var n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string' && v.trim() !== '') {
    n = Number(v.trim());
  } else {
    return null;
  }
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
}

/**
 * True when a value is a valid uint32 with exactly one bit set — including
 * bit 31, which the signed idiom `(v & (v - 1)) === 0` only handles by
 * accident of two's complement.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isSingleBit(v) {
  var n = parseBitmaskValue(v);
  return n !== null && n > 0 && ((n & (n - 1)) >>> 0) === 0;
}

/**
 * Unsigned OR of a list of flag values.
 *
 * @param {number[]} values
 * @returns {number} uint32
 */
function orBits(values) {
  var acc = 0;
  for (var i = 0; i < values.length; i++) {
    acc = (acc | values[i]) >>> 0;
  }
  return acc;
}

/**
 * True when `mask` has `bit` set, unsigned.
 *
 * @param {number} mask
 * @param {number} bit
 * @returns {boolean}
 */
function hasBit(mask, bit) {
  return ((mask & bit) >>> 0) !== 0;
}

/**
 * The bits of `mask` NOT covered by `known` — the "other/unknown bits"
 * residual, always non-negative even when it includes bit 31.
 *
 * @param {number} mask
 * @param {number} known
 * @returns {number} uint32
 */
function residualBits(mask, known) {
  return (mask & ~known) >>> 0;
}

module.exports = { parseBitmaskValue, isSingleBit, orBits, hasBit, residualBits };
