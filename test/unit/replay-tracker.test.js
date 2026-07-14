'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ReplayTracker, FRESHNESS_WINDOW_UNITS } = require('../../lib/protocol/replay-tracker');

/**
 * A fixed "now" well above the small timestamps used in the monotonic tests, so
 * the freshness window never trips there and the monotonic rule is isolated.
 */
const NOW = 10_000;

test('first frame per stream is accepted', () => {
  const t = new ReplayTracker();
  assert.deepStrictEqual(t.check(1, 1, 0, 1000, NOW), { accepted: true, reason: 'signature-valid' });
});

test('an exact replay and any older timestamp are rejected', () => {
  const t = new ReplayTracker();
  t.check(1, 1, 0, 1000, NOW);
  /** Equal counts as a replay (must be strictly greater). */
  assert.strictEqual(t.check(1, 1, 0, 1000, NOW).reason, 'signature-replayed');
  assert.strictEqual(t.check(1, 1, 0, 999, NOW).reason, 'signature-replayed');
});

test('a newer timestamp advances the stream and is accepted', () => {
  const t = new ReplayTracker();
  t.check(1, 1, 0, 1000, NOW);
  assert.strictEqual(t.check(1, 1, 0, 1001, NOW).accepted, true);
  /** 1000 is now stale relative to the advanced 1001. */
  assert.strictEqual(t.check(1, 1, 0, 1000, NOW).accepted, false);
});

test('independent (sysid, compid, linkId) streams do not interfere', () => {
  const t = new ReplayTracker();
  t.check(1, 1, 0, 5000, NOW);
  /** Differing sysid, compid, or linkId are all distinct streams. */
  assert.strictEqual(t.check(2, 1, 0, 10, NOW).accepted, true);
  assert.strictEqual(t.check(1, 2, 0, 10, NOW).accepted, true);
  assert.strictEqual(t.check(1, 1, 9, 10, NOW).accepted, true);
});

test('a non-finite timestamp is rejected, not silently advanced', () => {
  const t = new ReplayTracker();
  assert.strictEqual(t.check(1, 1, 0, NaN, NOW).accepted, false);
  /** The stream was never advanced by the NaN, so a real timestamp still passes. */
  assert.strictEqual(t.check(1, 1, 0, 1, NOW).accepted, true);
});

test('the freshness window rejects a timestamp far behind the current clock', () => {
  const t = new ReplayTracker();
  const now = 100_000_000;
  /** Just inside the one-minute window: accepted. */
  assert.strictEqual(t.check(1, 1, 0, now - (FRESHNESS_WINDOW_UNITS - 1), now).accepted, true);
  /** Past the window on a different stream (no prior state): rejected as replayed. */
  assert.strictEqual(t.check(2, 1, 0, now - (FRESHNESS_WINDOW_UNITS + 1), now).accepted, false);
});

test('the freshness window catches a stale replay with no prior state (post-restart)', () => {
  /** A tracker with empty state, as after a restart, still drops an old capture. */
  const t = new ReplayTracker();
  const now = 500_000_000;
  assert.strictEqual(t.check(1, 1, 0, now - 10 * FRESHNESS_WINDOW_UNITS, now).accepted, false);
  /** A fresh frame on the same stream is accepted. */
  assert.strictEqual(t.check(1, 1, 0, now, now).accepted, true);
});
