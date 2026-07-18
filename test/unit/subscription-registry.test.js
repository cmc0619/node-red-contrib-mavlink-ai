'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SubscriptionRegistry } = require('../../lib/runtime/subscription-registry');

function msg(name, sysid = 1, compid = 1, fields = {}) {
  return { topic: `mavlink/${name}`, payload: { name, id: 0, sysid, compid, fields } };
}

test('filters by message name', () => {
  const reg = new SubscriptionRegistry();
  const got = [];
  reg.subscribe({ messageNames: ['HEARTBEAT'] }, (m) => got.push(m.payload.name));
  reg.dispatch(msg('HEARTBEAT'));
  reg.dispatch(msg('ATTITUDE'));
  assert.deepStrictEqual(got, ['HEARTBEAT']);
});

test('filters by a sysids list (#154)', () => {
  const reg = new SubscriptionRegistry();
  const got = [];
  reg.subscribe({ sysids: [1, 2] }, (m) => got.push(m.payload.sysid));
  reg.dispatch(msg('HEARTBEAT', 1));
  reg.dispatch(msg('HEARTBEAT', 2));
  reg.dispatch(msg('HEARTBEAT', 3));
  assert.deepStrictEqual(got, [1, 2]);

  /** An empty list means "accept all", like a wildcard. */
  const reg2 = new SubscriptionRegistry();
  const all = [];
  reg2.subscribe({ sysids: [] }, (m) => all.push(m.payload.sysid));
  reg2.dispatch(msg('HEARTBEAT', 7));
  assert.deepStrictEqual(all, [7]);
});

test('malformed id lists fail closed: subscribe throws instead of widening to a wildcard (#280)', () => {
  const reg = new SubscriptionRegistry();
  /**
   * The old normalizer silently dropped invalid entries, so ['bad'] became []
   * — and an empty list means accept-all. A filter meant to narrow delivery
   * must never fail open; every malformed form throws BAD_FILTER instead.
   */
  /**
   * The Number-coercible impostors matter most: true/[1] coerce to 1 and
   * ''/null to 0, so bare coercion would register a REAL filter on id 1/0
   * instead of throwing (#288 review).
   */
  for (const bad of [['bad'], [1, 'bad'], [1.5], [-1], [256], [true], [[1]], [''], [null], 'not-an-array', 5]) {
    assert.throws(
      () => reg.subscribe({ sysids: bad }, () => {}),
      (e) => e.code === 'BAD_FILTER',
      `sysids ${JSON.stringify(bad)} must be rejected`
    );
    assert.throws(
      () => reg.subscribe({ compids: bad }, () => {}),
      (e) => e.code === 'BAD_FILTER',
      `compids ${JSON.stringify(bad)} must be rejected`
    );
  }
  /** Nothing was registered by the failed subscribes. */
  let delivered = 0;
  reg.subscribe({ messageNames: ['HEARTBEAT'] }, () => (delivered += 1));
  reg.dispatch(msg('HEARTBEAT', 9));
  assert.strictEqual(delivered, 1, 'only the valid subscription exists');
});

test('the removed singular sysid/compid fields are rejected loudly, not ignored (#280)', () => {
  const reg = new SubscriptionRegistry();
  /**
   * Silently ignoring the removed spelling would turn an existing narrow
   * filter into a wildcard — the exact fail-open the strict normalizer
   * exists to prevent.
   */
  assert.throws(() => reg.subscribe({ sysid: 1 }, () => {}), (e) => e.code === 'BAD_FILTER');
  assert.throws(() => reg.subscribe({ compid: 1 }, () => {}), (e) => e.code === 'BAD_FILTER');
});

test('wildcard id forms are unchanged: absent, empty array, and "*" accept all (#280)', () => {
  const reg = new SubscriptionRegistry();
  const got = [];
  reg.subscribe({}, (m) => got.push(m.payload.sysid));
  reg.subscribe({ sysids: [] }, (m) => got.push(m.payload.sysid));
  reg.subscribe({ sysids: '*' }, (m) => got.push(m.payload.sysid));
  reg.dispatch(msg('HEARTBEAT', 42));
  assert.deepStrictEqual(got, [42, 42, 42]);
});

