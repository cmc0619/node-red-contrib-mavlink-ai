'use strict';

const { MavlinkError } = require('../util/errors');
const { validateLatitude, validateLongitude, requireFinite, requireIntRange } = require('../util/field-validation');
const enumResolver = require('../protocol/enum-resolver');

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

/**
 * Float param fields buildItemFields runs through keepNanParam — a NaN sentinel
 * ("use default / keep current") is allowed. Raw x/y are deliberately NOT here:
 * on the MISSION_ITEM_INT path they are int32 fields, so a NaN can't encode and
 * would fail only after MISSION_COUNT has started the handshake — they require a
 * finite value up front instead.
 */
const NAN_NUMERIC_FIELDS = ['param1', 'param2', 'param3', 'param4'];
/** Coordinate fields sent raw — a finite number is required (no NaN sentinel). */
const FINITE_FIELDS = ['x', 'y', 'z', 'alt'];
/** 0/1 flags. */
const FLAG_FIELDS = ['current', 'autocontinue'];

/**
 * When an enum-backed id field carries a NUMERIC value (a number or a numeric
 * string), require the wire type's integer range up front: MISSION_ITEM(_INT)
 * carries `command` as uint16 and `frame` as uint8, so a fractional (16.5) or
 * out-of-range id passes enum resolution untouched and would fail encoding only
 * after MISSION_COUNT has started the handshake. A non-numeric string is a NAME
 * — enum resolution handles those.
 *
 * @param {*} value
 * @param {string} field
 * @param {number} max   inclusive unsigned upper bound of the wire type
 * @param {number} seq
 * @returns {void}
 * @throws {MavlinkError} INVALID_FIELD
 */
function checkNumericEnumId(value, field, max, seq) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return;
  }
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new MavlinkError(
      'INVALID_FIELD',
      `Mission item ${seq} ${field} must be an integer 0..${max} (got ${JSON.stringify(value)}).`,
      { seq, field, value }
    );
  }
}

/**
 * Validate mission upload items before a transfer starts (#55, #236): each item
 * must be an object with a valid command, and every field it carries is checked
 * against its MAVLink wire type so non-numeric garbage is rejected up front
 * rather than silently defaulted to 0 by keepNanParam / buildItemFields. Runs
 * after {@link normalizeUploadItems}, so bare waypoints already have their
 * default command. Explicit NaN sentinels are preserved on the fields that allow
 * them (PX4's "keep current"); a present-but-non-numeric value fails. When the
 * active dialect `enums` are provided, a command NAME must resolve against them,
 * so a typo fails here — before MISSION_COUNT and the transfer — rather than
 * later in codec.encode mid-handshake, leaving the vehicle in a partial upload.
 *
 * @param {object[]} items
 * @param {object} [enums]  active dialect enum index for MAV_CMD name resolution
 * @returns {object[]} the same items (for chaining)
 * @throws {MavlinkError} INVALID_FIELD
 */
function validateMissionItems(items, enums) {
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
    /** command rides MISSION_ITEM(_INT) as uint16 — a numeric id must fit it. */
    checkNumericEnumId(c, 'command', 0xffff, seq);
    if (enums) {
      /** Resolve a command NAME against the MavCmd enum ONLY: a numeric/custom id
       * passes through, a known MAV_CMD name maps to its number, and a name from
       * another enum (e.g. a MAV_FRAME_* string) or a typo returns undefined —
       * reject it before the transfer starts rather than uploading a wrong id. */
      const resolved = enumResolver.resolveInEnum(enums, 'MavCmd', c);
      if (!Number.isFinite(Number(resolved))) {
        throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} command '${c}' is not a known MAV_CMD in the active dialect.`, {
          seq,
          field: 'command',
          value: c
        });
      }
    }
    if (item.lat !== undefined) {
      validateLatitude(item.lat, { seq });
    }
    if (item.lon !== undefined) {
      validateLongitude(item.lon, { seq });
    }
    if (item.frame !== undefined) {
      const fr = item.frame;
      /** frame rides MISSION_ITEM(_INT) as uint8 — a numeric id must fit it. */
      checkNumericEnumId(fr, 'frame', 0xff, seq);
      if (enums) {
        /** Resolve a frame NAME against MavFrame only; a numeric/custom id passes
         * if it is an integer. frame is an int MAVLink enum, so a non-integer
         * (3.5) or a typoed name is rejected here rather than after MISSION_COUNT
         * when the encoder normalizes the field. */
        const resolvedFrame = enumResolver.resolveInEnum(enums, 'MavFrame', fr);
        if (!Number.isInteger(Number(resolvedFrame))) {
          throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} frame '${fr}' is not a known MAV_FRAME in the active dialect.`, {
            seq,
            field: 'frame',
            value: fr
          });
        }
      } else if (!((typeof fr === 'number' && Number.isInteger(fr)) || (typeof fr === 'string' && fr.trim() !== ''))) {
        throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} frame must be a MAV_FRAME integer or name (got ${JSON.stringify(fr)}).`, {
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
