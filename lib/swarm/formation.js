'use strict';

const { MavlinkError } = require('../util/errors');
const { finite, nedOffsetToGlobal, globalToNedOffset } = require('./coordinate-frames');

/**
 * Formation geometry for swarm fan-out (issue #46 / #232).
 *
 * Pure functions: given a shape, a spacing, an anchor position, a heading, and a
 * set of vehicle sysids, produce one global {lat, lon, alt} target per vehicle —
 * shaped exactly like a `mavlink-ai-fanout` target so the two compose directly
 * (`formation → fanout → out`). The node owns the live telemetry, rate limiting,
 * and leader succession; this module owns only the math.
 *
 * Slots are laid out in a body frame — `forward` (+ahead) / `right` (+starboard)
 * / `down` — then rotated by the heading so "behind the leader" stays behind as
 * it turns, and finally applied to the anchor with the flat-earth NED→global
 * helpers in coordinate-frames (which already guard the poles / meridian). Slot 0
 * sits on the anchor itself (the reference/leader position); the rest fan out
 * from it.
 */

/**
 * The geometric shapes. `follow-leader` is a node *mode*, not a shape — its
 * followers arrange with one of these around the leader's live pose.
 */
const SHAPES = ['line', 'column', 'grid', 'wedge', 'circle'];

/**
 * Body-frame offsets for `count` slots of a given shape, `spacing` meters apart.
 * Slot 0 is always the reference (origin); slots 1..n fan out from it.
 *
 * @param {string} shape    one of {@link SHAPES}
 * @param {number} count    how many slots to generate (>= 0)
 * @param {number} spacing  meters between adjacent slots (or ring radius for a circle)
 * @returns {Array<{forward: number, right: number, down: number}>}
 * @throws {MavlinkError} BAD_FORMATION for an unknown shape
 */
function slotOffsets(shape, count, spacing) {
  const s = finite(spacing, 'spacing');
  const n = Math.max(0, Math.trunc(count));
  const out = [];
  switch (shape) {
    case 'line':
      /** Abreast, centered on the reference: 0, +s, -s, +2s, -2s, ... */
      for (let i = 0; i < n; i += 1) {
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 1 ? 1 : -1;
        out.push({ forward: 0, right: i === 0 ? 0 : side * rank * s, down: 0 });
      }
      break;
    case 'column':
      /** Single file trailing directly behind the reference. */
      for (let i = 0; i < n; i += 1) {
        out.push({ forward: -i * s, right: 0, down: 0 });
      }
      break;
    case 'wedge':
      /** V: apex on the reference, arms trailing back and out to each side. */
      for (let i = 0; i < n; i += 1) {
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 1 ? 1 : -1;
        out.push({ forward: i === 0 ? 0 : -rank * s, right: i === 0 ? 0 : side * rank * s, down: 0 });
      }
      break;
    case 'circle':
      /** Reference at the center; the rest evenly spaced on a ring of radius=spacing. */
      for (let i = 0; i < n; i += 1) {
        if (i === 0) {
          out.push({ forward: 0, right: 0, down: 0 });
          continue;
        }
        const ring = n - 1;
        const theta = (2 * Math.PI * (i - 1)) / ring;
        out.push({ forward: s * Math.cos(theta), right: s * Math.sin(theta), down: 0 });
      }
      break;
    case 'grid': {
      /**
       * Slot 0 stays on the reference (the module contract); the remaining
       * vehicles fill a row-major block trailing behind it, centered left-right.
       * Columns are sized from the follower count so slot 0 is never shifted.
       */
      const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(0, n - 1))));
      for (let i = 0; i < n; i += 1) {
        if (i === 0) {
          out.push({ forward: 0, right: 0, down: 0 });
          continue;
        }
        const follower = i - 1;
        const row = Math.floor(follower / cols) + 1;
        const col = follower % cols;
        out.push({ forward: -row * s, right: (col - (cols - 1) / 2) * s, down: 0 });
      }
      break;
    }
    default:
      throw new MavlinkError('BAD_FORMATION', `Unknown formation shape '${shape}' (expected one of ${SHAPES.join(', ')}).`, {
        shape
      });
  }
  /** Normalize -0 (from `-i * s` at index 0, etc.) to 0 so offsets are clean. */
  const nz = (x) => (x === 0 ? 0 : x);
  return out.map((o) => ({ forward: nz(o.forward), right: nz(o.right), down: nz(o.down) }));
}

/**
 * Rotate a body-frame offset (forward/right) into an NED offset (north/east) by
 * a heading in degrees (0 = north, clockwise-positive toward east).
 *
 * @param {{forward?: number, right?: number, down?: number}} offset
 * @param {number} headingDeg
 * @returns {{north: number, east: number, down: number}}
 */
function bodyToNed(offset, headingDeg) {
  const h = (finite(headingDeg, 'heading') * Math.PI) / 180;
  const cos = Math.cos(h);
  const sin = Math.sin(h);
  const fwd = offset.forward || 0;
  const right = offset.right || 0;
  return {
    north: fwd * cos - right * sin,
    east: fwd * sin + right * cos,
    down: offset.down || 0
  };
}

/**
 * Assign each vehicle a deterministic slot index. Sorted-sysid order by default
 * (so slot assignment is stable across snapshots); an explicit `{sysid: index}`
 * map pins known vehicles ("sysid 3 is always left wing"), and any unpinned
 * vehicles fill the lowest free slots in sysid order.
 *
 * @param {Array<number|string>} sysids
 * @param {object} [opts]
 * @param {Object<string, number>} [opts.slotMap]  explicit sysid -> slot index
 * @param {number} [opts.startSlot=0]  lowest slot index auto-assignment may use
 *   (a follow-leader mode passes 1 to reserve slot 0 for the leader)
 * @returns {Map<number, number>} sysid -> slot index
 * @throws {MavlinkError} BAD_SLOT for a non-integer/negative explicit index
 */
