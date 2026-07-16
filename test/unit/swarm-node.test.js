'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { MockRED } = require('../helpers/mock-red');

/**
 * Connection stand-in that records the swarm node's subscription filter and
 * lets the test push decoded messages through it.
 */
function stubConnection(RED, id) {
  const conn = {
    id,
    name: 'stub',
    emitter: new EventEmitter(),
    statusState: 'connected',
    filters: [],
    callbacks: [],
    subscribe: (filter, cb) => {
      conn.filters.push(filter);
      conn.callbacks.push(cb);
      return conn.callbacks.length;
    },
    unsubscribe: () => true,
    deliver: (payload) => {
      for (const cb of conn.callbacks) {
        cb({ topic: `mavlink/${payload.name}`, payload });
      }
    }
  };
  RED._nodes.set(id, conn);
  return conn;
}

function heartbeat(sysid, extra = {}) {
  return {
    name: 'HEARTBEAT',
    sysid,
    compid: 1,
    fields: Object.assign({ type: 2, autopilot: 3, base_mode: 81, custom_mode: 4, system_status: 4 }, extra)
  };
}

function setup(config) {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  const node = RED.create(
    'mavlink-ai-swarm',
    Object.assign({ id: 's1', connection: 'c1', emitOnChange: false }, config)
  );
  return { RED, conn, node };
}

test('swarm node subscribes to the registry message set (#46)', async () => {
  const { RED, conn, node } = setup({});
  assert.deepStrictEqual(conn.filters[0].messageNames, [
    'HEARTBEAT',
    'GLOBAL_POSITION_INT',
    'LOCAL_POSITION_NED',
    'SYS_STATUS'
  ]);
  await RED.close(node);
});

test('input triggers a vehicle snapshot with sysids for fan-out (#46)', async () => {
  const { RED, conn, node } = setup({});
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2, { base_mode: 81 | 128 }));
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'swarm/vehicles');
  assert.strictEqual(collected[0].payload.count, 2);
  assert.deepStrictEqual(collected[0].payload.sysids, [1, 2]);
  assert.strictEqual(collected[0].payload.vehicles[0].sysid, 1);
  await RED.close(node);
});

test('input payload filters the snapshot (armed / groups) (#46)', async () => {
  const { RED, conn, node } = setup({ groups: '{"scouts":[2]}' });
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2, { base_mode: 81 | 128 }));
  const armed = await RED.inject(node, { payload: { armed: true } });
  assert.deepStrictEqual(armed.collected[0].payload.sysids, [2]);
  const group = await RED.inject(node, { payload: { group: 'scouts' } });
  assert.deepStrictEqual(group.collected[0].payload.sysids, [2]);
  await RED.close(node);
});

test('a malformed input filter yields a structured error, not a crash (#46)', async () => {
  const { RED, conn, node } = setup({});
  conn.deliver(heartbeat(1));
  const { collected } = await RED.inject(node, { payload: { sysids: { nope: true } } });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'BAD_FILTER');
  await RED.close(node);
});

test('emitOnChange sends the table when a vehicle first appears (#46)', async () => {
  const { RED, conn, node } = setup({ emitOnChange: true });
  conn.deliver(heartbeat(7));
  assert.strictEqual(node.sent.length, 1);
  assert.strictEqual(node.sent[0].topic, 'swarm/vehicles');
  assert.deepStrictEqual(node.sent[0].payload.sysids, [7]);
  // Repeat heartbeats are not membership changes.
  conn.deliver(heartbeat(7));
  assert.strictEqual(node.sent.length, 1);
  await RED.close(node);
});

test('missing connection shows an error badge instead of crashing (#46)', () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-swarm', { id: 's1', connection: 'nope' });
  assert.deepStrictEqual(node.statusHistory[0], { fill: 'red', shape: 'ring', text: 'missing connection' });
});

/**
 * A swarm node with no connection used to early-return without an input handler,
 * so a triggering message was silently swallowed (#154). It now emits a
 * structured NO_CONNECTION error like the mission/param nodes.
 */
test('mavlink-ai-swarm without a connection emits NO_CONNECTION, not silence (#154)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-swarm', { id: 's1', connection: 'missing' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected.length, 1);
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'NO_CONNECTION');
});

test('malformed groups JSON invalidates the node and fails fully closed (#204)', async () => {
  const { RED, conn, node } = setup({ groups: '{bad json', emitOnChange: true, intervalMs: 0 });
  /**
   * An input triggers a structured INVALID_CONFIG error, never a snapshot.
   */
  const { collected } = await RED.inject(node, { payload: { group: 'scouts' } });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'INVALID_CONFIG');
  /**
   * And the node must not attach/subscribe or start the change/interval emit
   * timers — otherwise it could auto-emit an ungrouped snapshot with no input,
   * re-widening the output to every vehicle (Codex review on #234).
   */
  assert.strictEqual(conn.filters.length, 0, 'no subscription was made on invalid config');
});
