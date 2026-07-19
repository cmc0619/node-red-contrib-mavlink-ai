'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeAssertion, resolveHeartbeatStatus, HEALTH_STATES } = require('../../lib/health/advertised-health');

test('normalizeAssertion computes expires_at from ttl_s and keeps the note', () => {
  const r = normalizeAssertion({ health: 'nominal', ttl_s: 10, note: 'planner ok' }, 1000);
  assert.deepStrictEqual(r, { state: 'nominal', note: 'planner ok', expires_at: 11000 });
});

test('normalizeAssertion rejects an unknown health state', () => {
  assert.throws(() => normalizeAssertion({ health: 'fine', ttl_s: 10 }, 0), (e) => e.code === 'INVALID_HEALTH');
});

test('normalizeAssertion requires a positive ttl_s for a non-fatal assertion (fail-closed)', () => {
  assert.throws(() => normalizeAssertion({ health: 'nominal' }, 0), (e) => e.code === 'INVALID_HEALTH');
  assert.throws(() => normalizeAssertion({ health: 'degraded', ttl_s: 0 }, 0), (e) => e.code === 'INVALID_HEALTH');
  assert.throws(() => normalizeAssertion({ health: 'nominal', ttl_s: -5 }, 0), (e) => e.code === 'INVALID_HEALTH');
});

test('normalizeAssertion allows fatal with no ttl_s (persists until replaced)', () => {
  const r = normalizeAssertion({ health: 'fatal', note: 'planner crash' }, 500);
  assert.deepStrictEqual(r, { state: 'fatal', note: 'planner crash', expires_at: null });
});

test('resolveHeartbeatStatus maps each state and honors expiry', () => {
  assert.deepStrictEqual(resolveHeartbeatStatus(undefined, 0), { status: 'MAV_STATE_STANDBY' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'nominal', expires_at: 100 }, 50), { status: 'MAV_STATE_ACTIVE' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'degraded', expires_at: 100 }, 50), { status: 'MAV_STATE_CRITICAL' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'emergency', expires_at: 100 }, 50), { status: 'MAV_STATE_EMERGENCY' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'fatal', expires_at: null }, 50), { stop: true });
  /** An expired non-fatal lease must never look healthy → CRITICAL. */
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'nominal', expires_at: 100 }, 101), { status: 'MAV_STATE_CRITICAL' });
  /** Fail-closed at the exact boundary: now === expires_at is already expired. */
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'nominal', expires_at: 100 }, 100), { status: 'MAV_STATE_CRITICAL' });
});

test('HEALTH_STATES lists the four contract states', () => {
  assert.deepStrictEqual(HEALTH_STATES, ['nominal', 'degraded', 'emergency', 'fatal']);
});
