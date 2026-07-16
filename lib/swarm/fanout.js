'use strict';

const { MavlinkError } = require('../util/errors');
const { finite, nedOffsetToGlobal, degToDegE7 } = require('./coordinate-frames');
const {
  validateLatitude,
  validateLongitude,
  validateTargetSystem,
  validateTargetComponent
} = require('../util/field-validation');

// COMMAND_INT x/y are int32 wire fields.
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * Require a raw COMMAND_INT wire coordinate to fit the int32 field it lands in
 * (#72). Raw x/y skip the lat/lon degree range-check (they may be degE7 or, for
 * local frames, mm), but they still cannot exceed int32 or serialization fails
 * downstream with an opaque error.
 *
 * @param {number} value  finite wire value
 * @param {string} name   'x' or 'y'
 * @param {number} sysid  target system, for the error context
 * @returns {number}
 * @throws {MavlinkError} BAD_COORDINATES
 */
function requireInt32(value, name, sysid) {
  if (value < INT32_MIN || value > INT32_MAX) {
    throw new MavlinkError('BAD_COORDINATES', `Target sysid ${sysid}: COMMAND_INT '${name}' ${value} is outside int32 range.`, {
      sysid,
      field: name,
      value
    });
  }
  return value;
}

/**
 * Swarm fan-out command building (issue #46).
 *
 * Fan-out and broadcast are different things and this module keeps them
 * explicit:
 *
 * - **Fan-out**: one logical command expanded into one message per target
 *   system, each with its own `target_system` and (usually) its own
 *   coordinates/params. Formation movement is fan-out.
 * - **Broadcast**: one identical message addressed to `target_system` 0. Only
 *   correct when every vehicle should interpret the exact same bytes (e.g.
 *   set stream rates).
 *
 * Pure functions — the mavlink-ai-fanout node owns sending/ACK collection.
 */

/**
 * Normalize one fan-out target: a bare sysid number/numeric string, or an
 * object with `sysid` plus per-target overrides (paramN, lat/lon/alt, x/y/z,
 * north/east/up/down offsets, frame, target_component).
 *
 * @param {*} entry
 * @returns {object} `{ sysid, ...overrides }`
 * @throws {MavlinkError} BAD_TARGET
 */
function normalizeTarget(entry) {
  if (typeof entry === 'number' || (typeof entry === 'string' && /^\d+$/.test(entry.trim()))) {
    return { sysid: Number(entry) };
  }
  if (entry && typeof entry === 'object' && Number.isFinite(Number(entry.sysid))) {
    return Object.assign({}, entry, { sysid: Number(entry.sysid) });
  }
  throw new MavlinkError('BAD_TARGET', `Fan-out target must be a sysid or an object with a sysid (got ${JSON.stringify(entry)}).`, {
    target: entry
  });
}

/**
 * Require a finite number for a command param/field, with the target sysid in
 * the error. Same strictness as the coordinate helpers: a bad upstream value
 * (NaN from a function node, a malformed string) must fail here, not ride into
 * a MAVLink command sent to a real vehicle.
 *
 * @param {*} value
 * @param {string} name   e.g. "param3", "target_component"
 * @param {number} sysid  target system, for the error context
 * @returns {number}
 * @throws {MavlinkError} BAD_PARAM
 */
function finiteParam(value, name, sysid) {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) {
    throw new MavlinkError('BAD_PARAM', `Target sysid ${sysid}: '${name}' must be a finite number (got ${JSON.stringify(value)}).`, {
      sysid,
      param: name,
      value
    });
  }
  return n;
}

/**
 * Coerce a command param (param1..7) while allowing NaN. Unlike the coordinate
 * fields, PX4 treats float NaN as a first-class "use default / keep current"
 * value — e.g. DO_REPOSITION param4 = NaN keeps the current yaw, which the
 * single-vehicle command node already relies on. finiteParam would throw
 * BAD_PARAM on that NaN and force a formation goto to yaw every vehicle to
 * heading 0; here only genuinely non-numeric garbage is rejected, not NaN
 * (#142). A number (incl. NaN), a "NaN" string, or null is honored as NaN.
 *
 * @param {*} value
 * @param {string} name   e.g. "param4"
 * @param {number} sysid  target system, for the error context
 * @returns {number}
 * @throws {MavlinkError} BAD_PARAM for non-numeric garbage
 */
function commandParam(value, name, sysid) {
  if (typeof value === 'number') {
    return value;
  }
  if (value === null) {
    return NaN;
  }
  if (typeof value === 'string' && value.trim().toLowerCase() === 'nan') {
    return NaN;
  }
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    throw new MavlinkError('BAD_PARAM', `Target sysid ${sysid}: '${name}' must be a number or NaN (got ${JSON.stringify(value)}).`, {
      sysid,
      param: name,
      value
    });
  }
  return n;
}

