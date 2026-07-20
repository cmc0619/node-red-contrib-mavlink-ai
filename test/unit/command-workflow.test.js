'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { minimal, ardupilotmega } = require('node-mavlink');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { CommandSend } = require('../../lib/command/command-workflow');
const { resolveFlightMode, knownModes, modeNameForCustomMode } = require('../../lib/command/flight-modes');
const { LockManager } = require('../../lib/runtime/lock-manager');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ARDU_BUNDLE = loadDialect('ardupilotmega');
const ENUMS = ARDU_BUNDLE.enums;
const modeContext = (firmware, vehicleType) => ({
  firmware,
  vehicleType,
  enums: ARDU_BUNDLE.enums,
  dialect: ARDU_BUNDLE.name
});

/** Minimal connection stand-in (same shape as the mission/param test fakes). */
class FakeConnection {
  constructor() {
    this.sent = [];
    this._subs = new Map();
    this._id = 1;
    this.locks = new LockManager();
  }

  acquireLock(key, owner) {
    return this.locks.acquire(key, owner);
  }

  releaseLock(key, owner) {
    return this.locks.release(key, owner);
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
      dialect: ARDU_BUNDLE.name,
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

test('CommandSend ignores an ack addressed to another GCS on a shared link (#99)', async () => {
  const conn = new FakeConnection();
  // Two GCSs (source system 255 = us, 254 = the other) send the same command to
  // the same vehicle; the vehicle's ack carries target_system/target_component
  // naming the GCS it answers.
  const wf = new CommandSend(opts(conn, {
    sourceSystem: 255,
    sourceComponent: 190,
    timeoutMs: 1000,
    maxRetries: 0
  }));
  const p = wf.run();
  await delay(0);
  // Right command/system/component but addressed to the other GCS: must not settle.
  conn.deliverAck({ command: 400, result: 0, target_system: 254, target_component: 190 });
  assert.strictEqual(wf.state, 'waiting_ack');
  // A different target_component (another component acting as GCS) is also ignored.
  conn.deliverAck({ command: 400, result: 0, target_system: 255, target_component: 191 });
  assert.strictEqual(wf.state, 'waiting_ack');
  // Addressed to our identity: settles.
  conn.deliverAck({ command: 400, result: 0, target_system: 255, target_component: 190 });
  const res = await p;
  assert.strictEqual(res.payload.result, 0);
});

test('CommandSend accepts broadcast or absent ack target fields for older variants (#99)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { sourceSystem: 255, sourceComponent: 190 }));
  const p = wf.run();
  await delay(0);
  // Broadcast target (0) and absent target fields both remain permissive.
  conn.deliverAck({ command: 400, result: 0, target_system: 0, target_component: 0 });
  const res = await p;
  assert.strictEqual(res.payload.result, 0);

  const conn2 = new FakeConnection();
  const wf2 = new CommandSend(opts(conn2, { sourceSystem: 255, sourceComponent: 190 }));
  const p2 = wf2.run();
  await delay(0);
  conn2.deliverAck({ command: 400, result: 0 }); // no target fields (older MAVLink)
  assert.strictEqual((await p2).payload.result, 0);
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

/**
 * After MAV_RESULT_IN_PROGRESS the vehicle owns the operation; a timeout must
 * extend the wait, not retransmit — a retransmit could restart a long-running
 * command (calibration, motor test) mid-run. Before #144, the IN_PROGRESS
 * branch reset the retry counter and re-armed a timeout whose expiry still
 * called _sendCommand(), so a second COMMAND_LONG went out.
 */
test('CommandSend does not retransmit after IN_PROGRESS; a later ACK still resolves it (#144)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { timeoutMs: 15, maxRetries: 3 }));
  const keepAlive = setInterval(() => {}, 5); /** workflow timers are unref'd */
  try {
    const p = wf.run();
    await delay(0);
    assert.strictEqual(conn.sent.length, 1); /** initial COMMAND_LONG */
    conn.deliverAck({ command: 400, result: 5, progress: 20 });
    assert.strictEqual(wf.state, 'in_progress');
    await delay(25); /** let a full timeout window elapse with no further ack */
    assert.strictEqual(conn.sent.length, 1); /** still no retransmit while in progress */
    conn.deliverAck({ command: 400, result: 0 });
    const res = await p;
    assert.strictEqual(res.payload.result, 0);
  } finally {
    clearInterval(keepAlive);
  }
});

/**
 * The extended wait is still bounded: if the vehicle stops reporting after
 * IN_PROGRESS, the workflow fails with COMMAND_TIMEOUT rather than hanging — and
 * without ever having retransmitted (#144).
 */
test('CommandSend times out (bounded) after IN_PROGRESS silence without retransmitting (#144)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { timeoutMs: 10, maxRetries: 2 }));
  const keepAlive = setInterval(() => {}, 5);
  try {
    const p = wf.run();
    await delay(0);
    conn.deliverAck({ command: 400, result: 5, progress: 10 });
    await assert.rejects(p, (e) => e.code === 'COMMAND_TIMEOUT');
  } finally {
    clearInterval(keepAlive);
  }
  assert.strictEqual(conn.sent.length, 1); /** never retransmitted while in progress */
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
  const base_mode = minimal.MavModeFlag.CUSTOM_MODE_ENABLED;
  assert.deepStrictEqual(resolveFlightMode(modeContext('ardupilot', 'copter'), 'GUIDED'), {
    base_mode,
    custom_mode: ardupilotmega.CopterMode.GUIDED
  });
  assert.deepStrictEqual(resolveFlightMode(modeContext('ardupilot', 'plane'), 'GUIDED'), {
    base_mode,
    custom_mode: ardupilotmega.PlaneMode.GUIDED
  });
  assert.deepStrictEqual(resolveFlightMode(modeContext('ardupilot', 'rover'), 'AUTO'), {
    base_mode,
    custom_mode: ardupilotmega.RoverMode.AUTO
  });
  assert.deepStrictEqual(resolveFlightMode(modeContext('ardupilot', 'boat'), 'AUTO'), {
    base_mode,
    custom_mode: ardupilotmega.RoverMode.AUTO
  });
});

test('ArduPilot modes expose generated additions and reverse-look-up generated values', () => {
  const plane = modeContext('ardupilot', 'plane');
  const rover = modeContext('ardupilot', 'rover');
  const sub = modeContext('ardupilot', 'sub');
  assert.ok(knownModes(plane).includes('INITIALIZING'));
  assert.ok(knownModes(rover).includes('INITIALIZING'));
  assert.ok(knownModes(sub).includes('SURFTRAK'));
  assert.deepStrictEqual(resolveFlightMode(plane, 'FLY_BY_WIRE_A'), {
    base_mode: minimal.MavModeFlag.CUSTOM_MODE_ENABLED,
    custom_mode: ardupilotmega.PlaneMode.FLY_BY_WIRE_A
  });
  assert.deepStrictEqual(resolveFlightMode(sub, 'MOTORDETECT'), {
    base_mode: minimal.MavModeFlag.CUSTOM_MODE_ENABLED,
    custom_mode: ardupilotmega.SubMode.MOTORDETECT
  });
  assert.strictEqual(modeNameForCustomMode(sub, ardupilotmega.SubMode.SURFTRAK), 'SURFTRAK');
  assert.strictEqual(modeNameForCustomMode(plane, ardupilotmega.PlaneMode.INITIALIZING), 'INITIALIZING');
});

test('ArduPilot mode resolution rejects aliases, normalization, and wrong case', () => {
  const cases = [
    [modeContext('ardupilot', 'plane'), 'FBWA'],
    [modeContext('ardupilot', 'plane'), 'FBWB'],
    [modeContext('ardupilot', 'sub'), 'MOTOR_DETECT'],
    [modeContext('ardupilot', 'antenna-tracker'), 'INITIALISING'],
    [modeContext('ardupilot', 'copter'), 'guided'],
    [modeContext('ardupilot', 'copter'), 'alt hold']
  ];
  for (const [context, name] of cases) {
    assert.throws(() => resolveFlightMode(context, name), (err) => err.code === 'UNKNOWN_MODE');
  }
});

/**
 * PX4 mode names resolve to a bare main mode in custom_mode and a bare sub mode
 * in custom_submode — the separate values DO_SET_MODE param2/param3 expect, not
 * the HEARTBEAT-packed word. POSITION -> POSCTL(3); MISSION -> AUTO(4).MISSION(4);
 * RETURN -> AUTO(4).RTL(5); OFFBOARD(6) is what a packed param2 would truncate to 0.
 */
test('resolveFlightMode maps PX4 main/sub modes as separate DO_SET_MODE params (#20, #136)', () => {
  const px4 = modeContext('px4', 'copter');
  assert.deepStrictEqual(resolveFlightMode(px4, 'POSITION'), {
    base_mode: minimal.MavModeFlag.CUSTOM_MODE_ENABLED,
    custom_mode: 3,
    custom_submode: 0
  });
  assert.deepStrictEqual(resolveFlightMode(px4, 'MISSION'), {
    base_mode: minimal.MavModeFlag.CUSTOM_MODE_ENABLED,
    custom_mode: 4,
    custom_submode: 4
  });
  assert.deepStrictEqual(resolveFlightMode(px4, 'RETURN'), {
    base_mode: minimal.MavModeFlag.CUSTOM_MODE_ENABLED,
    custom_mode: 4,
    custom_submode: 5
  });
  assert.deepStrictEqual(resolveFlightMode(px4, 'OFFBOARD'), {
    base_mode: minimal.MavModeFlag.CUSTOM_MODE_ENABLED,
    custom_mode: 6,
    custom_submode: 0
  });
});

test('splitPx4CustomMode splits packed values and passes bare main modes through (#136)', () => {
  const { splitPx4CustomMode } = require('../../lib/command/flight-modes');
  assert.deepStrictEqual(splitPx4CustomMode(((6 << 16) >>> 0)), { main: 6, sub: 0 });
  assert.deepStrictEqual(splitPx4CustomMode(((4 << 16) | (5 << 24)) >>> 0), { main: 4, sub: 5 });
  assert.strictEqual(splitPx4CustomMode(6), null);
  assert.strictEqual(splitPx4CustomMode('nope'), null);
  assert.strictEqual(splitPx4CustomMode(NaN), null);
});

test('resolveFlightMode fails loudly for unknown modes/firmware (#20)', () => {
  assert.throws(() => resolveFlightMode(modeContext('ardupilot', 'copter'), 'WARP_SPEED'), (e) => e.code === 'UNKNOWN_MODE');
  assert.throws(() => resolveFlightMode(modeContext('generic', 'copter'), 'GUIDED'), (e) => e.code === 'UNKNOWN_MODE');
  assert.ok(knownModes(modeContext('ardupilot', 'copter')).includes('GUIDED'));
  assert.ok(knownModes(modeContext('px4')).includes('OFFBOARD'));
  assert.deepStrictEqual(knownModes(modeContext('generic', 'copter')), []);
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

// --- Concurrent identical commands share no ACK (#82) ------------------------

test('a second identical ACK-waiting command fails fast with COMMAND_BUSY (#82)', async () => {
  const conn = new FakeConnection();
  const first = new CommandSend(opts(conn, { timeoutMs: 1000, maxRetries: 0 }));
  const p1 = first.run();
  await delay(0);
  assert.strictEqual(conn.sent.length, 1);

  // Identical command/target while the first still awaits its ack: must not
  // subscribe, must not send, must reject immediately.
  const second = new CommandSend(opts(conn, { timeoutMs: 1000, maxRetries: 0 }));
  await assert.rejects(second.run(), (err) => err.code === 'COMMAND_BUSY');
  assert.strictEqual(conn.sent.length, 1, 'the busy command sent nothing');

  // Exactly one workflow consumes the ack.
  conn.deliverAck({ command: 400, result: 0 });
  const res = await p1;
  assert.strictEqual(res.payload.result, 0);
});

test('different commands or targets are not serialized (#82)', async () => {
  const conn = new FakeConnection();
  const arm = new CommandSend(opts(conn, { timeoutMs: 1000, maxRetries: 0 }));
  const armOther = new CommandSend(opts(conn, { targetSystem: 2, timeoutMs: 1000, maxRetries: 0 }));
  const takeoff = new CommandSend(opts(conn, { command: 'MAV_CMD_NAV_TAKEOFF', fields: {}, timeoutMs: 1000, maxRetries: 0 }));
  const p1 = arm.run();
  const p2 = armOther.run();
  const p3 = takeoff.run();
  await delay(0);
  assert.strictEqual(conn.sent.length, 3, 'all three distinct workflows sent');
  conn.deliverAck({ command: 400, result: 0 }, 1);
  conn.deliverAck({ command: 400, result: 0 }, 2);
  conn.deliverAck({ command: 22, result: 0 }, 1);
  await Promise.all([p1, p2, p3]);
});

test('the command lock is released on every settle path (#82)', async () => {
  const conn = new FakeConnection();
  const key = 'command:1:1:400';

  // Accepted.
  const ok = new CommandSend(opts(conn));
  const pOk = ok.run();
  await delay(0);
  assert.strictEqual(conn.locks.isHeld(key), true);
  conn.deliverAck({ command: 400, result: 0 });
  await pOk;
  assert.strictEqual(conn.locks.isHeld(key), false);

  // Rejected result.
  const rejected = new CommandSend(opts(conn));
  const pRej = rejected.run();
  await delay(0);
  conn.deliverAck({ command: 400, result: 2 });
  await assert.rejects(pRej, (err) => err.code === 'COMMAND_REJECTED');
  assert.strictEqual(conn.locks.isHeld(key), false);

  // Timeout (workflow timers are unref'd, so keep the loop alive).
  const timedOut = new CommandSend(opts(conn, { timeoutMs: 10, maxRetries: 0 }));
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(timedOut.run(), (err) => err.code === 'COMMAND_TIMEOUT');
  } finally {
    clearInterval(keepAlive);
  }
  assert.strictEqual(conn.locks.isHeld(key), false);

  // Send failure.
  const failing = new CommandSend(opts(conn));
  conn.send = () => Promise.reject(new Error('boom'));
  await assert.rejects(failing.run());
  assert.strictEqual(conn.locks.isHeld(key), false);
  conn.send = (message) => {
    conn.sent.push(message);
    return Promise.resolve();
  };

  // Abort.
  const aborted = new CommandSend(opts(conn, { timeoutMs: 1000, maxRetries: 0 }));
  const pAbort = aborted.run();
  await delay(0);
  assert.strictEqual(conn.locks.isHeld(key), true);
  aborted.abort('node closed');
  await assert.rejects(pAbort, (err) => err.code === 'COMMAND_ABORTED');
  assert.strictEqual(conn.locks.isHeld(key), false);
});

// --- Profile propagation (#81) ------------------------------------------------

test('CommandSend carries its profile reference on every send, including retransmits', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn, { vehicleProfile: 'p_routed', timeoutMs: 20, maxRetries: 1 }));
  const p = wf.run();
  await delay(35); // let one retransmit fire
  conn.deliverAck({ command: 400, result: 0 });
  await p;
  assert.ok(conn.sent.length >= 2, 'expected the initial send plus a retransmit');
  for (const m of conn.sent) {
    assert.strictEqual(m.vehicleProfile, 'p_routed');
  }
});

test('CommandSend without a profile sends no profile reference (connection default applies)', async () => {
  const conn = new FakeConnection();
  const wf = new CommandSend(opts(conn));
  const p = wf.run();
  await delay(0);
  conn.deliverAck({ command: 400, result: 0 });
  await p;
  assert.ok(!('profile' in conn.sent[0]));
});
