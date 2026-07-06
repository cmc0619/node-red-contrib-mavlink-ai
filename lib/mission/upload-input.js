'use strict';

/**
 * Friendly mission-input parsing (issue #56), kept in lib so it is unit-testable
 * without standing up the whole node. These are the Aigen-compatibility
 * conveniences: a topic alias for the action, a `waypoints` alias for `items`,
 * and a default command for bare waypoints.
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

module.exports = { topicAction, normalizeUploadItems };
