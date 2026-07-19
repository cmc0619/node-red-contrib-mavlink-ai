'use strict';

/**
 * Advertised-health contract for the outbound HEARTBEAT (#225). A flow asserts
 * the health of its own onboard function; this pure module turns that assertion
 * into a stored record and, later, into a heartbeat `system_status` (or a signal
 * to stop heartbeating). No Node-RED, transport, or connection dependency; the
 * caller supplies the wall clock `now`.
 */

/** The four health states a flow may assert, in escalating severity. */
const HEALTH_STATES = ['nominal', 'degraded', 'emergency', 'fatal'];

/** Non-fatal, non-expired health state → HEARTBEAT system_status. */
const STATUS_BY_STATE = {
  nominal: 'MAV_STATE_ACTIVE',
  degraded: 'MAV_STATE_CRITICAL',
  emergency: 'MAV_STATE_EMERGENCY'
};

/**
 * Validate and normalize a raw health assertion into a stored record.
 *
 * @param {{health: string, ttl_s?: number, note?: string}} input
 * @param {number} now  wall clock (ms)
 * @returns {{state: string, note: ?string, expires_at: ?number}}
 * @throws {Error} with `.code === 'INVALID_HEALTH'` on a bad state or, for a
 *   non-fatal state, a missing/non-positive ttl_s (fail-closed lease).
 */
function normalizeAssertion(input, now) {
  const state = input && input.health;
  if (!HEALTH_STATES.includes(state)) {
    const err = new Error(`health must be one of ${HEALTH_STATES.join(', ')}`);
    err.code = 'INVALID_HEALTH';
    throw err;
  }
  const note = input.note === undefined || input.note === null ? null : String(input.note);
  if (state === 'fatal') {
    return { state, note, expires_at: null };
  }
  const ttl = Number(input.ttl_s);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    const err = new Error('a non-fatal health assertion requires a positive ttl_s (an expired or lease-less claim must never look healthy)');
    err.code = 'INVALID_HEALTH';
    throw err;
  }
  return { state, note, expires_at: now + ttl * 1000 };
}

/**
 * Resolve a stored assertion record to a heartbeat outcome.
 *
 * @param {?{state: string, expires_at: ?number}} record  or undefined if never asserted
 * @param {number} now  wall clock (ms)
 * @returns {{status: string}|{stop: true}} a status to stamp, or a stop signal
 *   (fatal: a faulted component must not keep heartbeating as if healthy).
 */
function resolveHeartbeatStatus(record, now) {
  if (!record) {
    return { status: 'MAV_STATE_STANDBY' };
  }
  if (record.state === 'fatal') {
    return { stop: true };
  }
  if (record.expires_at != null && now >= record.expires_at) {
    return { status: 'MAV_STATE_CRITICAL' };
  }
  return { status: STATUS_BY_STATE[record.state] || 'MAV_STATE_STANDBY' };
}

module.exports = { normalizeAssertion, resolveHeartbeatStatus, HEALTH_STATES };
