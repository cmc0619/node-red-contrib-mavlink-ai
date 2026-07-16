'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { fakeIdentity } = require('../helpers/v3-config');

const NUL = String.fromCharCode(0);

/** A stub connection config node exposing the runtime API the param node uses. */
function fakeConnection() {
  const conn = { id: 'conn1', name: 'Conn', sent: [], _subs: new Map(), _id: 1 };
  conn.profile = {
    id: 'p1',
    name: 'Copter',
    getDefaults: () => ({ defaultTargetSystem: 1, defaultTargetComponent: 1 }),
    getDialect: () => ({ enums: loadDialect('ardupilotmega').enums })
  };
  conn.acquireLock = () => ({ release: () => {} });
  conn.subscribe = (filter, cb) => {
    const id = conn._id++;
    conn._subs.set(id, cb);
    return id;
  };
  conn.unsubscribe = (id) => conn._subs.delete(id);
  conn.send = (m) => {
    conn.sent.push(m);
    return Promise.resolve();
  };
  conn.deliver = (payload) => {
    for (const cb of conn._subs.values()) {
      cb({ topic: 'mavlink/PARAM_VALUE', payload });
    }
  };
  // v3: the connection resolves the outbound Local Identity (#228).
  conn.resolveOutboundIdentity = () => fakeIdentity();
  return conn;
}

function paramValue({ id = 'RC1_MIN', value = 1100, type = 9, index = 0, count = 1, sysid = 1 }) {
  return {
    name: 'PARAM_VALUE',
    sysid,
    compid: 1,
    fields: {
      param_id: id + NUL.repeat(Math.max(0, 16 - id.length)),
      param_value: value,
      param_type: type,
      param_index: index,
      param_count: count
    }
  };
}

/** Drive the node's input handler and deliver PARAM_VALUE(s) once subscribed. */
function run(node, msg, deliver) {
  const outputs = [];
  return new Promise((resolve) => {
    const send = (m) => outputs.push(m);
    node._ee.emit('input', msg, send, () => resolve(outputs));
    // The handler subscribes synchronously (inside workflow.run) before its
    // first await, so the subscription exists by now.
    if (deliver) {
      deliver();
    }
  });
}

function setup(config) {
  const RED = new MockRED().loadNodes();
  const conn = fakeConnection();
  RED._nodes.set('conn1', conn);
  const node = RED.create('mavlink-ai-param', Object.assign({ id: 'pm1', connection: 'conn1' }, config));
  return { RED, conn, node };
}

test('param node read emits param/value on output 1', async () => {
  const { conn, node } = setup({ action: 'read', paramId: 'RC1_MIN' });
  const outputs = await run(node, { payload: {} }, () => conn.deliver(paramValue({ value: 1100 })));
  const result = outputs.map((o) => o[0]).filter(Boolean).pop();
  assert.strictEqual(result.topic, 'param/value');
  assert.strictEqual(result.payload.param_id, 'RC1_MIN');
  assert.strictEqual(result.payload.param_value, 1100);
});

test('param node set uses payload value and reports applied', async () => {
  const { conn, node } = setup({ action: 'set', paramId: 'RC1_MIN', paramType: 'MAV_PARAM_TYPE_REAL32' });
  const outputs = await run(node, { payload: { param_value: 1234 } }, () =>
    conn.deliver(paramValue({ value: 1234 }))
  );
  const set = conn.sent.find((m) => m.name === 'PARAM_SET');
  assert.ok(set);
  assert.strictEqual(set.fields.param_value, 1234);
  const result = outputs[outputs.length - 1][0];
  assert.strictEqual(result.topic, 'param/set');
  assert.strictEqual(result.payload.applied, true);
});

test('param node set uses the editor Value when the flow omits param_value', async () => {
  const { conn, node } = setup({ action: 'set', paramId: 'RC1_MIN', paramValue: '1500', paramType: 'MAV_PARAM_TYPE_REAL32' });
  const outputs = await run(node, { payload: {} }, () => conn.deliver(paramValue({ value: 1500 })));
  const set = conn.sent.find((m) => m.name === 'PARAM_SET');
  assert.ok(set);
  assert.strictEqual(set.fields.param_value, 1500);
  const result = outputs[outputs.length - 1][0];
  assert.strictEqual(result.topic, 'param/set');
  assert.strictEqual(result.payload.applied, true);
});

