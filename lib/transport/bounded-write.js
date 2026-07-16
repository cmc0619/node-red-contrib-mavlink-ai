'use strict';

/**
 * Run a callback-style transport write with a settle-once completion deadline
 * (#237). One stalled write — a dead serial device, a wedged socket — would
 * otherwise hold the shared outbound drain loop open forever: the queue fills
 * to its cap and every later send (heartbeats, emergency commands) rejects.
 * TCP writes have carried this bound since #147; this extracts the pattern so
 * serial and UDP share it instead of re-implementing the settle-once
 * subtleties.
 *
 * A callback that fires after the deadline is ignored (settle once), so a
 * late completion can never double-settle the promise or resurrect an item
 * the caller already treated as failed. The timer is unref'd so a pending
 * write never holds the process open.
 *
 * @param {object} opts
 * @param {function(function(?Error): void): void} opts.write  perform the
 *   write, invoking the node-style callback on completion
 * @param {number} opts.timeoutMs  completion deadline
 * @param {function(): Error} opts.timeoutError  build the structured timeout
 *   error; side effects (e.g. kicking a stalled client) belong here
 * @param {function(Error): Error} opts.wrapError  wrap a write-callback error
 *   into the transport's structured error
 * @returns {Promise<void>}
 */
function boundedWrite({ write, timeoutMs, timeoutError, wrapError }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(timeoutError());
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    write((err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(wrapError(err));
      } else {
        resolve();
      }
    });
  });
}

const DEFAULT_WRITE_TIMEOUT_MS = 5000;

module.exports = { boundedWrite, DEFAULT_WRITE_TIMEOUT_MS };
