'use strict';

const { requireEnumMember, coreEnumMember } = require('../protocol/protocol-values');
const { MavlinkError } = require('../util/errors');
const { degToDegE7 } = require('../util/geo');

/**
 * Position-target setpoint construction for the mavlink-ai-move node.
 *
 * Builds `SET_POSITION_TARGET_LOCAL_NED` / `SET_POSITION_TARGET_GLOBAL_INT`
 * messages from a friendly setpoint description, hiding the two things people
 * get wrong when hand-rolling these via the build node:
 *
 *   1. the `type_mask`, whose bits are *inverted* — a SET bit means IGNORE that
 *      dimension — so "position control" is expressed as "ignore everything
 *      except position"; and
 *   2. NED's down-positive vertical axis, so an intuitive up-positive altitude
 *      / climb rate maps to a negative `z` / `vz`.
 *
 * The logic is kept out of the node wrapper so the mask and axis conventions
 * can be unit-tested directly.
 */

/**
 * `type_mask` bit groups. Each named dimension owns the bits that, when SET,
 * tell the autopilot to IGNORE that dimension (POSITION_TARGET_TYPEMASK). We
 * build a mask by starting from "ignore everything" and clearing the groups the
 * setpoint actually drives.
 */
const DIM_BITS = {
  /** x/y/z or lat/lon/alt — bits 0-2. */
  position:
    coreEnumMember('PositionTargetTypemask', 'X_IGNORE', { consumer: 'move' }) |
    coreEnumMember('PositionTargetTypemask', 'Y_IGNORE', { consumer: 'move' }) |
    coreEnumMember('PositionTargetTypemask', 'Z_IGNORE', { consumer: 'move' }),
  /** vx/vy/vz — bits 3-5. */
  velocity:
    coreEnumMember('PositionTargetTypemask', 'VX_IGNORE', { consumer: 'move' }) |
    coreEnumMember('PositionTargetTypemask', 'VY_IGNORE', { consumer: 'move' }) |
    coreEnumMember('PositionTargetTypemask', 'VZ_IGNORE', { consumer: 'move' }),
  /** afx/afy/afz — bits 6-8. */
  accel:
    coreEnumMember('PositionTargetTypemask', 'AX_IGNORE', { consumer: 'move' }) |
    coreEnumMember('PositionTargetTypemask', 'AY_IGNORE', { consumer: 'move' }) |
    coreEnumMember('PositionTargetTypemask', 'AZ_IGNORE', { consumer: 'move' }),
  /** yaw — bit 10. */
  yaw: coreEnumMember('PositionTargetTypemask', 'YAW_IGNORE', { consumer: 'move' }),
  /** yaw_rate — bit 11. */
  yawRate: coreEnumMember('PositionTargetTypemask', 'YAW_RATE_IGNORE', { consumer: 'move' })
};

/**
 * Bit 9 is NOT an ignore bit like the dimension groups above — it is a *mode*
 * flag: when SET, the `af` vector is interpreted as a force (N) rather than an
 * acceleration (m/s²). Using force therefore means clearing the accel-ignore
 * bits (6-8, so `af` is honored) AND setting bit 9. Because it isn't an ignore
 * bit it must stay out of the "ignore everything" base mask.
 */
const FORCE_BIT = coreEnumMember('PositionTargetTypemask', 'FORCE_SET', { consumer: 'move' });

/**
 * Named setpoint presets mapped to the dimensions they drive. Anything not
 * listed for a preset is left ignored in the mask (and sent as 0). The
 * `acceleration*` presets send `af` as an acceleration; the `force*` presets
 * set bit 9 so `af` is interpreted as a force. Use `custom` with an explicit
 * `typeMask` for combinations these presets don't cover.
 */
const PRESETS = {
  position: { position: true },
  position_yaw: { position: true, yaw: true },
  velocity: { velocity: true },
  velocity_yaw_rate: { velocity: true, yawRate: true },
  position_velocity: { position: true, velocity: true },
  acceleration: { accel: true },
  acceleration_yaw: { accel: true, yaw: true },
  force: { force: true },
  force_yaw: { force: true, yaw: true },
  yaw: { yaw: true },
  yaw_rate: { yawRate: true }
};

/**
 * Fallback numeric values for the coordinate frames the node offers, used when
 * no dialect enum index is available to resolve them by name. Values are the
 * standard MAV_FRAME assignments.
 */
