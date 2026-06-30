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
  reg.subscribe({ rateLimitHz: 1000 }, () => (count += 1));
  // Two immediate dispatches within the 1ms window: second should be dropped.
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
