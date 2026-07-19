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