/**
 * Compose an inverted `type_mask` from the set of active dimensions. `force` is
 * special: it isn't an ignore group but a mode flag, so it clears the accel
 * bits (the `af` vector is honored) and sets bit 9 (that vector is a force).
 *
 * @param {object} dims  truthy flags: position, velocity, accel, force, yaw, yawRate
 * @returns {number} 16-bit mask where a SET bit means the autopilot ignores it
 */
function buildTypeMask(dims) {
  let mask = DIM_BITS.position | DIM_BITS.velocity | DIM_BITS.accel | DIM_BITS.yaw | DIM_BITS.yawRate;
  for (const key of Object.keys(DIM_BITS)) {
    if (dims && dims[key]) {
      mask &= ~DIM_BITS[key];
    }
  }
  if (dims && dims.force) {
    mask &= ~DIM_BITS.accel;
    mask |= FORCE_BIT;
  }
  return mask & 0xffff;
}

/**
 * Resolve a MAV_FRAME name to its numeric value, preferring the dialect enum
 * index (so custom dialects work) and falling back to the standard assignment.
 *
 * @param {string} frameName  e.g. 'LOCAL_NED'
 * @param {object} [enums]    dialect enum index
 * @returns {number}
 */
function resolveFrame(memberKey, enums, context = {}) {
  return requireEnumMember(enums, 'MavFrame', memberKey, { ...context, consumer: 'move' });
}

/**
 * A finite number or 0. Ignored dimensions and blank inputs collapse to 0,
 * which is the conventional filler for masked-out setpoint fields.
 *
 * @param {*} v
 * @returns {number}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Strict finite-input test for an operator-entered setpoint field. Unlike
 * `num()`/`Number()` — for which a blank string, whitespace, null or undefined
 * all coerce to a "finite" 0 — these are exactly the "left it blank" cases #235
 * must reject rather than silently substitute. Returns true only for a value
 * that was actually present and coerces to a finite number (an entered 0 counts).
 *
 * @param {*} v
 * @returns {boolean}
 */
function isFiniteInput(v) {
  if (v === null || v === undefined) {
    return false;
  }
  if (typeof v === 'string' && v.trim() === '') {
    return false;
  }
  return Number.isFinite(Number(v));
}

/**
 * Wire axes governed by the (inverted) `type_mask` — each pairs a mask bit (SET
 * = ignore that axis) with the friendly input field that drives it. The
 * horizontal-position inputs differ by frame (north/east vs lat/lon); `local`
 * lists all three position axes, `global` lists only the vertical one because
 * lat/lon get a dedicated finite+in-range guard. `shared` holds the
 * velocity/acceleration/yaw axes, identical for both frames.
 *
 * @type {{local: Array, global: Array, shared: Array}}
 */
const ACTIVE_AXES = {
  local: [
    { bit: 0, field: 'north' },
    { bit: 1, field: 'east' },
    { bit: 2, field: 'altitude' }
  ],
  global: [{ bit: 2, field: 'altitude' }],
  shared: [
    { bit: 3, field: 'velNorth' },
    { bit: 4, field: 'velEast' },
    { bit: 5, field: 'climb' },
    { bit: 6, field: 'accelNorth' },
    { bit: 7, field: 'accelEast' },
    { bit: 8, field: 'accelUp' },
    { bit: 10, field: 'yaw' },
    { bit: 11, field: 'yawRate' }
  ]
};

/**
 * An axis is ACTIVE when its `type_mask` ignore bit is clear. `num()` would turn
 * a blank/NaN/Infinity active field into 0 — a real command the operator never
 * entered (a hold-zero velocity on an axis they meant to drive, the local
 * origin). Fail loudly so only intentional finite values (0 included) reach the
 * wire (#235); ignored axes stay expressed through the mask and are never
 * validated. Global lat/lon carry their own finite+in-range guard, so they are
 * excluded here.
 *
 * @param {object} opts       the raw setpoint request
 * @param {string} coordinate 'local' | 'global'
 * @param {number} typeMask   the resolved (inverted) mask
 * @param {string} preset     preset name (for the error message)
 * @param {string} frameName  MAV_FRAME name (for the error message)
 * @returns {void}
 */
