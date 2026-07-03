'use strict';

const { MavlinkError } = require('../util/errors');

/**
 * Firmware-aware flight-mode name resolution (issue #20). A mode name like
 * "GUIDED" means custom_mode 4 on ArduCopter but 15 on ArduPlane, and PX4
 * encodes modes as a main/sub bitfield — so mode names can only be resolved
 * against the profile's firmware + vehicle type. This is the first real
 * consumer of the profile's firmware abstraction field.
 *
 * All tables map MODE_NAME -> the value MAV_CMD_DO_SET_MODE expects in param2
 * (custom_mode), with MAV_MODE_FLAG_CUSTOM_MODE_ENABLED (1) as base_mode.
 */

// ArduPilot custom_mode tables per vehicle type (profileType).
const ARDUPILOT_MODES = {
  copter: {
    STABILIZE: 0,
    ACRO: 1,
    ALT_HOLD: 2,
    AUTO: 3,
    GUIDED: 4,
    LOITER: 5,
    RTL: 6,
    CIRCLE: 7,
    LAND: 9,
    DRIFT: 11,
    SPORT: 13,
    FLIP: 14,
    AUTOTUNE: 15,
    POSHOLD: 16,
    BRAKE: 17,
    THROW: 18,
    AVOID_ADSB: 19,
    GUIDED_NOGPS: 20,
    SMART_RTL: 21,
    FLOWHOLD: 22,
    FOLLOW: 23,
    ZIGZAG: 24,
    SYSTEMID: 25,
    AUTOROTATE: 26,
    AUTO_RTL: 27
  },
  plane: {
    MANUAL: 0,
    CIRCLE: 1,
    STABILIZE: 2,
    TRAINING: 3,
    ACRO: 4,
    FBWA: 5,
    FBWB: 6,
    CRUISE: 7,
    AUTOTUNE: 8,
    AUTO: 10,
    RTL: 11,
    LOITER: 12,
    TAKEOFF: 13,
    AVOID_ADSB: 14,
    GUIDED: 15,
    QSTABILIZE: 17,
    QHOVER: 18,
    QLOITER: 19,
    QLAND: 20,
    QRTL: 21,
    QAUTOTUNE: 22,
    QACRO: 23,
    THERMAL: 24,
    LOITER_ALT_QLAND: 25
  },
  rover: {
    MANUAL: 0,
    ACRO: 1,
    STEERING: 3,
    HOLD: 4,
    LOITER: 5,
    FOLLOW: 6,
    SIMPLE: 7,
    DOCK: 8,
    CIRCLE: 9,
    AUTO: 10,
    RTL: 11,
    SMART_RTL: 12,
    GUIDED: 15
  },
  sub: {
    STABILIZE: 0,
    ACRO: 1,
    ALT_HOLD: 2,
    AUTO: 3,
    GUIDED: 4,
    CIRCLE: 7,
    SURFACE: 9,
    POSHOLD: 16,
    MANUAL: 19,
    MOTOR_DETECT: 20
  },
  'antenna-tracker': {
    MANUAL: 0,
    STOP: 1,
    SCAN: 2,
    SERVO_TEST: 3,
    GUIDED: 4,
    AUTO: 10,
    INITIALISING: 16
  }
};
// Boats run the Rover firmware.
ARDUPILOT_MODES.boat = ARDUPILOT_MODES.rover;

// PX4 encodes custom_mode as (main_mode << 16) | (sub_mode << 24).
const PX4_MAIN = {
  MANUAL: 1,
  ALTCTL: 2,
  POSCTL: 3,
  AUTO: 4,
  ACRO: 5,
  OFFBOARD: 6,
  STABILIZED: 7,
  RATTITUDE: 8
};
const PX4_AUTO_SUB = {
  READY: 1,
  TAKEOFF: 2,
  LOITER: 3,
  MISSION: 4,
  RTL: 5,
  LAND: 6,
  FOLLOW_TARGET: 8,
  PRECLAND: 9
};