test('rate limit drops bursts', () => {
  const reg = new SubscriptionRegistry();
  let count = 0;
  // 2 Hz => a 500ms window; several immediate dispatches are all within it, so
  // only the first is delivered. (A tight window like 1000Hz/1ms is flaky on
  // slow runners where >1ms can elapse between synchronous dispatches.)
  reg.subscribe({ rateLimitHz: 2 }, () => (count += 1));
  reg.dispatch(msg('ATTITUDE'));
  reg.dispatch(msg('ATTITUDE'));
  reg.dispatch(msg('ATTITUDE'));
  assert.strictEqual(count, 1);
});

test('rate limit is applied per message/sysid/compid, not per subscription (#30)', () => {
  const reg = new SubscriptionRegistry();
  const got = [];
  // One subscription matching two message types: a burst of the fast one must
  // not consume the delivery window of the slow one.
  reg.subscribe({ messageNames: ['HEARTBEAT', 'ATTITUDE'], rateLimitHz: 2 }, (m) => got.push(m.payload.name));
  reg.dispatch(msg('ATTITUDE'));
  reg.dispatch(msg('ATTITUDE'));
  reg.dispatch(msg('HEARTBEAT'));
  reg.dispatch(msg('HEARTBEAT'));
  // Different sysid gets its own window too.
  reg.dispatch(msg('ATTITUDE', 2));
  assert.deepStrictEqual(got, ['ATTITUDE', 'HEARTBEAT', 'ATTITUDE']);
});

test('fractional rate limits are honored (#29)', () => {
  const reg = new SubscriptionRegistry();
  let count = 0;
  // 0.5 Hz => a 2s window; an immediate burst delivers only the first.
  reg.subscribe({ rateLimitHz: 0.5 }, () => (count += 1));
  reg.dispatch(msg('ATTITUDE'));
  reg.dispatch(msg('ATTITUDE'));
  assert.strictEqual(count, 1);
});

test('changedOnly suppresses identical payloads', () => {
  const reg = new SubscriptionRegistry();
  let count = 0;
  reg.subscribe({ changedOnly: true }, () => (count += 1));
  reg.dispatch(msg('SYS_STATUS', 1, 1, { voltage: 12 }));
  reg.dispatch(msg('SYS_STATUS', 1, 1, { voltage: 12 }));
  reg.dispatch(msg('SYS_STATUS', 1, 1, { voltage: 11 }));
  assert.strictEqual(count, 2);
});

test('changedOnly suppression stays per-subscriber when several subs share a dispatch', () => {
  const reg = new SubscriptionRegistry();
  const a = [];
  const b = [];
  /**
   * Dispatch computes the changed-only signature once per message and shares
   * it across subscribers; what must NOT be shared is the suppression state.
   * Subscriber b arrives after the first dispatch, so the second dispatch is
   * a repeat for a but brand new for b.
   */
  reg.subscribe({ changedOnly: true }, (m) => a.push(m.payload.fields.voltage));
  reg.dispatch(msg('SYS_STATUS', 1, 1, { voltage: 12 }));
  reg.subscribe({ changedOnly: true }, (m) => b.push(m.payload.fields.voltage));
  reg.dispatch(msg('SYS_STATUS', 1, 1, { voltage: 12 }));
  reg.dispatch(msg('SYS_STATUS', 1, 1, { voltage: 11 }));
  assert.deepStrictEqual(a, [12, 11], 'first sub sees each distinct value once');
  assert.deepStrictEqual(b, [12, 11], 'late sub is not suppressed by the first sub\'s history');
});