function assertActiveFieldsFinite(opts, coordinate, typeMask, preset, frameName) {
  const axes = (coordinate === 'global' ? ACTIVE_AXES.global : ACTIVE_AXES.local).concat(ACTIVE_AXES.shared);
  const bad = [];
  for (const axis of axes) {
    const active = (typeMask & (1 << axis.bit)) === 0;
    if (active && !isFiniteInput(opts[axis.field])) {
      bad.push({ field: axis.field, value: opts[axis.field] });
    }
  }
  if (bad.length) {
    const detail = bad.map((b) => `${b.field}='${b.value}'`).join(', ');
    throw new MavlinkError(
      'BAD_SETPOINT_FIELD',
      `Setpoint preset '${preset}' (frame ${frameName}) drives ${bad.map((b) => b.field).join(', ')}, which must be finite: ${detail}.`,
      { preset, frame: frameName, fields: bad.map((b) => b.field) }
    );
  }
}

/**
 * Degrees to radians. Yaw and yaw-rate are entered in the friendly °/(°/s) and
 * ride the wire in rad/(rad/s).
 *
 * @param {*} deg
 * @returns {number}
 */
function deg2rad(deg) {
  return (num(deg) * Math.PI) / 180;
}

/**
 * Resolve the effective `type_mask` for a request: an explicit custom mask, or
 * the mask implied by a named preset.
 *
 * @param {string} preset
 * @param {*} [customMask]
 * @returns {number}
 */
function resolveTypeMask(preset, customMask) {
  if (preset === 'custom') {
    const n = Number(customMask);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
      throw new MavlinkError('BAD_TYPE_MASK', `Custom type_mask must be an integer 0..65535 (got '${customMask}').`);
    }
    return n;
  }
  const dims = PRESETS[preset];
  if (!dims) {
    throw new MavlinkError('BAD_PRESET', `Unknown setpoint preset '${preset}'.`);
  }
  return buildTypeMask(dims);
}

/**
 * Build a position-target setpoint message.
 *
 * Vertical inputs are up-positive: for the LOCAL frame the altitude maps to a
 * negative `z` and climb to a negative `vz` (NED is down-positive); for the
 * GLOBAL frame `alt` is already up-positive metres and is sent as-is.
 *
 * @param {object} opts
 * @param {string} opts.coordinate         'local' | 'global'
 * @param {string} opts.preset             preset name, or 'custom'
 * @param {*} [opts.typeMask]              raw 0..65535 mask (preset 'custom')
 * @param {string} opts.frame              MAV_FRAME name
 * @param {object} [opts.enums]            dialect enum index for frame lookup
 * @param {*} [opts.north] @param {*} [opts.east] @param {*} [opts.altitude]
 * @param {*} [opts.lat]   @param {*} [opts.lon]
 * @param {*} [opts.velNorth] @param {*} [opts.velEast] @param {*} [opts.climb]
 * @param {*} [opts.accelNorth] @param {*} [opts.accelEast] @param {*} [opts.accelUp]
 * @param {*} [opts.yaw]   @param {*} [opts.yawRate]
 * @param {*} [opts.timeBootMs]
 * @param {*} [opts.targetSystem] @param {*} [opts.targetComponent]
 * @returns {{ name: string, fields: object }} normalized outbound message parts
 */
