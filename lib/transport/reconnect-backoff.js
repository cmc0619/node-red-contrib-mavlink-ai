'use strict';

const { MavlinkError } = require('../util/errors');

/**
 * Shared reconnect backoff for the transports (#149), extracted from three
 * line-for-line copies the parity PRs (#174/#175) left in udp/tcp/serial.
 * Like bounded-write (#237), the retry policy is transport-agnostic and lives
 * once: exponential backoff capped at {@link RECONNECT_MAX_DELAY_MS}, plus
 * random jitter so several connections retrying in lockstep desynchronize
 * instead of hammering a port together.
 */

/** Cap on the exponential backoff so retries stay responsive. */
const RECONNECT_MAX_DELAY_MS = 30000;

/** Fraction of the backoff delay added as random jitter to desynchronize retries. */
const RECONNECT_JITTER_FRACTION = 0.3;

/**
 * Schedule the transport's next start() attempt with backoff + jitter.
 *
 * The transport contract: `reconnectDelayMs`, `_reconnectAttempts` (reset to 0
 * by the transport on a successful start), `_reconnectTimer`, `_closing`, a
 * `start()` method, and 'reconnecting'/'error' events. A synchronous throw
 * from start() inside the timer callback would be an uncaughtException killing
 * the whole Node-RED process — it is surfaced as a transport error and the
 * retry loop continues instead.
 *
 * @param {object} transport  the udp/tcp/serial transport instance
 * @param {string} errorCode  transport error code for a throwing start()
 * @param {function(): object} [context]  lazy error context ({bindPort}/{path})
 * @returns {void}
 */
function scheduleReconnect(transport, errorCode, context) {
  transport.emit('reconnecting');
  clearTimeout(transport._reconnectTimer);
  const base = Math.min(transport.reconnectDelayMs * 2 ** transport._reconnectAttempts, RECONNECT_MAX_DELAY_MS);
  const delay = base + Math.floor(Math.random() * base * RECONNECT_JITTER_FRACTION);
  transport._reconnectAttempts += 1;
  transport._reconnectTimer = setTimeout(() => {
    if (transport._closing) {
      return;
    }
    try {
      transport.start();
    } catch (err) {
      transport.emit(
        'error',
        new MavlinkError(errorCode, err && err.message ? err.message : String(err), context ? context() : undefined)
      );
      scheduleReconnect(transport, errorCode, context);
    }
  }, delay);
  if (transport._reconnectTimer && typeof transport._reconnectTimer.unref === 'function') {
    transport._reconnectTimer.unref();
  }
}

module.exports = { scheduleReconnect, RECONNECT_MAX_DELAY_MS, RECONNECT_JITTER_FRACTION };
