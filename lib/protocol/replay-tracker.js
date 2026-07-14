'use strict';

const { MavLinkProtocolV2 } = require('node-mavlink');

/**
 * MAVLink 2 signing anti-replay (issue #100).
 *
 * The signing spec discards a validly signed frame if either:
 *  - its timestamp is **older than the previous frame** on its signing stream —
 *    the `(sysid, compid, link_id)` tuple (the monotonic rule); or
 *  - its timestamp is **more than one minute behind the receiver's current
 *    clock** (the freshness window).
 *
 * The freshness window is what makes a captured frame replayed later drop even
 * with no per-stream memory (e.g. right after a restart), so no durable state is
 * needed: the monotonic rule catches replays *within* the minute, the freshness
 * window catches everything older. State is therefore purely in-memory.
 *
 * Timestamps are 10 µs units since 2015-01-01 (the same epoch frames are stamped
 * with), so "now" is derived identically and the two are directly comparable.
 */

/** Freshness window: reject frames more than 1 minute (6,000,000 units) old. */
const FRESHNESS_WINDOW_UNITS = 6_000_000;

/**
 * Current time as a MAVLink signing timestamp (10 µs units since 2015-01-01),
 * computed the same way node-mavlink stamps outbound frames.
 *
 * @returns {number}
 */
function currentSigningTimestamp() {
  return (Date.now() - MavLinkProtocolV2.SIGNATURE_START_TIME) * 100;
}

class ReplayTracker {
  constructor() {
    /** "sysid:compid:linkId" -> highest accepted 48-bit timestamp. */
    this._max = new Map();
  }

  /**
   * Apply the freshness and monotonic rules to one verified signed frame.
   *
   * @param {number} sysid
   * @param {number} compid
   * @param {number} linkId
   * @param {number} timestamp  48-bit signing timestamp
   * @param {number} [now]  current signing timestamp; injectable for tests
   * @returns {{accepted: boolean, reason: string}} `signature-valid` when fresh
   *   and advancing its stream; `signature-replayed` otherwise
   */
  check(sysid, compid, linkId, timestamp, now = currentSigningTimestamp()) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return { accepted: false, reason: 'signature-replayed' };
    }
    /**
     * Freshness window: a timestamp far behind the wall clock is a stale/replayed
     * frame, caught even with no stored per-stream state.
     */
    if (Number.isFinite(now) && ts < now - FRESHNESS_WINDOW_UNITS) {
      return { accepted: false, reason: 'signature-replayed' };
    }
    /** Monotonic rule: within the window, a non-advancing timestamp is a replay. */
    const stream = `${sysid}:${compid}:${linkId}`;
    const last = this._max.get(stream);
    if (last !== undefined && ts <= last) {
      return { accepted: false, reason: 'signature-replayed' };
    }
    this._max.set(stream, ts);
    return { accepted: true, reason: 'signature-valid' };
  }
}

module.exports = { ReplayTracker, currentSigningTimestamp, FRESHNESS_WINDOW_UNITS };