function buildSetpoint(opts = {}) {
  const coordinate = opts.coordinate === 'global' ? 'global' : 'local';
  const typeMask = resolveTypeMask(opts.preset, opts.typeMask);
  const frame = resolveFrame(opts.frame, opts.enums, { dialect: opts.dialect || 'unknown' });
  /**
   * Every axis the mask leaves active must carry a finite value (global lat/lon
   * have their own guard below). Runs before any field is built so a
   * partially-filled request never ships value-substituted zeros (#235).
   */
  assertActiveFieldsFinite(opts, coordinate, typeMask, opts.preset, opts.frame);

  const common = {
    time_boot_ms: num(opts.timeBootMs),
    target_system: opts.targetSystem,
    target_component: opts.targetComponent,
    coordinate_frame: frame,
    type_mask: typeMask,
    vx: num(opts.velNorth),
    vy: num(opts.velEast),
    /** NED is down-positive: an up-positive climb rate is a negative vz. */
    vz: -num(opts.climb),
    /** The `af` vector carries acceleration or, with the force preset, force. */
    afx: num(opts.accelNorth),
    afy: num(opts.accelEast),
    /** NED is down-positive: an up-positive accel/force is a negative afz. */
    afz: -num(opts.accelUp),
    yaw: deg2rad(opts.yaw),
    yaw_rate: deg2rad(opts.yawRate)
  };

  if (coordinate === 'global') {
    /**
     * A position-driving global setpoint with absent or invalid lat/lon must
     * fail loudly: num() would collapse them to 0 and a vehicle in
     * OFFBOARD/GUIDED would fly toward 0°N 0°E. Checked only when the mask
     * actually commands horizontal position (ignore bits 0/1 not both set) —
     * velocity/acceleration presets never require coordinates.
     */
    if ((typeMask & 0x3) !== 0x3) {
      const lat = Number(opts.lat);
      const lon = Number(opts.lon);
      if (!isFiniteInput(opts.lat) || lat < -90 || lat > 90 || !isFiniteInput(opts.lon) || lon < -180 || lon > 180) {
        throw new MavlinkError(
          'BAD_SETPOINT_POSITION',
          `Global position setpoint requires a finite lat in [-90, 90] and lon in [-180, 180] (got lat='${opts.lat}', lon='${opts.lon}').`,
          { lat: opts.lat, lon: opts.lon }
        );
      }
    }
    return {
      name: 'SET_POSITION_TARGET_GLOBAL_INT',
      fields: Object.assign(
        {
          lat_int: degToDegE7(num(opts.lat)),
          lon_int: degToDegE7(num(opts.lon)),
          /** Global alt is already up-positive metres — no NED flip. */
          alt: num(opts.altitude)
        },
        common
      )
    };
  }

  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: Object.assign(
      {
        x: num(opts.north),
        y: num(opts.east),
        /** NED is down-positive: an up-positive altitude is a negative z. */
        z: -num(opts.altitude)
      },
      common
    )
  };
}

/**
 * Advisory per-firmware setpoint checks (#128): ArduPilot (GUIDED) and PX4
 * (OFFBOARD) honor different `type_mask` bit combinations and frames, and a
 * combination a firmware won't honor fails *silently* on the vehicle — the
 * setpoint is simply ignored or the offending dimension dropped. These return
 * human-readable warnings (not errors): firmware behaviour varies by version,
 * so the setpoint is still sent and the operator is told what may not work.
 * Generic, absent, and unknown firmware values produce no warnings.
 *
 * @param {object} opts
 * @param {string} [opts.firmware]  profile firmware ('ardupilot' | 'px4' | ...)
 * @param {number} opts.typeMask    the resolved (inverted) type_mask
 * @param {string} [opts.frameName] MAV_FRAME name in use
 * @returns {string[]} advisory warnings, empty when nothing is suspect
 */
function setpointWarnings(opts = {}) {
  /** Normalize: the profile stores firmware as-is, so a mixed-case value must
   * not silently suppress the advisories. */
  const firmware = String(opts.firmware || '').toLowerCase();
  if (firmware !== 'ardupilot' && firmware !== 'px4') {
    return [];
  }
  const warnings = [];
  const mask = Number(opts.typeMask) & 0xffff;
  const frameName = opts.frameName || '';
  const drivesAccel = (mask & DIM_BITS.accel) !== DIM_BITS.accel;
  const isForce = (mask & FORCE_BIT) === FORCE_BIT;

  if (isForce) {
    warnings.push(
      `${firmware === 'px4' ? 'PX4' : 'ArduPilot'} does not support FORCE setpoints (type_mask bit 9) — the af vector will be ignored or the setpoint rejected.`
    );
  } else if (drivesAccel && firmware === 'ardupilot') {
    warnings.push(
      'ArduPilot honors acceleration setpoints only on recent Copter GUIDED firmware — older versions silently ignore the af vector.'
    );
  }

  if (firmware === 'px4') {
    if (frameName === 'GLOBAL_TERRAIN_ALT_INT') {
      warnings.push('PX4 does not support terrain-altitude position targets (GLOBAL_TERRAIN_ALT_INT).');
    }
    if (frameName === 'LOCAL_OFFSET_NED' || frameName === 'BODY_OFFSET_NED') {
      warnings.push(`PX4 does not support the OFFSET frames (${frameName}) — use LOCAL_NED or BODY_NED.`);
    }
  }
  return warnings;
}

module.exports = {
  DIM_BITS,
  FORCE_BIT,
  PRESETS,
  buildTypeMask,
  resolveTypeMask,
  resolveFrame,
  buildSetpoint,
  setpointWarnings
};