function assignSlots(sysids, opts = {}) {
  const sorted = [...new Set([...sysids].map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const startSlot = Number.isInteger(opts.startSlot) && opts.startSlot >= 0 ? opts.startSlot : 0;
  const map = new Map();
  const explicit = opts.slotMap && typeof opts.slotMap === 'object' ? opts.slotMap : null;
  const used = new Set();
  if (explicit) {
    for (const id of sorted) {
      const raw = explicit[id];
      if (raw === undefined) {
        continue;
      }
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new MavlinkError('BAD_SLOT', `Slot index for sysid ${id} must be a non-negative integer (got ${JSON.stringify(raw)}).`, {
          sysid: id,
          slot: raw
        });
      }
      /**
       * Two vehicles mapped to the same slot would be commanded to the same
       * position — a collision, not a formation. Fail closed rather than silently
       * stacking them (CodeRabbit review on #244).
       */
      if (used.has(idx)) {
        throw new MavlinkError('BAD_SLOT', `Slot index ${idx} is assigned to more than one vehicle.`, {
          sysid: id,
          slot: idx
        });
      }
      map.set(id, idx);
      used.add(idx);
    }
  }
  let next = startSlot;
  for (const id of sorted) {
    if (map.has(id)) {
      continue;
    }
    while (used.has(next)) {
      next += 1;
    }
    map.set(id, next);
    used.add(next);
  }
  return map;
}

/**
 * Build one global position target per vehicle from a formation shape.
 *
 * @param {object} opts
 * @param {string} opts.shape           one of {@link SHAPES}
 * @param {number} opts.spacing         meters between slots
 * @param {{lat: number, lon: number, alt: number}} opts.anchor  reference position
 *   (float degrees, alt required — every target inherits it so the formation is
 *   level; a `0` altitude would command a descent to sea level, so it is not a
 *   safe default)
 * @param {number} [opts.headingDeg=0]  rotates the whole pattern
 * @param {Array<number|string>} opts.sysids  vehicles to position
 * @param {Object<string, number>} [opts.slotMap]  explicit slot assignment
 * @param {number} [opts.startSlot=0]   lowest auto-assigned slot (1 reserves the
 *   anchor's own slot for a leader in follow-leader mode)
 * @returns {Array<{sysid: number, lat: number, lon: number, alt: number}>}
 * @throws {MavlinkError} BAD_ANCHOR / NO_TARGETS / BAD_FORMATION / BAD_SLOT
 */
function formationTargets(opts) {
  const { shape, spacing, anchor, headingDeg = 0, sysids, slotMap, startSlot } = opts;
  if (!anchor || anchor.lat === undefined || anchor.lon === undefined) {
    throw new MavlinkError('BAD_ANCHOR', 'Formation needs an anchor { lat, lon, alt }.');
  }
  if (anchor.alt === undefined || anchor.alt === null || anchor.alt === '') {
    throw new MavlinkError('BAD_ANCHOR', 'Formation anchor needs an altitude — a level formation inherits it, and 0 would command a descent to sea level.', {
      anchor
    });
  }
  const ids = [...new Set((sysids || []).map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  if (!ids.length) {
    throw new MavlinkError('NO_TARGETS', 'Formation needs at least one vehicle sysid.');
  }
  const assign = assignSlots(ids, { slotMap, startSlot });
  const maxSlot = Math.max(...assign.values());
  const offsets = slotOffsets(shape, maxSlot + 1, spacing);
  return ids.map((id) => {
    const ned = bodyToNed(offsets[assign.get(id)], headingDeg);
    const global = nedOffsetToGlobal(anchor, { north: ned.north, east: ned.east, down: ned.down });
    return { sysid: id, lat: global.lat, lon: global.lon, alt: global.alt };
  });
}

/**
 * Pick the successor leader when the current one goes stale: the next present
 * sysid above the current leader, wrapping to the lowest — this is the robust
 * reading of "leader = leader + 1". `available` should already exclude stale
 * vehicles, so a promoted leader is one that is actually reporting.
 *
 * @param {number} current   the (now stale) leader sysid
 * @param {Array<number|string>} available  candidate sysids (non-stale)
 * @returns {?number} the new leader sysid, or null if there is no other vehicle
 */
function nextLeaderSysid(current, available) {
  const cur = Number(current);
  const others = [...new Set((available || []).map(Number).filter((n) => Number.isFinite(n) && n !== cur))].sort(
    (a, b) => a - b
  );
  if (!others.length) {
    return null;
  }
  const higher = others.find((id) => id > cur);
  return higher !== undefined ? higher : others[0];
}

/**
 * Horizontal distance in meters between two global positions (flat-earth), used
 * to gate follow-leader re-emits on a minimum-move threshold.
 *
 * @param {{lat: number, lon: number}} a
 * @param {{lat: number, lon: number}} b
 * @returns {number} meters
 */
function moveDistanceMeters(a, b) {
  const { north, east } = globalToNedOffset({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
  return Math.hypot(north, east);
}

module.exports = {
  SHAPES,
  slotOffsets,
  bodyToNed,
  assignSlots,
  formationTargets,
  nextLeaderSysid,
  moveDistanceMeters
};
