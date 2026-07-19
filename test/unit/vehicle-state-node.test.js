'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { MockRED } = require('../helpers/mock-red');

/** Connection stand-in the node subscribes to; the test pushes decoded msgs. */
function stubConnection(RED, id) {
  const conn = {
    id,
    name: 'stub',
    emitter: new EventEmitter(),
    profile: { getDialect: () => ({ valid: false, enums: null }) },
    getVehicleCapabilities: () => undefined,
    _cbs: [],
    subscribe(filter, cb) {
      conn.lastFilter = filter;
      conn._cbs.push(cb);
      return conn._cbs.length;
    },
    unsubscribe() { return true; },
    deliver(payload) {
      for (const cb of conn._cbs) {
        cb({ topic: `mavlink/${payload.name}`, payload });
      }
    }
  };
  RED._nodes.set(id, conn);
  return conn;
}

function hb(sysid, over = {}) {
  return { name: 'HEARTBEAT', sysid, compid: 1, fields: Object.assign({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }, over) };
}

function setup(config = {}) {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  const node = RED.create('mavlink-ai-vehicle-state', Object.assign({ id: 'vs1', connection: 'c1' }, config));
  return { RED, conn, node };
}

test('the node subscribes with the engine message set', (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  assert.ok(conn.lastFilter.messageNames.includes('HEARTBEAT'));
  assert.ok(conn.lastFilter.messageNames.includes('SYS_STATUS'));
  assert.ok(!conn.lastFilter.messageNames.includes('AUTOPILOT_VERSION'), 'capabilities come from the cache');
});

test('a first heartbeat emits a connected transition on output 1', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));
  const connectedMsg = seen.map((o) => o[0]).find(Boolean);
  assert.ok(connectedMsg, 'a transition went out on output 1');
  assert.strictEqual(connectedMsg.payload.event, 'connected');
  assert.strictEqual(connectedMsg.payload.sysid, 1);
});

test('an on-demand snapshot command emits per-vehicle state on output 2', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  conn.deliver(hb(1));
  const { collected } = await RED.inject(node, { command: 'snapshot' });
  const snapMsg = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(snapMsg.topic, 'vehicle/state');
  assert.strictEqual(snapMsg.payload.sysid, 1);
  assert.strictEqual(snapMsg.payload.contract, 'vehicle-state/1');
});

test('a bigint capability bitmask is rendered JSON-safe before it leaves the node', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  conn.getVehicleCapabilities = () => 0x10n; // uint64 AUTOPILOT_VERSION.capabilities
  conn.deliver(hb(1));
  const { collected } = await RED.inject(node, { command: 'snapshot' });
  const snapMsg = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(snapMsg.payload.capabilities, '16', 'bigint bitmask rendered to a decimal string');
  assert.doesNotThrow(() => JSON.stringify(snapMsg.payload), 'snapshot survives JSON serialization');
});

test('the snapshot interval emits full snapshots on output 2 without an input send', async (t) => {
  const { RED, conn, node } = setup({ intervalSeconds: 0.05 });
  t.after(() => RED.close(node));
  conn.deliver(hb(1));
  await new Promise((resolve) => setTimeout(resolve, 90));
  const snap = node.sent.map((o) => o[1]).find(Boolean);
  assert.ok(snap, 'the interval timer published a snapshot via node.send');
  assert.strictEqual(snap.topic, 'vehicle/state');
  assert.strictEqual(snap.payload.sysid, 1);
});

test('a snapshot command scopes to payload.sysid, not just top-level msg.sysid', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  conn.deliver(hb(1));
  conn.deliver(hb(2));
  const { collected } = await RED.inject(node, { payload: { command: 'snapshot', sysid: 2 } });
  const snaps = collected.map((o) => o[1]).filter(Boolean);
  assert.strictEqual(snaps.length, 1, 'exactly one vehicle snapshotted');
  assert.strictEqual(snaps[0].payload.sysid, 2, 'the requested sysid, not every vehicle');
});

test('capabilities are looked up with the system-wide component (compid 0)', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  const compids = [];
  conn.getVehicleCapabilities = (sysid, compid) => { compids.push(compid); return undefined; };
  conn.deliver(hb(1));
  await RED.inject(node, { command: 'snapshot' });
  assert.ok(compids.length > 0, 'capabilities were queried');
  assert.ok(compids.every((c) => c === 0), 'always queried with compid 0 (autopilot-first-then-any)');
});

