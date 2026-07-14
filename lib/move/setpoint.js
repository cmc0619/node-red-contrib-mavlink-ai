'use strict';

const enumResolver = require('../protocol/enum-resolver');
const { MavlinkError } = require('../util/errors');

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
  position: 0b0000_0000_0111,
  /** vx/vy/vz — bits 3-5. */
  velocity: 0b0000_0011_1000,
  /** afx/afy/afz — bits 6-8. */
  accel: 0b0001_1100_0000,
  /** yaw — bit 10. */
  yaw: 0b0100_0000_0000,
  /** yaw_rate — bit 11. */
  yawRate: 0b1000_0000_0000
};

/**
 * Named setpoint presets mapped to the dimensions they drive. Anything not
 * listed for a preset is left ignored in the mask (and sent as 0). Accel/force
 * setpoints are intentionally out of scope for these presets — use `custom`
 * with an explicit `typeMask` for those.
 */
const PRESETS = {
  position: { position: true },
  position_yaw: { position: true, yaw: true },
  velocity: { velocity: true },
  velocity_yaw_rate: { velocity: true, yawRate: true },
  position_velocity: { position: true, velocity: true },
  yaw: { yaw: true },
  yaw_rate: { yawRate: true }
};

/**
 * Fallback numeric values for the coordinate frames the node offers, used when
 * no dialect enum index is available to resolve them by name. Values are the
 * standard MAV_FRAME assignments.
 */
const FRAME_FALLBACK = {
  MAV_FRAME_LOCAL_NED: 1,
  MAV_FRAME_LOCAL_OFFSET_NED: 7,
  MAV_FRAME_BODY_OFFSET_NED: 9,
  MAV_FRAME_GLOBAL_INT: 5,
  MAV_FRAME_GLOBAL_RELATIVE_ALT_INT: 6,
  MAV_FRAME_GLOBAL_TERRAIN_ALT_INT: 11
};

/**
 * Compose an inverted `type_mask` from the set of active dimensions.
 *
 * @param {object} dims  truthy flags: position, velocity, accel, yaw, yawRate
 * @returns {number} 16-bit mask where a SET bit means the autopilot ignores it
 */
function buildTypeMask(dims) {
  let mask = DIM_BITS.position | DIM_BITS.velocity | DIM_BITS.accel | DIM_BITS.yaw | DIM_BITS.yawRate;
  for (const key of Object.keys(DIM_BITS)) {
    if (dims && dims[key]) {
      mask &= ~DIM_BITS[key];
    }
  }
  return mask & 0xffff;
}

/**
 * Resolve a MAV_FRAME name to its numeric value, preferring the dialect enum
 * index (so custom dialects work) and falling back to the standard assignment.
 *
 * @param {string} frameName  e.g. 'MAV_FRAME_LOCAL_NED'
 * @param {object} [enums]    dialect enum index
 * @returns {number}
 */
function resolveFrame(frameName, enums) {
  if (enums) {
    const resolved = enumResolver.lookup(enums, frameName);
    if (typeof resolved === 'number') {
      return resolved;
    }
  }
  if (Object.prototype.hasOwnProperty.call(FRAME_FALLBACK, frameName)) {
    return FRAME_FALLBACK[frameName];
  }
  throw new MavlinkError('BAD_FRAME', `Unknown coordinate frame '${frameName}'.`);
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
 * @param {*} [opts.yaw]   @param {*} [opts.yawRate]
 * @param {*} [opts.timeBootMs]
 * @param {*} [opts.targetSystem] @param {*} [opts.targetComponent]
 * @returns {{ name: string, fields: object }} normalized outbound message parts
 */
function buildSetpoint(opts = {}) {
  const coordinate = opts.coordinate === 'global' ? 'global' : 'local';
  const typeMask = resolveTypeMask(opts.preset, opts.typeMask);
  const frame = resolveFrame(opts.frame, opts.enums);

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
    afx: 0,
    afy: 0,
    afz: 0,
    yaw: deg2rad(opts.yaw),
    yaw_rate: deg2rad(opts.yawRate)
  };

  if (coordinate === 'global') {
    return {
      name: 'SET_POSITION_TARGET_GLOBAL_INT',
      fields: Object.assign(
        {
          lat_int: Math.round(num(opts.lat) * 1e7),
          lon_int: Math.round(num(opts.lon) * 1e7),
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

module.exports = {
  DIM_BITS,
  PRESETS,
  FRAME_FALLBACK,
  buildTypeMask,
  resolveTypeMask,
  resolveFrame,
  buildSetpoint
};