test('changedOnly handles BigInt (uint64) fields without throwing (#73)', () => {
  const reg = new SubscriptionRegistry();
  let count = 0;
  reg.subscribe({ changedOnly: true }, () => (count += 1));
  // MAVLink 64-bit fields (e.g. time_usec) decode as BigInt; JSON.stringify
  // throws on those, which in dispatch would abort delivery for the packet. A
  // throw here would fail the test directly (no doesNotThrow wrapper needed).
  reg.dispatch(msg('SYSTEM_TIME', 1, 1, { time_unix_usec: 123n }));
  reg.dispatch(msg('SYSTEM_TIME', 1, 1, { time_unix_usec: 123n }));
  reg.dispatch(msg('SYSTEM_TIME', 1, 1, { time_unix_usec: 456n }));
  assert.strictEqual(count, 2); // 123n delivered once, 456n once
});

test('unsubscribe stops delivery', () => {
  const reg = new SubscriptionRegistry();
  let count = 0;
  const id = reg.subscribe({}, () => (count += 1));
  reg.dispatch(msg('HEARTBEAT'));
  reg.unsubscribe(id);
  reg.dispatch(msg('HEARTBEAT'));
  assert.strictEqual(count, 1);
});

test('per-key tracking maps stay empty without a rate limit or changedOnly', () => {
  /**
   * Keys are name:sysid:compid from the wire — unconditional tracking let any
   * sender sweeping the sysid/compid space grow the maps without bound.
   */
  const reg = new SubscriptionRegistry();
  const id = reg.subscribe({}, () => {});
  for (let sysid = 1; sysid <= 50; sysid += 1) {
    reg.dispatch({ topic: 'mavlink/HEARTBEAT', payload: { name: 'HEARTBEAT', sysid, compid: 1, fields: {} } });
  }
  const sub = reg._subs.get(id);
  assert.strictEqual(sub.lastDeliveredAt.size, 0);
  assert.strictEqual(sub.lastSignature.size, 0);
});

test('rate-limit/changed-only tracking maps are bounded against identity sweeps', () => {
  const reg = new SubscriptionRegistry();
  const id = reg.subscribe({ rateLimitHz: 1000, changedOnly: true }, () => {});
  for (let i = 0; i < 6000; i += 1) {
    reg.dispatch({
      topic: 'mavlink/HEARTBEAT',
      payload: { name: 'HEARTBEAT', sysid: (i % 250) + 1, compid: Math.floor(i / 250) + 1, fields: { n: i } }
    });
  }
  const sub = reg._subs.get(id);
  assert.ok(sub.lastDeliveredAt.size <= 4096, `lastDeliveredAt bounded (got ${sub.lastDeliveredAt.size})`);
  assert.ok(sub.lastSignature.size <= 4096, `lastSignature bounded (got ${sub.lastSignature.size})`);
});

test('rate limit and changed-only are keyed per connection identity (#240)', () => {
  /**
   * Two links can carry the same wire identity (vehicle sysid 1/compid 1).
   * Payloads stamped with different connection_ids must not consume each
   * other's delivery window or changed-only signature.
   */
  const withConn = (name, connectionId, fields = {}) => ({
    topic: `mavlink/${name}`,
    payload: { name, id: 0, sysid: 1, compid: 1, connection_id: connectionId, fields }
  });

  const reg = new SubscriptionRegistry();
  let limited = 0;
  reg.subscribe({ rateLimitHz: 2 }, () => (limited += 1));
  reg.dispatch(withConn('ATTITUDE', 'connA'));
  reg.dispatch(withConn('ATTITUDE', 'connB'));
  reg.dispatch(withConn('ATTITUDE', 'connA'));
  reg.dispatch(withConn('ATTITUDE', 'connB'));
  assert.strictEqual(limited, 2, 'each connection gets its own delivery window');

  const reg2 = new SubscriptionRegistry();
  let changed = 0;
  reg2.subscribe({ changedOnly: true }, () => (changed += 1));
  reg2.dispatch(withConn('HEARTBEAT', 'connA', { custom_mode: 4 }));
  reg2.dispatch(withConn('HEARTBEAT', 'connB', { custom_mode: 4 }));
  reg2.dispatch(withConn('HEARTBEAT', 'connA', { custom_mode: 4 }));
  assert.strictEqual(changed, 2, 'identical fields from another connection still deliver once');
});
