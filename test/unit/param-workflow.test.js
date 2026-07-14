'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const {
  trimParamId,
  projectParam,
  unionIntToFloat,
  unionFloatToInt,
  ParamRead,
  ParamSet,
  ParamSetAuto,
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

test('ParamRead ignores a PARAM_VALUE from a different component (#67)', async () => {
  const conn = new FakeConnection();
  const wf = new ParamRead({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'RC1_MIN' });
  const p = wf.run();
  // Same sysid + matching param_id, but a different component (e.g. a gimbal)
  // must not settle a read aimed at component 1.
  conn.deliverParamValue(Object.assign(paramValue({ id: 'RC1_MIN', value: 999 }), { compid: 2 }));
  // The addressed component's echo settles it with the right value.
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 1100 }));
  const res = await p;
  assert.strictEqual(res.payload.param_value, 1100);
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

test('ParamSet flags applied=true across the float32 wire round-trip (#25)', async () => {
  const conn = new FakeConnection();
  const wf = new ParamSet({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'ANGLE_MAX', value: 0.1 });
  const p = wf.run();
  // The vehicle stores/echoes float32: fround(0.1) !== 0.1 in float64 terms.
  conn.deliverParamValue(paramValue({ id: 'ANGLE_MAX', value: Math.fround(0.1) }));
  const res = await p;
  assert.strictEqual(res.payload.applied, true);
});

test('Param read/set matches param ids case-insensitively (#26)', async () => {
  const conn = new FakeConnection();
  const read = new ParamRead({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'rc1_min' });
  const p = read.run();
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 1100 }));
  const res = await p;
  assert.strictEqual(res.payload.param_id, 'RC1_MIN');
  // The outbound request carries the uppercased id.
  const req = conn.sent.find((m) => m.name === 'PARAM_REQUEST_READ');
  assert.strictEqual(req.fields.param_id, 'RC1_MIN');

  const conn2 = new FakeConnection();
  const set = new ParamSet({ connection: conn2, targetSystem: 1, targetComponent: 1, paramId: 'rc1_min', value: 1200 });
  const p2 = set.run();
  conn2.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 1200 }));
  const res2 = await p2;
  assert.strictEqual(res2.payload.applied, true);
});

test('PX4 byte-union helpers round-trip integer values (#27)', () => {
  // INT32 (type 6)
  assert.strictEqual(unionFloatToInt(unionIntToFloat(1, 6), 6), 1);
  assert.strictEqual(unionFloatToInt(unionIntToFloat(-42, 6), 6), -42);
  assert.strictEqual(unionFloatToInt(unionIntToFloat(123456789, 6), 6), 123456789);
  // UINT8 (type 1)
  assert.strictEqual(unionFloatToInt(unionIntToFloat(255, 1), 1), 255);
  // INT16 (type 4)
  assert.strictEqual(unionFloatToInt(unionIntToFloat(-1000, 4), 4), -1000);
  // The union float of INT32 1 is a denormal, not 1.0 — the whole point.
  assert.notStrictEqual(unionIntToFloat(1, 6), 1);
});

test('projectParam decodes byte-union integers when firmware is px4 (#27)', () => {
  const fields = paramValue({ id: 'SYS_AUTOSTART', value: unionIntToFloat(4001, 6), type: 6 }).fields;
  const px4 = projectParam(fields, null, { firmware: 'px4' });
  assert.strictEqual(px4.param_value, 4001);
  assert.strictEqual(px4.param_raw_value, unionIntToFloat(4001, 6));
  // Non-px4 firmware leaves the wire value alone.
  const generic = projectParam(fields, null, { firmware: 'generic' });
  assert.strictEqual(generic.param_value, unionIntToFloat(4001, 6));
});

test('ParamSet encodes and confirms byte-union integers for px4 (#27)', async () => {
  const conn = new FakeConnection();
  const wf = new ParamSet({
    connection: conn,
    targetSystem: 1,
    targetComponent: 1,
    firmware: 'px4',
    paramId: 'SYS_AUTOSTART',
    paramType: 'MAV_PARAM_TYPE_INT32',
    enums: loadDialect('ardupilotmega').enums,
    value: 4001
  });
  const p = wf.run();
  const set = conn.sent.find((m) => m.name === 'PARAM_SET');
  assert.ok(set);
  // The wire value is the byte-union float, not the numeric cast.
  assert.strictEqual(set.fields.param_value, unionIntToFloat(4001, 6));
  conn.deliverParamValue(paramValue({ id: 'SYS_AUTOSTART', value: unionIntToFloat(4001, 6), type: 6 }));
  const res = await p;
  assert.strictEqual(res.payload.param_value, 4001);
  assert.strictEqual(res.payload.applied, true);
});

