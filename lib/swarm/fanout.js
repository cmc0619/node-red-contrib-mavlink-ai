'use strict';

const { MavlinkError } = require('../util/errors');
const { finite, nedOffsetToGlobal, degToDegE7 } = require('./coordinate-frames');

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
    return {
      lat: finite(target.lat, `lat (sysid ${target.sysid})`),
      lon: finite(target.lon, `lon (sysid ${target.sysid})`),
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
    params[key] = finiteParam(raw, key, target.sysid);
  }

  const targetComponent = finiteParam(
    target.target_component !== undefined
      ? target.target_component
      : defaults.defaultTargetComponent !== undefined
        ? defaults.defaultTargetComponent
        : 1,
    'target_component',
    target.sysid
  );

  let fields;
  let name;
  if (useInt) {
    name = 'COMMAND_INT';
    // Positional priority mirrors mavlink-ai-command: raw x/y wire values win,
    // then resolved lat/lon (converted to degE7), then param5/6 (degrees).
    const x =
      target.x !== undefined
        ? finiteParam(target.x, 'x', target.sysid)
        : position && position.lat !== null
          ? degToDegE7(position.lat)
          : params.param5
            ? degToDegE7(params.param5)
            : 0;
    const y =
      target.y !== undefined
        ? finiteParam(target.y, 'y', target.sysid)
        : position && position.lon !== null
          ? degToDegE7(position.lon)
          : params.param6
            ? degToDegE7(params.param6)
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
