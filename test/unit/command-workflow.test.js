'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { CommandSend } = require('../../lib/command/command-workflow');
const { resolveFlightMode, knownModes } = require('../../lib/command/flight-modes');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ENUMS = loadDialect('ardupilotmega').enums;

/** Minimal connection stand-in (same shape as the mission/param test fakes). */
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

  deliverAck(fields, sysid = 1) {
    for (const { cb } of this._subs.values()) {
      cb({ topic: 'mavlink/COMMAND_ACK', payload: { name: 'COMMAND_ACK', sysid, compid: 1, fields } });
    }
  }
}

function opts(conn, extra = {}) {
  return Object.assign(
    {
      connection: conn,
      targetSystem: 1,
      targetComponent: 1,
      enums: ENUMS,
      command: 'MAV_CMD_COMPONENT_ARM_DISARM',
      fields: { param1: 1 },
      timeoutMs: 30,
      maxRetries: 2
    },
    extra
  );
}

test('CommandSend resolves on MAV_RESULT_ACCEPTED with readable names (#16)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn));
  const p = wf.run();
  await delay(0);
  const sent = conn.sent[0];
  assert.strictEqual(sent.name, 'COMMAND_LONG');
  assert.strictEqual(sent.fields.command, 400); // resolved MAV_CMD number
  assert.strictEqual(sent.fields.confirmation, 0);
  conn.deliverAck({ command: 400, result: 0 });
  const res = await p;
  assert.strictEqual(res.topic, 'command/ack');
  assert.strictEqual(res.payload.result, 0);
  assert.strictEqual(res.payload.result_name, 'MAV_RESULT_ACCEPTED');
  assert.strictEqual(res.payload.command_name, 'MAV_CMD_COMPONENT_ARM_DISARM');
});

test('CommandSend ignores acks for other commands and other systems (#16)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { timeoutMs: 1000, maxRetries: 0 }));
  const p = wf.run();
  await delay(0);
  conn.deliverAck({ command: 22, result: 0 }); // different command
  conn.deliverAck({ command: 400, result: 0 }, 7); // different sysid
  assert.strictEqual(wf.state, 'waiting_ack');
  conn.deliverAck({ command: 400, result: 0 });
  await p;
});

test('CommandSend retransmits with incrementing confirmation, then times out (#16)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { timeoutMs: 15, maxRetries: 2 }));
  const keepAlive = setInterval(() => {}, 5); // workflow timers are unref'd
  try {
    await assert.rejects(wf.run(), (e) => e.code === 'COMMAND_TIMEOUT');
  } finally {
    clearInterval(keepAlive);
  }
  assert.strictEqual(conn.sent.length, 3); // initial + 2 retries
  assert.deepStrictEqual(conn.sent.map((m) => m.fields.confirmation), [0, 1, 2]);
});

test('CommandSend rejects with the MAV_RESULT name on denial (#16)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { timeoutMs: 1000, maxRetries: 0 }));
  const p = wf.run();
  await delay(0);
  conn.deliverAck({ command: 400, result: 2 }); // MAV_RESULT_DENIED
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, 'COMMAND_REJECTED');
    assert.match(e.message, /MAV_RESULT_DENIED/);
    assert.strictEqual(e.context.result, 2);
    return true;
  });
});

test('CommandSend keeps waiting through MAV_RESULT_IN_PROGRESS (#16)', async () => {
  const conn = new FakeConnection();
  const progress = [];
  const wf = new CommandSend(
    opts(conn, { timeoutMs: 1000, maxRetries: 0, onProgress: (p) => progress.push(p.payload) })
  );
  const p = wf.run();
  await delay(0);
  conn.deliverAck({ command: 400, result: 5, progress: 40 });
  assert.strictEqual(wf.state, 'in_progress');
  conn.deliverAck({ command: 400, result: 0 });
  const res = await p;
  assert.strictEqual(res.payload.result, 0);
  assert.ok(progress.some((x) => x.state === 'in_progress' && x.progress === 40));
});

