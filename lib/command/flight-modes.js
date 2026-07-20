'use strict';

const { MavlinkError } = require('../util/errors');
const { bindEnumValues, coreEnumValues } = require('../protocol/protocol-values');

/**
 * Firmware-aware flight-mode name resolution (issue #20). A mode name like
 * "GUIDED" means custom_mode 4 on ArduCopter but 15 on ArduPlane, and PX4
 * encodes modes as a main/sub pair — so mode names can only be resolved
 * against the profile's firmware + vehicle type. This is the first real
 * consumer of the profile's firmware abstraction field.
 *
 * The two firmwares read MAV_CMD_DO_SET_MODE differently (issue #136):
 * ArduPilot takes the whole custom_mode in param2, while PX4's commander
 * reads param2 as the bare `(uint8) custom_main_mode` and param3 as the bare
 * `(uint8) custom_sub_mode`. PX4's `(main << 16) | (sub << 24)` packing
 * exists only in the HEARTBEAT custom_mode report — sending the packed value
 * in param2 truncates to main mode 0 and the mode change is ignored. All
 * resolutions use MAV_MODE_FLAG_CUSTOM_MODE_ENABLED (1) as base_mode.
 */

// Vehicle Profile family -> generated ArduPilot custom-mode enum.
const ARDUPILOT_MODE_ENUM = {
  copter: 'CopterMode',
  plane: 'PlaneMode',
  rover: 'RoverMode',
  boat: 'RoverMode',
  sub: 'SubMode',
  'antenna-tracker': 'TrackerMode'
};

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
 * @param {object} context  { firmware, vehicleType, enums, dialect }
 * @returns {string[]}
 */
function knownModes(context = {}) {
  const { firmware, vehicleType, enums, dialect } = context;
  if (firmware === 'px4') {
    return Object.keys(PX4_MODES);
  }
  if (firmware === 'ardupilot') {
    const enumName = ARDUPILOT_MODE_ENUM[vehicleType];
    const value = bindEnumValues(enums, { dialect, consumer: 'flight-mode' });
    return enumName
      ? value.members(enumName).map(({ name }) => name)
      : [];
  }
  return [];
}

/**
 * Flight-mode choices (name + the numeric custom_mode wire value) for a
 * firmware/vehicle combination. Drives the raw command editor's profile-aware
 * custom_mode dropdown (issue #97): the same name resolves to a different wire
 * value per firmware/vehicle (GUIDED is 4 on ArduCopter but 15 on ArduPlane),
 * so callers persist the numeric value while showing the readable name. Empty
 * when mode names are not supported for the combination.
 *
 * PX4 values are the HEARTBEAT-packed form (one number per choice); the
 * command node splits a packed param2 into DO_SET_MODE's param2/param3 at
 * build time via {@link splitPx4CustomMode} (issue #136).
 *
 * @param {object} context  { firmware, vehicleType, enums, dialect }
 * @returns {{ name: string, value: number }[]}
 */
function modeChoices(context = {}) {
  const { firmware, vehicleType, enums, dialect } = context;
  if (firmware === 'px4') {
    return Object.entries(PX4_MODES).map(([name, mode]) => ({
      name,
      value: ((mode.main << 16) | ((mode.sub || 0) << 24)) >>> 0
    }));
  }
  if (firmware === 'ardupilot') {
    const enumName = ARDUPILOT_MODE_ENUM[vehicleType];
    const value = bindEnumValues(enums, { dialect, consumer: 'flight-mode' });
    return enumName ? value.members(enumName) : [];
  }
  return [];
}

/**
 * Resolve a flight-mode name to DO_SET_MODE params for a firmware/vehicle.
 *
 * For PX4 the returned `custom_mode` is the bare main mode and
 * `custom_submode` the bare sub mode — the separate values DO_SET_MODE
 * param2/param3 expect (issue #136) — not the HEARTBEAT-packed word.
 *
 * @param {object} context      { firmware, vehicleType, enums, dialect }
 * @param {string} modeName     e.g. "GUIDED", "POSITION", "AUTO.MISSION"
 * @returns {{ base_mode: number, custom_mode: number, custom_submode?: number }}
 * @throws {MavlinkError} UNKNOWN_MODE when the name cannot be resolved
 */