/** PX4 mode name -> { main, sub } including the common QGC-style aliases. */
const PX4_MODES = {
  MANUAL: { main: PX4_MAIN.MANUAL },
  STABILIZED: { main: PX4_MAIN.STABILIZED },
  ACRO: { main: PX4_MAIN.ACRO },
  RATTITUDE: { main: PX4_MAIN.RATTITUDE },
  ALTCTL: { main: PX4_MAIN.ALTCTL },
  ALTITUDE: { main: PX4_MAIN.ALTCTL },
  POSCTL: { main: PX4_MAIN.POSCTL },
  POSITION: { main: PX4_MAIN.POSCTL },
  OFFBOARD: { main: PX4_MAIN.OFFBOARD },
  TAKEOFF: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.TAKEOFF },
  HOLD: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.LOITER },
  LOITER: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.LOITER },
  MISSION: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.MISSION },
  AUTO: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.MISSION },
  RTL: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.RTL },
  RETURN: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.RTL },
  LAND: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.LAND },
  FOLLOW_TARGET: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.FOLLOW_TARGET },
  PRECLAND: { main: PX4_MAIN.AUTO, sub: PX4_AUTO_SUB.PRECLAND }
};

/**
 * Mode names known for a firmware/vehicle combination (for error messages and
 * editor UIs). Empty when mode names are not supported for the combination.
 *
 * @param {string} firmware  profile firmware ('ardupilot' | 'px4' | ...)
 * @param {string} vehicleType  profile type ('copter' | 'plane' | ...)
 * @returns {string[]}
 */
function knownModes(firmware, vehicleType) {
  if (firmware === 'px4') {
    return Object.keys(PX4_MODES);
  }
  if (firmware === 'ardupilot') {
    const table = ARDUPILOT_MODES[vehicleType];
    return table ? Object.keys(table) : [];
  }
  return [];
}

/**
 * Resolve a flight-mode name to DO_SET_MODE params for a firmware/vehicle.
 *
 * @param {string} firmware     profile firmware ('ardupilot' | 'px4')
 * @param {string} vehicleType  profile type ('copter' | 'plane' | 'rover' | ...)
 * @param {string} modeName     e.g. "GUIDED", "POSITION", "AUTO.MISSION"
 * @returns {{ base_mode: number, custom_mode: number }}
 * @throws {MavlinkError} UNKNOWN_MODE when the name cannot be resolved
 */
function resolveFlightMode(firmware, vehicleType, modeName) {
  const name = String(modeName).trim().toUpperCase().replace(/[\s.-]+/g, '_');

  if (firmware === 'px4') {
    const mode = PX4_MODES[name] || PX4_MODES[name.replace(/^AUTO_/, '')];
    if (mode) {
      return { base_mode: 1, custom_mode: ((mode.main << 16) | ((mode.sub || 0) << 24)) >>> 0 };
    }
    throw new MavlinkError('UNKNOWN_MODE', `Unknown PX4 mode '${modeName}'. Known: ${knownModes('px4').join(', ')}.`, {
      firmware,
      mode: modeName
    });
  }

  if (firmware === 'ardupilot') {
    const table = ARDUPILOT_MODES[vehicleType];
    if (!table) {
      throw new MavlinkError(
        'UNKNOWN_MODE',
        `No ArduPilot mode table for vehicle type '${vehicleType}'. Set the profile type to copter/plane/rover/boat/sub/antenna-tracker, or pass a numeric custom_mode.`,
        { firmware, vehicleType, mode: modeName }
      );
    }
    if (Object.prototype.hasOwnProperty.call(table, name)) {
      return { base_mode: 1, custom_mode: table[name] };
    }
    throw new MavlinkError(
      'UNKNOWN_MODE',
      `Unknown ArduPilot ${vehicleType} mode '${modeName}'. Known: ${Object.keys(table).join(', ')}.`,
      { firmware, vehicleType, mode: modeName }
    );
  }

  throw new MavlinkError(
    'UNKNOWN_MODE',
    `Mode names require the profile firmware to be 'ardupilot' or 'px4' (got '${firmware}'). Pass a numeric custom_mode instead.`,
    { firmware, mode: modeName }
  );
}

module.exports = { ARDUPILOT_MODES, PX4_MODES, knownModes, resolveFlightMode };