/**
 * Resolve the effective global position for one target, if any positional
 * input is present: explicit lat/lon (float degrees) win; otherwise a meters
 * offset (north/east/up/down) is applied to the shared origin.
 *
 * @param {object} target  normalized target
 * @param {?object} origin  shared origin { lat, lon, alt } (float degrees)
 * @returns {?{lat: number, lon: number, alt: ?number}}
 * @throws {MavlinkError} MISSING_ORIGIN when an offset target has no origin
 */
function resolvePosition(target, origin) {
  const hasOffset =
    target.north !== undefined || target.east !== undefined || target.up !== undefined || target.down !== undefined;
  if (target.lat !== undefined || target.lon !== undefined) {
    if (target.lat === undefined || target.lon === undefined) {
      throw new MavlinkError('BAD_COORDINATES', `Target sysid ${target.sysid} sets only one of lat/lon.`, {
        sysid: target.sysid
      });
    }
    // Range-check explicit lat/lon degrees (#55): a fan-out target out of
    // -90..90 / -180..180 is a mistake worth catching before it reaches a
    // vehicle. Raw x/y wire values (degE7) skip this — they're handled below.
    return {
      lat: validateLatitude(target.lat, { sysid: target.sysid }),
      lon: validateLongitude(target.lon, { sysid: target.sysid }),
      alt: target.alt !== undefined ? finite(target.alt, `alt (sysid ${target.sysid})`) : null
    };
  }
  if (hasOffset) {
    if (!origin || origin.lat === undefined || origin.lon === undefined) {
      throw new MavlinkError(
        'MISSING_ORIGIN',
        `Target sysid ${target.sysid} uses a meters offset (north/east/up/down) but no origin {lat, lon[, alt]} was provided.`,
        { sysid: target.sysid }
      );
    }
    const resolved = nedOffsetToGlobal(origin, {
      north: target.north || 0,
      east: target.east || 0,
      up: target.up,
      down: target.down
    });
    return { lat: resolved.lat, lon: resolved.lon, alt: resolved.alt };
  }
  if (target.alt !== undefined) {
    return { lat: null, lon: null, alt: finite(target.alt, `alt (sysid ${target.sysid})`) };
  }
  return null;
}

/**
 * Build the normalized outbound message for one target system.
 *
 * @param {object} opts
 * @param {string|number} opts.command  MAV_CMD name or number
 * @param {boolean} opts.useInt         COMMAND_INT instead of COMMAND_LONG
 * @param {object} opts.base            shared params (param1..7, frame, …)
 * @param {object} opts.target          normalized target (sysid + overrides)
 * @param {?object} opts.origin         shared origin for meters offsets
 * @param {object} opts.defaults        profile defaults (target component)
 * @returns {{name: string, target_system: number, target_component: number, fields: object}}
 */
function buildTargetMessage(opts) {
  const { command, useInt, base = {}, target, origin, defaults = {} } = opts;
  const position = resolvePosition(target, origin);
  const params = {};
  for (let i = 1; i <= 7; i += 1) {
    const key = `param${i}`;
    const raw = target[key] !== undefined ? target[key] : base[key] !== undefined ? base[key] : 0;
    params[key] = commandParam(raw, key, target.sysid);
  }

  // Validate the component as a uint8 MAVLink id, not just finite (#72).
  const targetComponent = validateTargetComponent(
    target.target_component !== undefined
      ? target.target_component
      : defaults.defaultTargetComponent !== undefined
        ? defaults.defaultTargetComponent
        : 1,
    { sysid: target.sysid }
  );

  let fields;
  let name;
  if (useInt) {
    name = 'COMMAND_INT';
    // Positional priority mirrors mavlink-ai-command: raw x/y wire values win,
    // then resolved lat/lon (converted to degE7), then param5/6 (degrees).
    // Raw x/y are int32 wire values (range-checked); resolved lat/lon are
    // already validated in resolvePosition; a param5/param6 fallback is treated
    // as degrees and must be a valid latitude/longitude before degE7 scaling (#72).
    /**
     * An "alt-only" target (alt with no lat/lon/offset) means "change altitude,
     * hold position": the wire sentinel for "use current" is INT32_MAX in
     * COMMAND_INT x/y (and NaN in COMMAND_LONG param5/6, below). 0 would be a
     * real coordinate — a fleet-wide alt-only fan-out would otherwise
     * reposition every vehicle to 0°N 0°E.
     */
    const altOnly = position !== null && position.lat === null;
    const x =
      target.x !== undefined
        ? requireInt32(finiteParam(target.x, 'x', target.sysid), 'x', target.sysid)
        : position && position.lat !== null
          ? degToDegE7(position.lat)
          : params.param5
            ? degToDegE7(validateLatitude(params.param5, { sysid: target.sysid }, 'param5'))
            : altOnly
              ? 0x7fffffff
              : 0;
    const y =
      target.y !== undefined
        ? requireInt32(finiteParam(target.y, 'y', target.sysid), 'y', target.sysid)
        : position && position.lon !== null
          ? degToDegE7(position.lon)
          : params.param6
            ? degToDegE7(validateLongitude(params.param6, { sysid: target.sysid }, 'param6'))
            : altOnly
              ? 0x7fffffff
              : 0;
    const z =
      target.z !== undefined
        ? finiteParam(target.z, 'z', target.sysid)
        : position && position.alt !== null
          ? position.alt
          : params.param7;
    fields = {
      command,
      frame: target.frame !== undefined ? target.frame : base.frame !== undefined ? base.frame : 'MAV_FRAME_GLOBAL',
      current: 0,
      autocontinue: 0,
      param1: params.param1,
      param2: params.param2,
      param3: params.param3,
      param4: params.param4,
      x,
      y,
      z
    };
  } else {
    name = 'COMMAND_LONG';
    // COMMAND_LONG carries position in param5/6/7 as float degrees/meters.
    if (position) {
      if (position.lat !== null) {
        params.param5 = position.lat;
        params.param6 = position.lon;
      } else if (position.alt !== null) {
        /**
         * Alt-only target: NaN is the COMMAND_LONG "use current" sentinel for
         * float lat/lon (INT32_MAX plays that role for COMMAND_INT above); the
         * default 0 would be a real coordinate at null island. Explicit
         * caller-supplied param5/6 still win.
         */
        if (!params.param5) {
          params.param5 = NaN;
        }
        if (!params.param6) {
          params.param6 = NaN;
        }
      }
      if (position.alt !== null) {
        params.param7 = position.alt;
      }
    }
    fields = Object.assign({ command, confirmation: 0 }, params);
  }

  return {
    name,
    target_system: target.sysid,
    target_component: targetComponent,
    fields
  };
}

