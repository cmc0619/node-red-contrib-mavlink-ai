'use strict';

/**
 * Structured MAVLink error. Carries a stable machine-readable `code` plus
 * optional `context` so logs stop turning into haunted furniture.
 *
 * See DESIGN.md §14.5 and §25.
 */
class MavlinkError extends Error {
  constructor(code, message, context) {
    super(message || code);
    this.name = 'MavlinkError';
    this.code = code || 'MAVLINK_ERROR';
    this.context = context || {};
  }
}

/**
 * Send-rejection codes that mean "the transport can't deliver yet", not a real
 * failure — a udp-peer with no learned peer, a TCP server with no client, a
 * serial port mid-open, or a queue cleared by a redeploy. These are expected
 * transient states for a fire-and-forget sender: they should badge a "waiting"
 * status and (at most) warn once, never spam the error output on every send.
 * The heartbeat scheduler already treats them as idle; the Out node reuses this.
 *
 * @type {Set<string>}
 */
const TRANSPORT_NOT_READY_CODES = new Set([
  'UDP_NO_PEER',
  'TRANSPORT_NOT_READY',
  'TCP_NO_CLIENT',
  'TCP_NOT_CONNECTED',
  'SERIAL_NOT_OPEN',
  'QUEUE_CLEARED'
]);

/**
 * Build the canonical `mavlink/error` message payload (DESIGN.md §14.5).
 *
 * @param {object} opts
 * @param {string} opts.node      registering node type, e.g. "mavlink-ai-mission"
 * @param {string} [opts.connection] connection display name
 * @param {string} opts.code      stable error code, e.g. "MISSION_TIMEOUT"
 * @param {string} opts.message   human readable message
 * @param {object} [opts.context] extra structured context
 */
function errorPayload({ node, connection, code, message, context }) {
  const payload = {
    node,
    code: code || 'MAVLINK_ERROR',
    message: message || 'Unknown MAVLink error'
  };
  if (connection !== undefined) {
    payload.connection = connection;
  }
  if (context && Object.keys(context).length) {
    payload.context = context;
  }
  return payload;
}

/**
 * Wrap an error payload in the standard `{ topic, payload }` message envelope.
 */
function errorMessage(opts) {
  return { topic: 'mavlink/error', payload: errorPayload(opts) };
}

/**
 * Normalize any thrown value into a MavlinkError without losing its code.
 */
function toMavlinkError(err, fallbackCode) {
  if (err instanceof MavlinkError) {
    return err;
  }
  const code = (err && err.code) || fallbackCode || 'MAVLINK_ERROR';
  return new MavlinkError(code, (err && err.message) || String(err));
}

module.exports = {
  MavlinkError,
  errorPayload,
  errorMessage,
  toMavlinkError,
  TRANSPORT_NOT_READY_CODES
};
