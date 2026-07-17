'use strict';

/**
 * Build the canonical `mavlink/status` message payload (DESIGN.md §14.4).
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
    error: { fill: 'red', shape: 'ring' },
    invalid: { fill: 'red', shape: 'ring' }
  };
  const base = map[state] || { fill: 'grey', shape: 'ring' };
  return { fill: base.fill, shape: base.shape, text: text || state };
}

module.exports = {
  statusPayload,
  badgeForState
};
