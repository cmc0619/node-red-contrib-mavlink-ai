'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { safeDetach, watchConfigBadge } = require('../../lib/util/node-lifecycle');

/**
 * Minimal RED/node stand-in for watchConfigBadge: a getNode-backed registry
 * plus a flows:started event bus, and a node that records its status history.
 */
function makeHarness(registry = {}) {
  const events = new EventEmitter();
  const RED = {
    nodes: { getNode: (id) => registry[id] || null },
    events
  };
  const statusHistory = [];
  const node = {
    status: (s) => statusHistory.push(s),
    on: (evt, fn) => events.on(`node:${evt}`, fn),
    statusHistory
  };
  return { RED, node, events, registry };
}

const validProfile = { isValid: () => true };

test('safeDetach runs the detach when a connection is present', () => {
  let ran = false;
  const node = { connection: {}, error: () => {} };
  safeDetach(node, () => {
    ran = true;
  });
  assert.strictEqual(ran, true);
});

test('safeDetach skips the detach when the connection is already gone', () => {
  let ran = false;
  const node = { connection: null, error: () => {} };
  safeDetach(node, () => {
    ran = true;
  });
  assert.strictEqual(ran, false);
});

test('safeDetach swallows a detach error and reports it via node.error (#140)', () => {
  const errors = [];
  const node = { connection: {}, error: (m) => errors.push(m) };
  assert.doesNotThrow(() =>
    safeDetach(node, () => {
      throw new Error('boom');
    })
  );
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /boom/);
});

test('watchConfigBadge badges a required connection that is missing', () => {
  const { RED, node } = makeHarness({});
  watchConfigBadge(RED, node, { connection: 'c1' }, { connection: 'required' });
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'missing connection' });
  assert.strictEqual(node.connection, null);
});

test('watchConfigBadge clears a stale "missing connection" badge when the connection is added on redeploy (#164)', () => {
  const { RED, node, events, registry } = makeHarness({});
  watchConfigBadge(RED, node, { connection: 'c1' }, { connection: 'required' });
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'missing connection' });

  registry.c1 = { id: 'c1', name: 'link' };
  events.emit('flows:started');
  assert.deepStrictEqual(node.statusHistory.at(-1), {});
  assert.strictEqual(node.connection, registry.c1);
});

test('watchConfigBadge only badges an optional connection when it is actually needed', () => {
  // awaitAck off: a missing connection is fine (the node emits mavlink/send).
  const off = makeHarness({});
  watchConfigBadge(off.RED, off.node, { connection: '' }, {
    connection: 'optional',
    connectionRequiredWhen: () => false
  });
  assert.deepStrictEqual(off.node.statusHistory.at(-1), {});

  // awaitAck on: the connection is required, so a missing one is badged (#164).
  const on = makeHarness({});
  watchConfigBadge(on.RED, on.node, { connection: '' }, {
    connection: 'optional',
    connectionRequiredWhen: () => true
  });
  assert.deepStrictEqual(on.node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'missing connection' });
});

test('watchConfigBadge reports invalid profile ahead of a missing connection', () => {
  const { RED, node } = makeHarness({ p1: validProfile });
  // Profile id points nowhere (invalid) and the connection is missing too;
  // the profile problem is the one to surface first.
  watchConfigBadge(RED, node, { profile: 'missing', connection: '' }, {
    profile: 'required',
    connection: 'required'
  });
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid profile' });
});

test('watchConfigBadge clears the badge once profile and connection both resolve', () => {
  const { RED, node } = makeHarness({ p1: validProfile, c1: { id: 'c1' } });
  watchConfigBadge(RED, node, { profile: 'p1', connection: 'c1' }, {
    profile: 'required',
    connection: 'required'
  });
  assert.deepStrictEqual(node.statusHistory.at(-1), {});
  assert.strictEqual(node.profile, validProfile);
  assert.strictEqual(node.connection, RED.nodes.getNode('c1'));
});
