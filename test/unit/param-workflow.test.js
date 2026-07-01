'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const {
  trimParamId,
  projectParam,
  ParamRead,
  ParamSet,
  ParamList
} = require('../../lib/param/param-workflow');

const NUL = String.fromCharCode(0);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal connection stand-in: records outbound messages and delivers
 * PARAM_VALUE payloads to whatever the workflow subscribed with.
 */
class FakeConnection {
  constructor() {
    this.sent = [];
    this._subs = new Map();
    this._id = 1;
  }

  subscribe(filter, cb) {
    const id = this._id++;
    this._subs.set(id, { filter, cb });
    return id;
  }

  unsubscribe(id) {
    return this._subs.delete(id);
  }

  send(message) {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Deliver a decoded PARAM_VALUE payload to all subscribers. */
  deliverParamValue(payload) {
    for (const { cb } of this._subs.values()) {
      cb({ topic: 'mavlink/PARAM_VALUE', payload });
    }
  }
}

/** Build a decoded PARAM_VALUE payload from the target (sysid 1). */
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

test('trimParamId strips NUL padding', () => {
  assert.strictEqual(trimParamId('RC1_MIN' + NUL + NUL + NUL), 'RC1_MIN');
  assert.strictEqual(trimParamId(''), '');
  assert.strictEqual(trimParamId(null), '');
});

test('projectParam resolves MAV_PARAM_TYPE name', () => {
  const enums = loadDialect('ardupilotmega').enums;
  const p = projectParam(paramValue({ type: 9 }).fields, enums);
  assert.strictEqual(p.param_id, 'RC1_MIN');
  assert.strictEqual(p.param_type, 9);
  assert.strictEqual(p.param_type_name, 'MAV_PARAM_TYPE_REAL32');
});

test('ParamRead by name completes on the matching PARAM_VALUE', async () => {
  const conn = new FakeConnection();
  const wf = new ParamRead({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'RC1_MIN' });
  const p = wf.run();
  // A non-matching id must be ignored.
  conn.deliverParamValue(paramValue({ id: 'RC2_MIN', value: 900 }));
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 1100 }));
  const res = await p;
  assert.strictEqual(res.topic, 'param/value');
  assert.strictEqual(res.payload.param_id, 'RC1_MIN');
  assert.strictEqual(res.payload.param_value, 1100);
  const req = conn.sent.find((m) => m.name === 'PARAM_REQUEST_READ');
  assert.ok(req);
  assert.strictEqual(req.fields.param_index, -1); // read-by-name uses index -1
});

test('ParamRead by index matches on param_index', async () => {
  const conn = new FakeConnection();
  const wf = new ParamRead({ connection: conn, targetSystem: 1, targetComponent: 1, paramIndex: 5 });
  const p = wf.run();
  conn.deliverParamValue(paramValue({ id: 'OTHER', index: 4 }));
  conn.deliverParamValue(paramValue({ id: 'RC5', index: 5, value: 42 }));
  const res = await p;
  assert.strictEqual(res.payload.param_index, 5);
  assert.strictEqual(res.payload.param_value, 42);
});

test('ParamRead requires an id or index', () => {
  assert.throws(
    () => new ParamRead({ connection: new FakeConnection(), targetSystem: 1, targetComponent: 1 }),
    (e) => e.code === 'BAD_PARAM_READ'
  );
});

test('ParamSet confirms via the echoed value and flags applied', async () => {
  const conn = new FakeConnection();
  const wf = new ParamSet({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'RC1_MIN', value: 1100 });
  const p = wf.run();
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 1100 }));
  const res = await p;
  assert.strictEqual(res.topic, 'param/set');
  assert.strictEqual(res.payload.applied, true);
  assert.strictEqual(res.payload.requested_value, 1100);
  const set = conn.sent.find((m) => m.name === 'PARAM_SET');
  assert.ok(set);
  assert.strictEqual(set.fields.param_id, 'RC1_MIN');
  assert.strictEqual(set.fields.param_value, 1100);
});

test('ParamSet flags applied=false when the vehicle clamps the value', async () => {
  const conn = new FakeConnection();
  const wf = new ParamSet({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'RC1_MIN', value: 5000 });
  const p = wf.run();
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 2000 })); // clamped
  const res = await p;
  assert.strictEqual(res.payload.applied, false);
  assert.strictEqual(res.payload.param_value, 2000);
});

test('ParamSet requires a numeric value', () => {
  assert.throws(
    () => new ParamSet({ connection: new FakeConnection(), targetSystem: 1, targetComponent: 1, paramId: 'X' }),
    (e) => e.code === 'BAD_PARAM_SET'
  );
});

test('ParamList assembles the full list in index order', async () => {
  const conn = new FakeConnection();
  const wf = new ParamList({ connection: conn, targetSystem: 1, targetComponent: 1 });
  const p = wf.run();
  conn.deliverParamValue(paramValue({ id: 'B', index: 1, count: 3, value: 2 }));
  conn.deliverParamValue(paramValue({ id: 'A', index: 0, count: 3, value: 1 }));
  conn.deliverParamValue(paramValue({ id: 'C', index: 2, count: 3, value: 3 }));
  const res = await p;
  assert.strictEqual(res.topic, 'param/list');
  assert.strictEqual(res.payload.count, 3);
  assert.deepStrictEqual(res.payload.params.map((x) => x.param_index), [0, 1, 2]);
  assert.deepStrictEqual(res.payload.params.map((x) => x.param_id), ['A', 'B', 'C']);
});

test('ParamList re-requests a dropped item by index', async () => {
  const conn = new FakeConnection();
  const wf = new ParamList({
    connection: conn,
    targetSystem: 1,
    targetComponent: 1,
    timeoutMs: 20,
    maxRetries: 5
  });
  const p = wf.run();
  conn.deliverParamValue(paramValue({ id: 'A', index: 0, count: 3 }));
  conn.deliverParamValue(paramValue({ id: 'C', index: 2, count: 3 })); // index 1 dropped
  // After the stream stalls, the workflow should re-request the missing index.
  await delay(40);
  const refill = conn.sent.find((m) => m.name === 'PARAM_REQUEST_READ' && m.fields.param_index === 1);
  assert.ok(refill, 'expected a PARAM_REQUEST_READ for the missing index 1');
  conn.deliverParamValue(paramValue({ id: 'B', index: 1, count: 3 }));
  const res = await p;
  assert.strictEqual(res.payload.count, 3);
  assert.deepStrictEqual(res.payload.params.map((x) => x.param_index), [0, 1, 2]);
});

test('ParamRead times out after exhausting retries', async () => {
  const conn = new FakeConnection();
  const wf = new ParamRead({
    connection: conn,
    targetSystem: 1,
    targetComponent: 1,
    paramId: 'NEVER',
    timeoutMs: 10,
    maxRetries: 1
  });
  // The workflow's retransmit timers are unref'd (so production never keeps the
  // process open); hold a ref'd timer so the loop stays alive for this test.
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(wf.run(), (e) => e.code === 'PARAM_TIMEOUT');
  } finally {
    clearInterval(keepAlive);
  }
});
