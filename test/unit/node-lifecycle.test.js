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
  /** awaitAck off: a missing connection is fine (the node emits mavlink/send). */
  const off = makeHarness({});
  watchConfigBadge(off.RED, off.node, { connection: '' }, {
    connection: 'optional',
    connectionRequiredWhen: () => false
  });
  assert.deepStrictEqual(off.node.statusHistory.at(-1), {});

  /** awaitAck on: the connection is required, so a missing one is badged (#164). */
  const on = makeHarness({});
  watchConfigBadge(on.RED, on.node, { connection: '' }, {
    connection: 'optional',
    connectionRequiredWhen: () => true
  });
  assert.deepStrictEqual(on.node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'missing connection' });
});

test('watchConfigBadge reports invalid profile ahead of a missing connection', () => {
  const { RED, node } = makeHarness({ p1: validProfile });
  /**
   * Profile id points nowhere (invalid) and the connection is missing too;
   * the profile problem is the one to surface first.
   */
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

/**
 * Codex #308 finding G1: a construct-time config error (malformed static
 * JSON, unset Delivery, ...) recorded on `node._configError` must keep
 * showing its red badge across a `flows:started` refresh, not just once at
 * construct time — otherwise a redeploy that touches an unrelated node fires
 * `flows:started`, this node's optional connection isn't "needed" (Delivery
 * unset), and the refresh silently clears the badge back to idle even though
 * the node is still broken.
 */
test('watchConfigBadge re-asserts the config-error badge on flows:started while node._configError is set (#308 G1)', () => {
  const { RED, node, events } = makeHarness({ p1: validProfile });
  node._configError = 'Delivery mode not set — open the node and choose a Delivery mode.';
  watchConfigBadge(RED, node, { profile: 'p1' }, {
    profile: 'required',
    connection: 'optional',
    connectionRequiredWhen: () => false
  });
  events.emit('flows:started');
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });
  assert.ok(node._configError, 'node._configError remains set');
});

/**
 * "invalid profile" is the more fundamental problem: when both an invalid
 * profile and a `_configError` are present, the refresh keeps showing the
 * profile badge instead of masking it with "invalid config" (mirrors the
 * construct-time precedence in command/payload/move/fanout).
 */
test('watchConfigBadge keeps "invalid profile" ahead of a config error on refresh (#308 G1)', () => {
  const { RED, node, events } = makeHarness({});
  node._configError = 'some construct-time problem';
  watchConfigBadge(RED, node, { profile: 'missing' }, { profile: 'required' });
  events.emit('flows:started');
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid profile' });
});

/**
 * A caller that never sets `node._configError` (mission/param/out/
 * vehicle-state/in) must see no behavior change: the refresh still clears to
 * idle once profile/connection resolve, exactly as before this fix.
 */
test('watchConfigBadge refresh is unaffected when the caller never sets node._configError (#308 G1 no-regression)', () => {
  const { RED, node, events, registry } = makeHarness({});
  watchConfigBadge(RED, node, { connection: 'c1' }, { connection: 'required' });
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'missing connection' });
  registry.c1 = { id: 'c1', name: 'link' };
  events.emit('flows:started');
  assert.deepStrictEqual(node.statusHistory.at(-1), {});
});
