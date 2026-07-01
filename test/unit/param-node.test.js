'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');

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
  return conn;
}

function paramValue({ id = 'RC1_MIN', value = 1100, type = 9, index = 0, count = 1 }) {
  return {
    name: 'PARAM_VALUE',
    sysid: 1,
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
  const { conn, node } = setup({ action: 'set', paramId: 'RC1_MIN' });
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

test('param node rejects an unsupported action', async () => {
  const { node } = setup({ action: 'read', paramId: 'X' });
  const outputs = await run(node, { action: 'bogus', payload: {} });
  const error = outputs[0][2];
  assert.strictEqual(error.payload.code, 'UNSUPPORTED_ACTION');
});