test('a throwing getVehicleCapabilities does not break snapshot emission', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  conn.getVehicleCapabilities = () => { throw new Error('recycled connection'); };
  conn.deliver(hb(1));
  const { collected } = await RED.inject(node, { command: 'snapshot' });
  const snapMsg = collected.map((o) => o[1]).find(Boolean);
  assert.ok(snapMsg, 'snapshot still emitted despite the throw');
  assert.strictEqual(snapMsg.payload.capabilities, null, 'capabilities fall back to null');
});

test('the engine is rebuilt when the connection node is redeployed', (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  conn.deliver(hb(1));
  const firstEngine = node.engine;
  assert.ok(firstEngine, 'engine created on first attach');
  /** Stand in for a connection redeploy: a new object under the same id. */
  const conn2 = stubConnection(RED, 'c1');
  RED.events.emit('flows:started');
  assert.notStrictEqual(node.engine, firstEngine, 'engine rebuilt for the new connection');
  assert.strictEqual(node.engine.sysids().length, 0, 'rebuilt engine starts with no accumulated state');
  void conn2;
});

test('the engine is cleared when the connection node disappears on redeploy', async (t) => {
  const { RED, node } = setup();
  t.after(() => RED.close(node));
  RED._nodes.get('c1').deliver ? RED._nodes.get('c1').deliver(hb(1)) : null;
  assert.ok(node.engine, 'engine present while connected');
  /** Connection node removed on redeploy, then flows:started re-runs attach. */
  RED.remove('c1');
  RED.events.emit('flows:started');
  assert.strictEqual(node.engine, null, 'engine dropped with the vanished connection');
  const { collected } = await RED.inject(node, { command: 'snapshot' });
  const errMsg = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(errMsg.payload.code, 'CONNECTION_UNAVAILABLE', 'snapshot now reports unavailable, not stale vehicles');
});

test('a snapshot command with no resolved connection surfaces an error', async (t) => {
  const { RED, node } = setup({ connection: 'missing-conn' });
  t.after(() => RED.close(node));
  assert.ok(!node._configError, 'config itself is valid');
  const { collected } = await RED.inject(node, { command: 'snapshot' });
  const errMsg = collected.map((o) => o[1]).find(Boolean);
  assert.ok(errMsg, 'an error was emitted on output 2');
  assert.strictEqual(errMsg.payload.code, 'CONNECTION_UNAVAILABLE');
});

test('STATUSTEXT is emitted live on output 3', (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));
  conn.deliver({ name: 'STATUSTEXT', sysid: 1, compid: 1, fields: { severity: 2, text: 'BATTERY LOW' } });
  const st = seen.map((o) => o[2]).find(Boolean);
  assert.strictEqual(st.topic, 'vehicle/statustext');
  assert.strictEqual(st.payload.text, 'BATTERY LOW');
});

test('the sysid filter restricts which vehicles the node reports', (t) => {
  const { RED, conn, node } = setup({ sysids: '2' });
  t.after(() => RED.close(node));
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));
  assert.strictEqual(seen.length, 0, 'sysid 1 is filtered out');
  conn.deliver(hb(2));
  assert.ok(seen.map((o) => o[0]).find(Boolean), 'sysid 2 passes');
});

test('a malformed sysid filter fails closed: no emission for any vehicle, config error set (#208 whole-branch review)', (t) => {
  const { RED, conn, node } = setup({ sysids: '1O' });
  t.after(() => RED.close(node));
  assert.ok(node._configError, 'node has a config error');
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));
  assert.strictEqual(seen.length, 0, 'nothing is emitted for any vehicle when the sysid filter is malformed');
});

test('a silent vehicle emits connection_lost on the re-diff tick (#208 whole-branch review)', async (t) => {
  const { RED, conn, node } = setup({ staleMs: 20 });
  t.after(() => RED.close(node));
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));                         // vehicle connects
  await new Promise((r) => setTimeout(r, 40)); // let its heartbeat age past staleMs
  node._reemit();                              // the coarse re-diff tick
  const lost = seen.map((o) => o[0]).filter(Boolean).find((m) => m.payload.event === 'connection_lost');
  assert.ok(lost, 'connection_lost emitted on output 1 when the vehicle goes silent');
  assert.strictEqual(lost.payload.sysid, 1);
});
