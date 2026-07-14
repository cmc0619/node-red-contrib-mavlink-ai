'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ReplayTracker } = require('../../lib/protocol/replay-tracker');

test('first frame per stream is accepted', () => {
  const t = new ReplayTracker();
  assert.deepStrictEqual(t.check(1, 1, 0, 1000), { accepted: true, reason: 'signature-valid' });
});

test('an exact replay and any older timestamp are rejected', () => {
  const t = new ReplayTracker();
  t.check(1, 1, 0, 1000);
  /** Equal counts as a replay (must be strictly greater). */
  assert.strictEqual(t.check(1, 1, 0, 1000).reason, 'signature-replayed');
  assert.strictEqual(t.check(1, 1, 0, 999).reason, 'signature-replayed');
  assert.strictEqual(t.check(1, 1, 0, 1000).accepted, false);
});

test('a newer timestamp advances the stream and is accepted', () => {
  const t = new ReplayTracker();
  t.check(1, 1, 0, 1000);
  assert.strictEqual(t.check(1, 1, 0, 1001).accepted, true);
  /** 1000 is now stale relative to the advanced 1001. */
  assert.strictEqual(t.check(1, 1, 0, 1000).accepted, false);
});

test('independent (sysid, compid, linkId) streams do not interfere', () => {
  const t = new ReplayTracker();
  t.check(1, 1, 0, 5000);
  /** Differing sysid, compid, or linkId are all distinct streams. */
  assert.strictEqual(t.check(2, 1, 0, 10).accepted, true);
  assert.strictEqual(t.check(1, 2, 0, 10).accepted, true);
  assert.strictEqual(t.check(1, 1, 9, 10).accepted, true);
});

test('a non-finite timestamp is rejected, not silently advanced', () => {
  const t = new ReplayTracker();
  assert.strictEqual(t.check(1, 1, 0, NaN).accepted, false);
  /** The stream was never advanced by the NaN, so a real timestamp still passes. */
  assert.strictEqual(t.check(1, 1, 0, 1).accepted, true);
});

test('durable state seeds from the store and rejects a pre-restart replay', () => {
  const backing = {};
  const store = {
    load: (k) => backing[k] || {},
    save: (k, m) => {
      backing[k] = m;
    }
  };
  const first = new ReplayTracker({ scopeKey: 'scopeA', store });
  assert.strictEqual(first.check(1, 1, 0, 2000).accepted, true);

  /**
   * A fresh tracker (simulating a restart) seeded from the same store rejects
   * the replay and accepts only a newer timestamp.
   */
  const restarted = new ReplayTracker({ scopeKey: 'scopeA', store });
  assert.strictEqual(restarted.check(1, 1, 0, 2000).accepted, false);
  assert.strictEqual(restarted.check(1, 1, 0, 2001).accepted, true);

  /** A different key identity (rotated key) is a fresh scope. */
  const rotated = new ReplayTracker({ scopeKey: 'scopeB', store });
  assert.strictEqual(rotated.check(1, 1, 0, 2000).accepted, true);
});