function resolveFlightMode(context = {}, modeName) {
  const { firmware, vehicleType, enums, dialect } = context;
  // MavModeFlag.CUSTOM_MODE_ENABLED is a common core bit (never dialect-specific),
  // so resolve base_mode from the core bundle: a PX4 profile with no loaded
  // dialect (enums null) still gets base_mode 1 instead of throwing (#309 review).
  const baseMode = () => coreEnumValues({ consumer: 'flight-mode' })('MavModeFlag', 'CUSTOM_MODE_ENABLED');

  if (firmware === 'px4') {
    const name = String(modeName).trim().toUpperCase().replace(/[\s.-]+/g, '_');
    const mode = PX4_MODES[name] || PX4_MODES[name.replace(/^AUTO_/, '')];
    if (mode) {
      return { base_mode: baseMode(), custom_mode: mode.main, custom_submode: mode.sub || 0 };
    }
    throw new MavlinkError('UNKNOWN_MODE', `Unknown PX4 mode '${modeName}'. Known: ${knownModes(context).join(', ')}.`, {
      firmware,
      mode: modeName
    });
  }

  if (firmware === 'ardupilot') {
    const enumName = ARDUPILOT_MODE_ENUM[vehicleType];
    if (!enumName) {
      throw new MavlinkError(
        'UNKNOWN_MODE',
        `No ArduPilot mode table for vehicle type '${vehicleType}'. Set the profile type to copter/plane/rover/boat/sub/antenna-tracker, or pass a numeric custom_mode.`,
        { firmware, vehicleType, mode: modeName }
      );
    }
    // ArduPilot custom_mode enums (CopterMode/PlaneMode/…) live in the
    // ardupilotmega dialect, so they stay fail-closed on the profile's own
    // enum index — a missing dialect throws ENUM_VALUE_UNAVAILABLE here by design.
    const value = bindEnumValues(enums, { dialect, consumer: 'flight-mode' });
    const names = value.members(enumName).map(({ name }) => name);
    if (typeof modeName === 'string' && names.includes(modeName)) {
      return {
        base_mode: baseMode(),
        custom_mode: value(enumName, modeName)
      };
    }
    throw new MavlinkError(
      'UNKNOWN_MODE',
      `Unknown ArduPilot ${vehicleType} mode '${modeName}'. Known: ${names.join(', ')}.`,
      { firmware, vehicleType, mode: modeName }
    );
  }

  throw new MavlinkError(
    'UNKNOWN_MODE',
    `Mode names require the profile firmware to be 'ardupilot' or 'px4' (got '${firmware}'). Pass a numeric custom_mode instead.`,
    { firmware, mode: modeName }
  );
}

/**
 * Reverse lookup: the readable mode name for a HEARTBEAT custom_mode value
 * (inverse of {@link resolveFlightMode}). Used by the swarm registry to label
 * each vehicle's mode (issue #46). Returns null when the combination is
 * unknown — callers keep the numeric custom_mode either way.
 *
 * @param {object} context      { firmware, vehicleType, enums, dialect }
 * @param {number} customMode   HEARTBEAT custom_mode
 * @returns {?string}
 */
function modeNameForCustomMode(context = {}, customMode) {
  const { firmware, vehicleType, enums, dialect } = context;
  const value = Number(customMode);
  if (!Number.isFinite(value)) {
    return null;
  }
  if (firmware === 'px4') {
    const main = (value >>> 16) & 0xff;
    const sub = (value >>> 24) & 0xff;
    for (const [name, mode] of Object.entries(PX4_MODES)) {
      if (mode.main === main && (mode.sub || 0) === sub) {
        return name; // first entry wins: canonical names precede their aliases
      }
    }
    return null;
  }
  if (firmware === 'ardupilot') {
    const enumName = ARDUPILOT_MODE_ENUM[vehicleType];
    if (!enumName) {
      return null;
    }
    /**
     * Reverse mode-name lookup is best-effort per this function's contract:
     * "returns null when the combination is unknown — callers keep the numeric
     * custom_mode either way." The ArduPilot mode enums live in the
     * `ardupilotmega` dialect, so a profile on a different dialect (`common`,
     * PX4/generic GCS, …) observing an ArduPilot vehicle has a valid but
     * ArduPilot-less enum index. Return null rather than letting
     * `members(enumName)` throw ENUM_VALUE_UNAVAILABLE, which would silently
     * drop the whole vehicle-state / swarm snapshot for that heartbeat.
     */
    if (!enums || !enums.enumsByName || !enums.enumsByName[enumName]) {
      return null;
    }
    const enumValue = bindEnumValues(enums, { dialect, consumer: 'flight-mode' });
    for (const { name, value: mode } of enumValue.members(enumName)) {
      if (mode === value) {
        return name;
      }
    }
  }
  return null;
}

/**
 * Split a HEARTBEAT-packed PX4 custom_mode (`(main << 16) | (sub << 24)`)
 * into the bare main/sub values MAV_CMD_DO_SET_MODE expects in param2/param3
 * (issue #136). Packed values are always >= 0x10000 (main modes are 1–8), so
 * a bare main-mode value or anything non-numeric returns null and the caller
 * leaves the params untouched.
 *
 * @param {*} value  candidate param2 value
 * @returns {?{ main: number, sub: number }}
 */
function splitPx4CustomMode(value) {
  const packed = Number(value);
  if (!Number.isFinite(packed) || packed < 0x10000) {
    return null;
  }
  return { main: (packed >>> 16) & 0xff, sub: (packed >>> 24) & 0xff };
}

module.exports = { knownModes, modeChoices, resolveFlightMode, splitPx4CustomMode, modeNameForCustomMode };
