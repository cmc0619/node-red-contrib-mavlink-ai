'use strict';

/**
 * Build the connection status payload (DESIGN.md §14.4): the structured state
 * carried on the connection's internal `status` event and rendered as the node
 * badge. Not a flow message — status is never emitted onto a wire (§14.4).
 */
function statusPayload({ node, connection, state, transport, detail }) {
  const payload = {
    node,
    state,
    timestamp: Date.now()
  };
  if (connection !== undefined) {
    payload.connection = connection;
  }
  if (transport !== undefined) {
    payload.transport = transport;
  }
  if (detail !== undefined) {
    payload.detail = detail;
  }
  return payload;
}

/**
 * Map a high-level connection/profile state to a Node-RED status badge
 * ({ fill, shape, text }). Keeps badge colours consistent across nodes.
 */
function badgeForState(state, text) {
  const map = {
    connected: { fill: 'green', shape: 'dot' },
    listening: { fill: 'green', shape: 'dot' },
    connecting: { fill: 'yellow', shape: 'ring' },
    reconnecting: { fill: 'yellow', shape: 'ring' },
    idle: { fill: 'grey', shape: 'ring' },
    closed: { fill: 'grey', shape: 'ring' },
    disabled: { fill: 'grey', shape: 'ring' },
    error: { fill: 'red', shape: 'ring' },
    invalid: { fill: 'red', shape: 'ring' }
  };
  const base = map[state] || { fill: 'grey', shape: 'ring' };
  return { fill: base.fill, shape: base.shape, text: text || state };
}

/**
 * Cap node status badge text so it stays glanceable and does not truncate
 * mid-glyph in the editor (#221). Node-RED badges are a status indicator, not
 * a data channel — the full detail lives on the node's structured outputs and
 * in the runtime log. Overlong text (a MAVLink message/command name, an error
 * code, a param id) is cut to `maxLen - 1` characters plus a single-glyph
 * ellipsis so the result is never longer than `maxLen`.
 *
 * @param {*} text  the badge text (coerced to string; null/undefined → '')
 * @param {number} [maxLen=24]  maximum result length in characters
 * @returns {string}
 */
function truncateStatus(text, maxLen = 24) {
  const s = text === null || text === undefined ? '' : String(text);
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen - 1)}…`;
}

module.exports = {
  statusPayload,
  badgeForState,
  truncateStatus
};
