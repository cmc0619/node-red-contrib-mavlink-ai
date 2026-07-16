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

test('the freshness reference tracks accepted timestamps, not just the wall clock', () => {
  const t = new ReplayTracker();
  /** Receiver clock far behind the vehicle's signing time. */
  const slowNow = 1000;
  const vehicleTs = 100_000_000;
  assert.strictEqual(t.check(1, 1, 0, vehicleTs, slowNow).accepted, true);
  /**
   * An old capture on a not-yet-seen stream, more than a minute behind the
   * accepted maximum, is rejected even though the slow clock would call it fresh.
   */
  assert.strictEqual(t.check(2, 1, 0, vehicleTs - (FRESHNESS_WINDOW_UNITS + 1), slowNow).accepted, false);
});

test('the freshness window catches a stale replay with no prior state (post-restart)', () => {
  /** A tracker with empty state, as after a restart, still drops an old capture. */
  const t = new ReplayTracker();
  const now = 500_000_000;
  assert.strictEqual(t.check(1, 1, 0, now - 10 * FRESHNESS_WINDOW_UNITS, now).accepted, false);
  /** A fresh frame on the same stream is accepted. */
  assert.strictEqual(t.check(1, 1, 0, now, now).accepted, true);
});

test('an established stream is not re-checked against the freshness window (reference behavior)', () => {
  const t = new ReplayTracker();
  const now = 100_000_000;
  /** stream B opens at a modest timestamp */
  assert.strictEqual(t.check(2, 1, 0, now, now).accepted, true);
  /** stream A runs 5 minutes ahead, advancing the shared reference */
  assert.strictEqual(t.check(1, 1, 0, now + 30_000_000, now).accepted, true);
  /**
   * B advances monotonically but lags the reference by more than the window.
   * The C/pymavlink references only freshness-check a stream when it is FIRST
   * seen — re-checking every frame would permanently reject an authentic
   * vehicle whose clock lags a faster peer's (no RTC/GPS lock).
   */
  assert.strictEqual(t.check(2, 1, 0, now + 100, now).accepted, true);
});

test('a stale capture cannot open a NEW stream (freshness applies on first-seen)', () => {
  const t = new ReplayTracker();
  const now = 100_000_000;
  assert.strictEqual(t.check(1, 1, 0, now, now).accepted, true);
  assert.strictEqual(t.check(3, 3, 0, now - FRESHNESS_WINDOW_UNITS - 1, now).reason, 'signature-replayed');
});

test('the signing-stream table is capped; known streams keep working at the cap', () => {
  const t = new ReplayTracker();
  const now = 100_000_000;
  for (let compid = 0; compid < 256; compid += 1) {
    assert.strictEqual(t.check(1, compid, 0, now, now).accepted, true);
  }
  /** table full: a 257th stream is rejected (reference reject-when-full) */
  assert.strictEqual(t.check(2, 0, 0, now + 1, now).reason, 'signature-replayed');
  /** existing streams are unaffected */
  assert.strictEqual(t.check(1, 0, 0, now + 1, now).accepted, true);
});