test('CommandSend COMMAND_INT omits confirmation and resends unchanged (#17)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(
    opts(conn, {
      command: 'MAV_CMD_DO_REPOSITION',
      useInt: true,
      fields: { frame: 6, x: 473977420, y: 85455940, z: 30 },
      timeoutMs: 15,
      maxRetries: 1
    })
  );
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(wf.run(), (e) => e.code === 'COMMAND_TIMEOUT');
  } finally {
    clearInterval(keepAlive);
  }
  assert.strictEqual(conn.sent.length, 2);
  for (const m of conn.sent) {
    assert.strictEqual(m.name, 'COMMAND_INT');
    assert.strictEqual(m.fields.confirmation, undefined); // COMMAND_INT has none
    assert.strictEqual(m.fields.x, 473977420);
  }
});

test('CommandSend fails fast on an unresolvable command name', () => {
  assert.throws(
    () => new CommandSend(opts(new FakeConnection(), { command: 'MAV_CMD_ARM_DISRAM' })),
    (e) => e.code === 'BAD_COMMAND'
  );
});

test('resolveFlightMode maps ArduPilot modes per vehicle type (#20)', () => {
  assert.deepStrictEqual(resolveFlightMode('ardupilot', 'copter', 'GUIDED'), { base_mode: 1, custom_mode: 4 });
  assert.deepStrictEqual(resolveFlightMode('ardupilot', 'plane', 'GUIDED'), { base_mode: 1, custom_mode: 15 });
  assert.deepStrictEqual(resolveFlightMode('ardupilot', 'rover', 'AUTO'), { base_mode: 1, custom_mode: 10 });
  assert.deepStrictEqual(resolveFlightMode('ardupilot', 'boat', 'AUTO'), { base_mode: 1, custom_mode: 10 });
  // Case/spacing tolerant.
  assert.deepStrictEqual(resolveFlightMode('ardupilot', 'copter', 'alt hold'), { base_mode: 1, custom_mode: 2 });
});

test('resolveFlightMode maps PX4 main/sub modes (#20)', () => {
  // POSITION -> POSCTL main 3.
  assert.deepStrictEqual(resolveFlightMode('px4', 'copter', 'POSITION'), {
    base_mode: 1,
    custom_mode: (3 << 16) >>> 0
  });
  // MISSION -> AUTO(4).MISSION(4).
  assert.deepStrictEqual(resolveFlightMode('px4', 'copter', 'MISSION'), {
    base_mode: 1,
    custom_mode: ((4 << 16) | (4 << 24)) >>> 0
  });
  // RTL alias RETURN -> AUTO(4).RTL(5).
  assert.deepStrictEqual(resolveFlightMode('px4', 'copter', 'RETURN'), {
    base_mode: 1,
    custom_mode: ((4 << 16) | (5 << 24)) >>> 0
  });
});

test('resolveFlightMode fails loudly for unknown modes/firmware (#20)', () => {
  assert.throws(() => resolveFlightMode('ardupilot', 'copter', 'WARP_SPEED'), (e) => e.code === 'UNKNOWN_MODE');
  assert.throws(() => resolveFlightMode('generic', 'copter', 'GUIDED'), (e) => e.code === 'UNKNOWN_MODE');
  assert.ok(knownModes('ardupilot', 'copter').includes('GUIDED'));
  assert.ok(knownModes('px4').includes('OFFBOARD'));
  assert.deepStrictEqual(knownModes('generic', 'copter'), []);
});

test('CommandSend ignores acks from a different component on the same system', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { targetComponent: 1, timeoutMs: 1000, maxRetries: 0 }));
  const p = wf.run();
  await delay(0);
  // A gimbal (compid 154) acking the same MAV_CMD must not settle us.
  for (const { cb } of conn._subs.values()) {
    cb({ topic: 'mavlink/COMMAND_ACK', payload: { name: 'COMMAND_ACK', sysid: 1, compid: 154, fields: { command: 400, result: 2 } } });
  }
  assert.strictEqual(wf.state, 'waiting_ack');
  // The addressed component's ack does.
  for (const { cb } of conn._subs.values()) {
    cb({ topic: 'mavlink/COMMAND_ACK', payload: { name: 'COMMAND_ACK', sysid: 1, compid: 1, fields: { command: 400, result: 0 } } });
  }
  await p;
});

test('CommandSend with broadcast component accepts any responder', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { targetComponent: 0, timeoutMs: 1000, maxRetries: 0 }));
  const p = wf.run();
  await delay(0);
  for (const { cb } of conn._subs.values()) {
    cb({ topic: 'mavlink/COMMAND_ACK', payload: { name: 'COMMAND_ACK', sysid: 1, compid: 154, fields: { command: 400, result: 0 } } });
  }
  await p;
});
