'use strict';

/**
 * MAVLink degE7 wire scaling. Latitude/longitude travel as int32 degrees×1e7
 * on the wire (MISSION_ITEM_INT, GLOBAL_POSITION_INT, SET_POSITION_TARGET_
 * GLOBAL_INT, COMMAND_INT); flows and editors speak float degrees. These are
 * the ONLY two conversions between the domains — every producer/consumer
 * calls them by name so the direction and the round-vs-truncate choice are
 * never re-derived inline (a `* 1e7` next to a `/ 1e7` is exactly where a
 * silent unit bug starts).
 *
 * Deliberately pure — no coercion, no finite guard. Each call site owns its
 * input policy and it differs by domain: RX paths (mission download, vehicle
 * registry) must let a malformed field surface as NaN rather than throw
 * inside a subscription callback; operator-input paths validate first
 * (fanout's validateLatitude / coordinate-frames' finite()); the Move
 * setpoint maps blank to 0 by contract. Passing an unguarded value through
 * these helpers preserves exactly what the inline arithmetic did.
 */

/**
 * Float degrees -> degE7 int32 (rounded, matching pymavlink/QGC behaviour).
 *
 * @param {number} deg
 * @returns {number}
 */
function degToDegE7(deg) {
  return Math.round(deg * 1e7);
}

/**
 * degE7 int32 -> float degrees.
 *
 * @param {number} degE7
 * @returns {number}
 */
function degE7ToDeg(degE7) {
  return degE7 / 1e7;
}

module.exports = { degToDegE7, degE7ToDeg };
