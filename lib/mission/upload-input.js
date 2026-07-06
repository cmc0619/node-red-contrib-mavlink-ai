'use strict';

const { MavlinkError } = require('../util/errors');
const { validateLatitude, validateLongitude } = require('../util/field-validation');

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
 * Validate mission upload items before a transfer starts (#55): each item must
 * be an object with a command, and any `lat`/`lon` must be in range. Runs after
 * {@link normalizeUploadItems}, so bare waypoints already have their default
 * command. Throws a structured INVALID_FIELD error naming the offending item.
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
    if (item.command === undefined || item.command === null || item.command === '') {
      throw new MavlinkError('INVALID_FIELD', `Mission item ${seq} has no command.`, { seq, field: 'command' });
    }
    if (item.lat !== undefined) {
      validateLatitude(item.lat, { seq });
    }
    if (item.lon !== undefined) {
      validateLongitude(item.lon, { seq });
    }
  });
  return items;
}

module.exports = { topicAction, normalizeUploadItems, validateMissionItems };