test('ParamList ignores the param_index 65535 sentinel (#28)', async () => {
  const conn = new FakeConnection();
  const wf = new ParamList({ connection: conn, targetSystem: 1, targetComponent: 1, timeoutMs: 20, maxRetries: 5 });
  const p = wf.run();
  conn.deliverParamValue(paramValue({ id: 'A', index: 0, count: 3, value: 1 }));
  // An unsolicited notification mid-stream must not count toward completion.
  conn.deliverParamValue(paramValue({ id: 'NOTIFY', index: 65535, count: 3, value: 9 }));
  conn.deliverParamValue(paramValue({ id: 'B', index: 1, count: 3, value: 2 }));
  conn.deliverParamValue(paramValue({ id: 'C', index: 2, count: 3, value: 3 }));
  const res = await p;
  assert.strictEqual(res.payload.count, 3);
  assert.deepStrictEqual(res.payload.params.map((x) => x.param_index), [0, 1, 2]);
  assert.ok(!res.payload.params.some((x) => x.param_id === 'NOTIFY'));
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

test('param workflow sends carry the profile reference end-to-end', async () => {
  const conn = new FakeConnection();
  const wf = new ParamRead({
    connection: conn,
    profile: 'p_routed',
    targetSystem: 1,
    targetComponent: 1,
    paramId: 'RC1_MIN',
    timeoutMs: 30,
    maxRetries: 1
  });
  const p = wf.run();
  await delay(40); // let one retransmit fire
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 1100 }));
  await p;
  assert.ok(conn.sent.length >= 2, 'expected the initial send plus a retransmit');
  for (const m of conn.sent) {
    assert.strictEqual(m.name, 'PARAM_REQUEST_READ');
    assert.strictEqual(m.profile, 'p_routed');
  }
});

test('param workflow without a profile sends no profile reference', async () => {
  const conn = new FakeConnection();
  const wf = new ParamRead({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'RC1_MIN' });
  const p = wf.run();
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 1100 }));
  await p;
  assert.ok(!('profile' in conn.sent[0]));
});

test('ParamSetAuto reads the type, then sets with it', async () => {
  const conn = new FakeConnection();
  const enums = loadDialect('ardupilotmega').enums;
  const wf = new ParamSetAuto({ connection: conn, targetSystem: 1, targetComponent: 1, enums, paramId: 'RC1_MIN', value: 3 });
  const p = wf.run();
  /** Let the detour read subscribe and send, then reply with UINT8 (type 1). */
  await delay(0);
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 9, type: 1 }));
  /** Let the set subscribe and send, then echo the applied value. */
  await delay(0);
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 3, type: 1 }));
  const result = await p;
  assert.deepStrictEqual(conn.sent.map((m) => m.name), ['PARAM_REQUEST_READ', 'PARAM_SET']);
  assert.strictEqual(conn.sent[1].fields.param_type, 1);
  assert.strictEqual(result.topic, 'param/set');
});

test('ParamSetAuto.abort during the detour read rejects and never sets', async () => {
  const conn = new FakeConnection();
  const wf = new ParamSetAuto({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'RC1_MIN', value: 3 });
  const p = wf.run();
  /** The detour read is now in flight; aborting must reject before any set. */
  await delay(0);
  wf.abort('closed');
  await assert.rejects(p, (e) => e.code === 'PARAM_ABORTED');
  assert.deepStrictEqual(conn.sent.map((m) => m.name), ['PARAM_REQUEST_READ']);
});

test('ParamSetAuto.abort during the set rejects after the type was detected', async () => {
  const conn = new FakeConnection();
  const wf = new ParamSetAuto({ connection: conn, targetSystem: 1, targetComponent: 1, paramId: 'RC1_MIN', value: 3 });
  const p = wf.run();
  /** Complete the detour read so the set becomes the in-flight child. */
  await delay(0);
  conn.deliverParamValue(paramValue({ id: 'RC1_MIN', value: 9, type: 1 }));
  await delay(0);
  wf.abort('closed');
  await assert.rejects(p, (e) => e.code === 'PARAM_ABORTED');
  assert.deepStrictEqual(conn.sent.map((m) => m.name), ['PARAM_REQUEST_READ', 'PARAM_SET']);
});