test('param node set lets the flow param_value override the editor Value', async () => {
  const { conn, node } = setup({ action: 'set', paramId: 'RC1_MIN', paramValue: '1500', paramType: 'MAV_PARAM_TYPE_REAL32' });
  await run(node, { payload: { param_value: 1234 } }, () => conn.deliver(paramValue({ value: 1234 })));
  const set = conn.sent.find((m) => m.name === 'PARAM_SET');
  assert.ok(set);
  assert.strictEqual(set.fields.param_value, 1234);
});

test('param node set with a blank editor Value and no flow value fails, not sets 0', async () => {
  const { conn, node } = setup({ action: 'set', paramId: 'RC1_MIN', paramValue: '' });
  const outputs = await run(node, { payload: {} });
  assert.ok(!conn.sent.some((m) => m.name === 'PARAM_SET'));
  const error = outputs[0][2];
  assert.strictEqual(error.topic, 'mavlink/error');
  assert.strictEqual(error.payload.code, 'BAD_PARAM_SET');
});

test('param node read uses the configured Param index when Param ID is blank', async () => {
  const { conn, node } = setup({ action: 'read', paramIndex: '5' });
  const outputs = await run(node, { payload: {} }, () => conn.deliver(paramValue({ index: 5, count: 10, value: 42 })));
  const req = conn.sent.find((m) => m.name === 'PARAM_REQUEST_READ');
  assert.strictEqual(req.fields.param_index, 5);
  const result = outputs.map((o) => o[0]).filter(Boolean).pop();
  assert.strictEqual(result.payload.param_value, 42);
});

test('param node auto set reads the type from the vehicle, then sets with it', async () => {
  const { conn, node } = setup({ action: 'set', paramId: 'RC1_MIN', paramValue: '3', paramType: 'auto' });
  /** Respond to the detour read with UINT8 (type 1), then echo the set. */
  conn.send = (m) => {
    conn.sent.push(m);
    queueMicrotask(() => {
      if (m.name === 'PARAM_REQUEST_READ') {
        conn.deliver(paramValue({ id: 'RC1_MIN', value: 9, type: 1 }));
      } else if (m.name === 'PARAM_SET') {
        conn.deliver(paramValue({ id: 'RC1_MIN', value: m.fields.param_value, type: m.fields.param_type }));
      }
    });
    return Promise.resolve();
  };
  const outputs = await run(node, { payload: {} });
  const names = conn.sent.map((m) => m.name);
  assert.deepStrictEqual(names, ['PARAM_REQUEST_READ', 'PARAM_SET']);
  const set = conn.sent.find((m) => m.name === 'PARAM_SET');
  assert.strictEqual(set.fields.param_type, 1);
  assert.strictEqual(set.fields.param_value, 3);
  const result = outputs.map((o) => o[0]).filter(Boolean).pop();
  assert.strictEqual(result.topic, 'param/set');
  assert.strictEqual(result.payload.applied, true);
});

test('param node auto set rejects a value that does not fit the detected type', async () => {
  const { conn, node } = setup({ action: 'set', paramId: 'RC1_MIN', paramValue: '300', paramType: 'auto' });
  /** The vehicle reports UINT8 (type 1); 300 cannot fit, so the set must not send. */
  conn.send = (m) => {
    conn.sent.push(m);
    queueMicrotask(() => {
      if (m.name === 'PARAM_REQUEST_READ') {
        conn.deliver(paramValue({ id: 'RC1_MIN', value: 9, type: 1 }));
      }
    });
    return Promise.resolve();
  };
  const outputs = await run(node, { payload: {} });
  assert.ok(!conn.sent.some((m) => m.name === 'PARAM_SET'));
  const error = outputs.map((o) => o[2]).filter(Boolean).pop();
  assert.strictEqual(error.payload.code, 'PARAM_VALUE_RANGE');
});

test('param node list assembles params and emits progress', async () => {
  const { conn, node } = setup({ action: 'list' });
  const outputs = await run(node, { payload: {} }, () => {
    conn.deliver(paramValue({ id: 'A', index: 0, count: 2 }));
    conn.deliver(paramValue({ id: 'B', index: 1, count: 2 }));
  });
  // Progress events arrive on output 2, the final list on output 1.
  const progress = outputs.filter((o) => o[1]);
  assert.ok(progress.length >= 1);
  const result = outputs.map((o) => o[0]).filter(Boolean).pop();
  assert.strictEqual(result.topic, 'param/list');
  assert.strictEqual(result.payload.count, 2);
  assert.deepStrictEqual(result.payload.params.map((p) => p.param_id), ['A', 'B']);
});

