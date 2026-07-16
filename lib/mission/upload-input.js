'use strict';

const { MavlinkError } = require('../util/errors');
const { validateLatitude, validateLongitude, requireFinite, requireIntRange } = require('../util/field-validation');

/**
 * Friendly mission-input parsing (issue #56), kept in lib so it is unit-testable
 * without standing up the whole node. These are the Aigen-compatibility
 * conveniences: a topic alias for the action, a `waypoints` alias for `items`,
 * and a default command for bare waypoints. It also holds the stricter upload
 * item validation for issue #55.
 */

/**
 * Map an Aigen-style topic to a mission action. Returns undefined for any other
 * topic so it doesn't shadow an unrelated upstream topic.
 *
 * @param {*} topic
 * @returns {?string}
 */
function topicAction(topic) {
  switch (topic) {
    case 'upload_mission':
      return 'upload';
    case 'download_mission':
      return 'download';
    case 'clear_mission':
      return 'clear';
    default:
      return undefined;
  }
}

/**
 * Resolve the upload item list from a payload, accepting the friendly `waypoints`
 * alias for `items`. A simple waypoint entry — `lat`/`lon` (and optional `alt`)
 * with no explicit `command` — defaults to `MAV_CMD_NAV_WAYPOINT` so
 * `{ lat, lon, alt }` uploads a normal waypoint. The advanced `items` shape
 * (explicit command/params/raw x-y/frame) is unchanged and takes precedence when
 * both `items` and `waypoints` are present.
 *
 * @param {object} payload
 * @returns {object[]}
 */
function normalizeUploadItems(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const raw = Array.isArray(p.items) ? p.items : Array.isArray(p.waypoints) ? p.waypoints : [];
  return raw.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }
    const out = Object.assign({}, item);
    if (out.command === undefined && out.lat !== undefined && out.lon !== undefined) {
      out.command = 'MAV_CMD_NAV_WAYPOINT';
    }
    return out;
  });
}

/**
 * Resolve the upload item array, rejecting the malformed shapes that would
 * otherwise be silently treated as an empty mission — which the mission spec
 * uploads as `MISSION_COUNT 0`, erasing the on-vehicle mission (#236). A missing
 * or non-array `items`/`waypoints` is a wiring/config error (a typo'd or
 * absent payload), not a clear request. An explicit empty array clears only when
 * `allowEmpty` is set — the node maps this to a documented `allow_empty` flag —
 * so a malformed payload can never wipe the mission when a separate explicit
 * `clear` action exists for that.
 *
 * @param {object} payload
 * @param {object} [opts]
 * @param {boolean} [opts.allowEmpty=false]  permit an explicit empty upload (which clears)
 * @returns {object[]} the raw item array (before normalization)
 * @throws {MavlinkError} MISSION_NO_ITEMS | MISSION_ITEMS_NOT_ARRAY | MISSION_EMPTY_UPLOAD
 */
function resolveUploadItems(payload, { allowEmpty = false } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const key = p.items !== undefined ? 'items' : p.waypoints !== undefined ? 'waypoints' : null;
  if (key === null) {
    throw new MavlinkError(
      'MISSION_NO_ITEMS',
      'Mission upload requires an items (or waypoints) array. Use the clear action to erase the on-vehicle mission.',
      {}
    );
  }
  const raw = p[key];
  if (!Array.isArray(raw)) {
    throw new MavlinkError(
      'MISSION_ITEMS_NOT_ARRAY',
      `Mission upload '${key}' must be an array (got ${raw === null ? 'null' : typeof raw}).`,
      { field: key, type: raw === null ? 'null' : typeof raw }
    );
  }
  if (raw.length === 0 && !allowEmpty) {
    throw new MavlinkError(
      'MISSION_EMPTY_UPLOAD',
      'Refusing to upload an empty mission — that would clear the on-vehicle mission. Use the clear action, or set allow_empty to confirm.',
      {}
    );
  }
  return raw;
}

/**
 * The explicit NaN sentinels {@link keepNanParam} (mission-upload.js) honors as a
 * first-class "use default / keep current" value: `null`, a NaN number, or a
 * "NaN" string. These must pass validation on the fields that allow them rather
 * than be rejected as non-finite.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isNanSentinel(v) {
  return (
    v === null ||
    (typeof v === 'number' && Number.isNaN(v)) ||
    (typeof v === 'string' && v.trim().toLowerCase() === 'nan')
  );
}

/** Fields buildItemFields runs through keepNanParam — a NaN sentinel is allowed. */
const NAN_NUMERIC_FIELDS = ['param1', 'param2', 'param3', 'param4', 'x', 'y'];
/** Coordinate/altitude fields sent raw — a finite number is required (no NaN). */
const FINITE_FIELDS = ['z', 'alt'];
/** 0/1 flags. */
const FLAG_FIELDS = ['current', 'autocontinue'];

/**
 * Validate mission upload items before a transfer starts (#55, #236): each item
 * must be an object with a valid command, and every field it carries is checked
 * against its MAVLink wire type so non-numeric garbage is rejected up front
 * rather than silently defaulted to 0 by keepNanParam / buildItemFields. Runs
 * after {@link normalizeUploadItems}, so bare waypoints already have their
 * default command. Explicit NaN sentinels are preserved on the fields that allow
 * them (PX4's "keep current"); a present-but-non-numeric value fails.
 *
 * @param {object[]} items
 * @returns {object[]} the same items (for chaining)
 * @throws {MavlinkError} INVALID_FIELD
 */
function validateMissionItems(items) {
  (items || []).forEach((item, seq) => {
    if (!item || typeof item !== 'object') {
      throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} must be an object.`, { seq, value: item });
    }
    const c = item.command;
    if (c === undefined || c === null || (typeof c === 'string' && c.trim() === '')) {
      throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} has no command.`, { seq, field: 'command' });
    }
    if (!((typeof c === 'number' && Number.isFinite(c)) || (typeof c === 'string' && c.trim() !== ''))) {
      throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} command must be a MAV_CMD number or name (got ${JSON.stringify(c)}).`, {
        seq,
        field: 'command',
        value: c
      });
    }
    if (item.lat !== undefined) {
      validateLatitude(item.lat, { seq });
    }
    if (item.lon !== undefined) {
      validateLongitude(item.lon, { seq });
    }
    if (item.frame !== undefined) {
      const fr = item.frame;
      const okFrame = (typeof fr === 'number' && Number.isFinite(fr)) || (typeof fr === 'string' && fr.trim() !== '');
      if (!okFrame) {
        throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} frame must be a MAV_FRAME number or name (got ${JSON.stringify(fr)}).`, {
          seq,
          field: 'frame',
          value: fr
        });
      }
    }
    for (const field of NAN_NUMERIC_FIELDS) {
      if (item[field] !== undefined && !isNanSentinel(item[field])) {
        requireFinite(item[field], field, { seq });
      }
    }
    for (const field of FINITE_FIELDS) {
      if (item[field] !== undefined) {
        requireFinite(item[field], field, { seq });
      }
    }
    for (const field of FLAG_FIELDS) {
      if (item[field] !== undefined) {
        requireIntRange(item[field], field, 0, 1, { seq });
      }
    }
  });
  return items;
}

module.exports = { topicAction, normalizeUploadItems, resolveUploadItems, validateMissionItems };
