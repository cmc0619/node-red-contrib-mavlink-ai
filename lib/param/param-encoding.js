'use strict';

/**
 * Integer-parameter wire encoding resolution (#233).
 *
 * MAVLink carries every parameter value in a float32 field, and the two major
 * stacks disagree on how an integer parameter rides in it: PX4 reinterprets
 * the integer's bytes as the float (byte-union / BYTEWISE), ArduPilot casts
 * the number (C_CAST). Getting it wrong silently corrupts every integer
 * parameter, so the choice must come from the vehicle itself when it says —
 * AUTOPILOT_VERSION.capabilities advertises exactly this — and fall back to
 * the profile's firmware label only for vehicles that never report.
 */

/** MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE: byte-union integers (PX4 convention). */
const PARAM_ENCODE_BYTEWISE = 0x10n;

/** MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST: numerically cast integers (ArduPilot convention). */
const PARAM_ENCODE_C_CAST = 0x20000n;

/**
 * Decide the integer-parameter encoding for one vehicle.
 *
 * Probed capability bits win over the label; a vehicle that advertises
 * neither encoding bit (or has never reported) resolves from the profile
 * firmware label exactly as before, so non-reporting vehicles keep the
 * documented behavior. A vehicle advertising BOTH bits resolves to bytewise —
 * it accepts either, and the byte-union survives NaN-pattern integers that a
 * float cast canonicalizes.
 *
 * @param {object} opts
 * @param {bigint|number} [opts.capabilities]  AUTOPILOT_VERSION.capabilities
 *   (uint64 decodes as BigInt; numbers accepted for synthetic callers)
 * @param {string} [opts.firmware]  profile firmware label ('px4' implies bytewise)
 * @returns {{encoding: ('bytewise'|'ccast'), source: ('capabilities'|'firmware')}}
 */
function resolveParamEncoding({ capabilities, firmware } = {}) {
  if (capabilities !== undefined && capabilities !== null) {
    let bits = null;
    try {
      bits = BigInt(capabilities);
    } catch {
      /** Unparseable capabilities (corrupt/synthetic) fall back to the label. */
    }
    if (bits !== null) {
      if ((bits & PARAM_ENCODE_BYTEWISE) !== 0n) {
        return { encoding: 'bytewise', source: 'capabilities' };
      }
      if ((bits & PARAM_ENCODE_C_CAST) !== 0n) {
        return { encoding: 'ccast', source: 'capabilities' };
      }
    }
  }
  return { encoding: firmware === 'px4' ? 'bytewise' : 'ccast', source: 'firmware' };
}

module.exports = { resolveParamEncoding, PARAM_ENCODE_BYTEWISE, PARAM_ENCODE_C_CAST };