test('param node without connection emits a structured error', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-param', { id: 'pm2', action: 'read', paramId: 'X' });
  const outputs = await run(node, { payload: {} });
  const error = outputs[0][2];
  assert.strictEqual(error.topic, 'mavlink/error');
  assert.strictEqual(error.payload.code, 'NO_CONNECTION');
});

/**
 * Node-RED leaves the param node in place when only its referenced connection
 * changed, so its constructor never re-runs. Before #164 the "missing
 * connection" badge set at construction never refreshed, so a connection added
 * after the first deploy left a stale red badge.
 */
test('param node clears its "missing connection" badge when a connection is added on redeploy (#164)', () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-param', { id: 'pm3', connection: 'conn1', action: 'read', paramId: 'X' });
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'missing connection' });
  assert.ok(!node.connection);

  RED._nodes.set('conn1', fakeConnection());
  RED.events.emit('flows:started');
  assert.deepStrictEqual(node.statusHistory.at(-1), {});
  assert.ok(node.connection);
});

test('param node rejects an unsupported action', async () => {
  const { node } = setup({ action: 'read', paramId: 'X' });
  const outputs = await run(node, { action: 'bogus', payload: {} });
  const error = outputs[0][2];
  assert.strictEqual(error.payload.code, 'UNSUPPORTED_ACTION');
});

// Workflow profile propagation (#81): an explicit profile override rides on
// every outbound send and supplies the workflow's defaults; a reference that
// can't be resolved to a real profile fails loudly instead of silently
// running under the connection's default.

/** @returns {object} a PX4-firmware profile stand-in with target defaults */
function px4Profile() {
  return {
    id: 'p2',
    name: 'PX4 Rover',
    isValid: () => true,
    getDialect: () => ({ enums: loadDialect('ardupilotmega').enums }),
    getDefaults: () => ({ defaultTargetSystem: 3, defaultTargetComponent: 1, firmware: 'px4' })
  };
}

test('param node explicit profile rides on sends and supplies target defaults', async () => {
  const { conn, node } = setup({ action: 'read', paramId: 'RC1_MIN', profile: 'p2' });
  const profile2 = px4Profile();
  conn.resolveProfile = (ref) => (ref === 'p2' ? profile2 : { name: ref });
  const outputs = await run(node, { payload: {} }, () => conn.deliver(paramValue({ value: 1100, sysid: 3 })));
  const req = conn.sent[0];
  assert.strictEqual(req.name, 'PARAM_REQUEST_READ');
  assert.strictEqual(req.vehicleProfile, 'p2');
  assert.strictEqual(req.fields.target_system, 3);
  const result = outputs.map((o) => o[0]).filter(Boolean).pop();
  assert.strictEqual(result.payload.param_value, 1100);
});

test('param node rejects an unresolvable msg profile with PROFILE_UNRESOLVED', async () => {
  const { conn, node } = setup({ action: 'read', paramId: 'RC1_MIN' });
  conn.resolveProfile = (ref) => ({ name: ref });
  const outputs = await run(node, { payload: { profile: 'missing' } });
  const error = outputs[0][2];
  assert.strictEqual(error.topic, 'mavlink/error');
  assert.strictEqual(error.payload.code, 'PROFILE_UNRESOLVED');
  assert.strictEqual(conn.sent.length, 0);
});

test('param node route-resolves the target to its profile when no override is set', async () => {
  const { conn, node } = setup({ action: 'read', paramId: 'RC1_MIN' });
  const routed = {
    id: 'p_routed',
    name: 'Routed',
    isValid: () => true,
    getDialect: () => ({ enums: loadDialect('ardupilotmega').enums }),
    getDefaults: () => ({ defaultTargetSystem: 1, defaultTargetComponent: 1, firmware: 'generic' })
  };
  conn.getProfileForPacket = ({ sysid }) => (sysid === 2 ? routed : conn.profile);
  await run(node, { payload: { target_system: 2 } }, () => conn.deliver(paramValue({ value: 1100, sysid: 2 })));
  assert.strictEqual(conn.sent[0].vehicleProfile, 'p_routed');
  assert.strictEqual(conn.sent[0].fields.target_system, 2);
});

test('param node rejects a broadcast target_system before locking/sending (#197)', async () => {
  const { conn, node } = setup({ action: 'read', paramId: 'RC1_MIN' });
  const outputs = await run(node, { payload: { target_system: 0 } });
  const error = outputs[0][2];
  assert.strictEqual(error.topic, 'mavlink/error');
  assert.strictEqual(error.payload.code, 'BROADCAST_NO_ACK');
  assert.strictEqual(conn.sent.length, 0, 'no PARAM message was sent to the broadcast target');
});