/**
 * Expand one logical command into per-target messages (fan-out) or one
 * broadcast message (`target_system` 0).
 *
 * @param {object} opts
 * @param {string|number} opts.command
 * @param {boolean} [opts.useInt]
 * @param {boolean} [opts.broadcast]   build a single target_system-0 message
 * @param {Array} [opts.targets]       sysids and/or per-target objects
 * @param {object} [opts.base]         shared params
 * @param {?object} [opts.origin]      shared origin for meters offsets
 * @param {object} [opts.defaults]     profile defaults
 * @returns {object[]} normalized outbound messages
 * @throws {MavlinkError} NO_COMMAND / NO_TARGETS / BAD_TARGET / BAD_COORDINATES
 */
function buildFanout(opts) {
  const { command, broadcast } = opts;
  if (command === undefined || command === null || command === '') {
    throw new MavlinkError('NO_COMMAND', 'Fan-out needs a command (MAV_CMD name or number).');
  }
  if (broadcast) {
    return [
      buildTargetMessage({
        command,
        useInt: opts.useInt === true,
        base: opts.base,
        target: { sysid: 0 },
        origin: opts.origin,
        defaults: Object.assign({}, opts.defaults, { defaultTargetComponent: 0 })
      })
    ];
  }
  const targets = Array.isArray(opts.targets) ? opts.targets.map(normalizeTarget) : [];
  if (!targets.length) {
    throw new MavlinkError('NO_TARGETS', 'Fan-out needs a non-empty target list (payload.targets, payload.sysids, or registry vehicles).');
  }
  // Validate each fan-out target as a real MAVLink system id (#72). sysid 0 is
  // the broadcast address, not a vehicle: silently fanning out to it would send
  // one "addressed to everyone" message instead of a per-vehicle command, so
  // require explicit broadcast mode for that.
  const seenSysids = new Set();
  for (const target of targets) {
    validateTargetSystem(target.sysid, { sysid: target.sysid });
    if (target.sysid === 0) {
      throw new MavlinkError(
        'BAD_TARGET',
        'Fan-out target_system 0 is the broadcast address, not a vehicle. Use broadcast mode explicitly (payload.broadcast = true) to send one message to all systems.',
        { sysid: 0 }
      );
    }
    /**
     * A duplicate sysid is an authoring bug, not a fleet: downstream ACK
     * aggregation keys results by sysid, so duplicates would silently
     * overwrite each other's result while double-counting accepted/failed.
     */
    if (seenSysids.has(target.sysid)) {
      throw new MavlinkError('BAD_TARGET', `Duplicate fan-out target sysid ${target.sysid}.`, {
        sysid: target.sysid
      });
    }
    seenSysids.add(target.sysid);
  }
  return targets.map((target) =>
    buildTargetMessage({
      command,
      useInt: opts.useInt === true,
      base: opts.base,
      target,
      origin: opts.origin,
      defaults: opts.defaults
    })
  );
}

module.exports = { buildFanout, buildTargetMessage, normalizeTarget };
