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
 * Send-rejection codes where THIS side is a listener/server passively waiting
 * for the other party to appear — a udp-peer waiting to learn a peer, a TCP
 * server waiting for a client. These recover on their own no matter how the
 * connection is configured (the socket keeps listening), so a fire-and-forget
 * sender (the Out node) badges a "waiting for link" status and warns at most
 * once instead of erroring on every send.
 *
 * Deliberately NOT included: TCP_NOT_CONNECTED and SERIAL_NOT_OPEN, which only
 * recover when Reconnect is enabled — with reconnect off, that link is
 * permanently down and a send must surface it; TRANSPORT_NOT_READY (the
 * transport is null — often a permanent failed start); and QUEUE_CLEARED (a
 * genuine cancel). Swallowing any of those would hide an unrecoverable link
 * from Catch nodes.
 *
 * @type {Set<string>}
 */
const TRANSPORT_WAITING_CODES = new Set(['UDP_NO_PEER', 'TCP_NO_CLIENT']);

/**
 * Send-rejection codes the periodic heartbeat treats as normal idle/teardown:
 * the always-recoverable waiting codes above, PLUS the config-dependent /
 * teardown ones (TCP_NOT_CONNECTED, SERIAL_NOT_OPEN, TRANSPORT_NOT_READY,
 * QUEUE_CLEARED). The heartbeat can silently retry all of these — they are
 * already surfaced elsewhere (the connection reports disconnects and fatal
 * start errors; QUEUE_CLEARED means it is deactivating), and re-emitting them
 * every tick would only spam. A fire-and-forget Out send uses the narrower
 * {@link TRANSPORT_WAITING_CODES} so an unrecoverable link still errors.
 *
 * @type {Set<string>}
 */
const TRANSPORT_NOT_READY_CODES = new Set([
  ...TRANSPORT_WAITING_CODES,
  'TCP_NOT_CONNECTED',
  'SERIAL_NOT_OPEN',
  'TRANSPORT_NOT_READY',
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
  TRANSPORT_WAITING_CODES,
  TRANSPORT_NOT_READY_CODES
};
