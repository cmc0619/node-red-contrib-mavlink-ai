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

test('filters by sysid', () => {
  const reg = new SubscriptionRegistry();
  const got = [];
  reg.subscribe({ sysid: 1 }, (m) => got.push(m.payload.sysid));
  reg.dispatch(msg('HEARTBEAT', 1));
  reg.dispatch(msg('HEARTBEAT', 2));
  assert.deepStrictEqual(got, [1]);
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

test('unsubscribe stops delivery', () => {
  const reg = new SubscriptionRegistry();
  let count = 0;
  const id = reg.subscribe({}, () => (count += 1));
  reg.dispatch(msg('HEARTBEAT'));
  reg.unsubscribe(id);
  reg.dispatch(msg('HEARTBEAT'));
  assert.strictEqual(count, 1);
});
