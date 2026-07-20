'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { buildPayload } = require('../../lib/payload/payload');
const { LockManager } = require('../../lib/runtime/lock-manager');
const { fakeIdentity } = require('../helpers/v3-config');

const enums = loadDialect('ardupilotmega').enums;

/** A stub connection exposing just the send() the payload node uses. */
function fakeConnection() {
  const conn = { id: 'conn1', name: 'Conn', sent: [] };
  conn.send = (m) => {
    conn.sent.push(m);
    return Promise.resolve();
  };
  conn.resolveOutboundIdentity = () => fakeIdentity();
  return conn;
}

/**
 * A fuller connection stand-in for the await-ack path (#129): it exposes the
 * lock/subscribe/unsubscribe surface CommandSend needs and can deliver a
 * COMMAND_ACK to the workflow's subscription.
 */
function ackConnection() {
  const conn = { id: 'conn1', name: 'Conn', sent: [], _subs: new Map(), _id: 1, locks: new LockManager() };
  conn.acquireLock = (key, owner) => conn.locks.acquire(key, owner);
  conn.releaseLock = (key, owner) => conn.locks.release(key, owner);
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
  conn.deliverAck = (fields, sysid = 1) => {
    for (const cb of conn._subs.values()) {
      cb({ topic: 'mavlink/COMMAND_ACK', payload: { name: 'COMMAND_ACK', sysid, compid: 1, fields } });
    }
  };
  conn.resolveOutboundIdentity = () => fakeIdentity();
  return conn;
}

function setup(payloadConfig, { withConnection = false, ack = false } = {}) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  let conn = null;
  if (withConnection) {
    conn = ack ? ackConnection() : fakeConnection();
    RED._nodes.set('conn1', conn);
  }
  const node = RED.create(
    'mavlink-ai-payload',
    Object.assign(
      { id: 'pl1', profile: 'p1', delivery: 'build', connection: withConnection ? 'conn1' : '' },
      payloadConfig
    )
  );
  return { RED, node, conn };
}

test('buildPayload resolves the MAV_CMD and sets gripper action', () => {
  const grab = buildPayload('gripper', { enums, instance: 2, action: 'grab', targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(grab.name, 'COMMAND_LONG');
  assert.strictEqual(typeof grab.fields.command, 'number');
  assert.strictEqual(grab.fields.param1, 2);
  assert.strictEqual(grab.fields.param2, 1);
  const release = buildPayload('gripper', { enums, action: 'release' });
  assert.strictEqual(release.fields.param2, 0);
});

test('buildPayload rejects an unknown action and a servo with no PWM', () => {
  assert.throws(() => buildPayload('bogus', {}), (e) => e.code === 'BAD_PAYLOAD_ACTION');
  assert.throws(() => buildPayload('servo', { enums, instance: 1 }), (e) => e.code === 'BAD_SERVO');
});

test('take photo build-only emits COMMAND_LONG for IMAGE_START_CAPTURE', async () => {
  const { RED, node } = setup({ action: 'camera_photo', count: '3', targetComponent: '100' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(out.name, 'COMMAND_LONG');
  assert.strictEqual(out.fields.param3, 3);
  assert.strictEqual(out.target_component, 100);
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('servo action sends directly through a connection', async () => {
  const { RED, node, conn } = setup({ action: 'servo', delivery: 'send', instance: '9', pwm: '1900' }, { withConnection: true });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(conn.sent.length, 1);
  assert.strictEqual(conn.sent[0].fields.param1, 9);
  assert.strictEqual(conn.sent[0].fields.param2, 1900);
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'payload/sent');
  assert.strictEqual(out.payload.sent, true);
});

test('gimbal aim sets pitch/roll/yaw params in degrees', async () => {
  const { RED, node } = setup({ action: 'gimbal_aim', pitch: '-30', yaw: '90' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.param1, -30);
  assert.strictEqual(out.fields.param3, 90);
});

test('relay on/off maps to param2 1/0 and payload overrides the editor', async () => {
  const { RED, node } = setup({ action: 'relay', instance: '0', on: false });
  const { collected } = await RED.inject(node, { payload: { on: true } });
  assert.strictEqual(collected[0][0].payload.fields.param2, 1);
});

test('gimbal_manager_aim builds a GIMBAL_MANAGER_SET_PITCHYAW message in radians', () => {
  const aim = buildPayload('gimbal_manager_aim', { enums, pitch: -90, yaw: 45, yawLock: true, targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(aim.name, 'GIMBAL_MANAGER_SET_PITCHYAW');
  assert.ok(Math.abs(aim.fields.pitch - -Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(aim.fields.yaw - Math.PI / 4) < 1e-9);
  assert.strictEqual(aim.fields.flags, 16);
  assert.strictEqual(aim.fields.gimbal_device_id, 0);
  assert.ok(Number.isNaN(aim.fields.pitch_rate), 'unused rate is NaN (ignore), not 0');
  assert.ok(Number.isNaN(aim.fields.yaw_rate), 'unused rate is NaN (ignore), not 0');
  assert.strictEqual(aim.fields.target_system, 1);
});

test('gimbal manager aim sends the message (not a COMMAND_LONG) through a connection', async () => {
  const { RED, node, conn } = setup({ action: 'gimbal_manager_aim', delivery: 'send', pitch: '-45', yaw: '0' }, { withConnection: true });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(conn.sent[0].name, 'GIMBAL_MANAGER_SET_PITCHYAW');
  assert.ok(Math.abs(conn.sent[0].fields.pitch - -Math.PI / 4) < 1e-9);
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'payload/sent');
});

test('camera_mode maps friendly names to the CAMERA_MODE value', async () => {
  const { RED, node } = setup({ action: 'camera_mode', cameraMode: 'survey' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.name, 'COMMAND_LONG');
  assert.strictEqual(out.fields.param2, 2);
});

test('cam_trigger_distance sets the distance and rejects a negative value', async () => {
  const { RED, node } = setup({ action: 'cam_trigger_distance', distance: '25' });
  const ok = await RED.inject(node, { payload: {} });
  assert.strictEqual(ok.collected[0][0].payload.fields.param1, 25);

  const { RED: RED2, node: n2 } = setup({ action: 'cam_trigger_distance', distance: '' });
  const bad = await RED2.inject(n2, { payload: { distance: -5 } });
  assert.strictEqual(bad.collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(bad.collected[0][1].payload.code, 'BAD_TRIGGER_DISTANCE');
});

test('gimbal_manager_attitude builds a quaternion GIMBAL_MANAGER_SET_ATTITUDE with NaN rates (#129)', () => {
  const att = buildPayload('gimbal_manager_attitude', {
    enums, roll: 0, pitch: -90, yaw: 0, yawLock: true, targetSystem: 1, targetComponent: 1
  });
  assert.strictEqual(att.name, 'GIMBAL_MANAGER_SET_ATTITUDE');
  assert.strictEqual(att.fields.flags, 16);
  assert.strictEqual(att.fields.q.length, 4);
  /** -90° pitch (ZYX) → q = [cos45, 0, -sin45, 0]. */
  const h = Math.SQRT1_2;
  assert.ok(Math.abs(att.fields.q[0] - h) < 1e-9, 'w');
  assert.ok(Math.abs(att.fields.q[1] - 0) < 1e-9, 'x');
  assert.ok(Math.abs(att.fields.q[2] - -h) < 1e-9, 'y');
  assert.ok(Math.abs(att.fields.q[3] - 0) < 1e-9, 'z');
  assert.ok(Number.isNaN(att.fields.angular_velocity_x), 'unused rate is NaN (ignore), not 0');
  assert.ok(Number.isNaN(att.fields.angular_velocity_y));
  assert.ok(Number.isNaN(att.fields.angular_velocity_z));
});

test('camera_zoom / camera_focus map friendly types and reject unknown ones (#129)', () => {
  const zoom = buildPayload('camera_zoom', { enums, zoomType: 'range', zoomValue: 60, targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(zoom.name, 'COMMAND_LONG');
  assert.strictEqual(zoom.fields.param1, 2, 'ZOOM_TYPE_RANGE');
  assert.strictEqual(zoom.fields.param2, 60);
  const focus = buildPayload('camera_focus', { enums, focusType: 'auto', targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(focus.fields.param1, 4, 'FOCUS_TYPE_AUTO');
  assert.throws(() => buildPayload('camera_zoom', { enums, zoomType: 'bogus' }), (e) => e.code === 'BAD_ZOOM_TYPE');
  assert.throws(() => buildPayload('camera_focus', { enums, focusType: 'bogus' }), (e) => e.code === 'BAD_FOCUS_TYPE');
});

test('winch / parachute map friendly actions and reject unknown ones (#129)', () => {
  const winch = buildPayload('winch', { enums, instance: 1, winchAction: 'length', length: 3, rate: 0.5, targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(winch.name, 'COMMAND_LONG');
  assert.strictEqual(winch.fields.param2, 1, 'WINCH_RELATIVE_LENGTH_CONTROL');
  assert.strictEqual(winch.fields.param3, 3);
  assert.strictEqual(winch.fields.param4, 0.5);
  const chute = buildPayload('parachute', { enums, parachuteAction: 'release', targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(chute.fields.param1, 2, 'PARACHUTE_RELEASE');
  assert.throws(() => buildPayload('winch', { enums, winchAction: 'bogus' }), (e) => e.code === 'BAD_WINCH_ACTION');
  assert.throws(() => buildPayload('parachute', { enums, parachuteAction: 'bogus' }), (e) => e.code === 'BAD_PARACHUTE_ACTION');
});

test('parachute requires an explicit action — a missing one does not default to release (#129)', () => {
  /** PARACHUTE_RELEASE deploys the chute and kills the motors, so a bare
   * parachute payload must fail loudly rather than silently release. */
  assert.throws(() => buildPayload('parachute', { enums, targetSystem: 1, targetComponent: 1 }), (e) => e.code === 'BAD_PARACHUTE_ACTION');
});

test('repeat_servo pulses count/period and rejects a missing PWM; repeat_relay omits PWM (#129)', () => {
  const servo = buildPayload('repeat_servo', { enums, instance: 2, pwm: 1800, count: 4, period: 2, targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(servo.fields.param1, 2);
  assert.strictEqual(servo.fields.param2, 1800);
  assert.strictEqual(servo.fields.param3, 4);
  assert.strictEqual(servo.fields.param4, 2);
  assert.throws(() => buildPayload('repeat_servo', { enums, instance: 1 }), (e) => e.code === 'BAD_SERVO');
  const relay = buildPayload('repeat_relay', { enums, instance: 0, count: 3, period: 1, targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(relay.fields.param1, 0);
  assert.strictEqual(relay.fields.param2, 3);
  assert.strictEqual(relay.fields.param3, 1);
});

test('await on a COMMAND_LONG action resolves the COMMAND_ACK onto port 0 (#129)', async () => {
  const { RED, node, conn } = setup(
    { action: 'gripper', instance: '1', gripAction: 'grab', delivery: 'await', timeoutMs: '50', maxRetries: '1' },
    { withConnection: true, ack: true }
  );
  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(conn.sent.length, 1, 'command sent once');
  assert.strictEqual(conn.sent[0].name, 'COMMAND_LONG');
  conn.deliverAck({ command: conn.sent[0].fields.command, result: 0 });
  const { collected } = await injected;
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'command/ack');
  assert.strictEqual(out.payload.result, 0);
});

test('await-ack surfaces a rejected command as a structured error (#129)', async () => {
  const { RED, node, conn } = setup(
    { action: 'gripper', gripAction: 'grab', delivery: 'await', timeoutMs: '50', maxRetries: '0' },
    { withConnection: true, ack: true }
  );
  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));
  /** MAV_RESULT_DENIED = 3. */
  conn.deliverAck({ command: conn.sent[0].fields.command, result: 3 });
  const { collected } = await injected;
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'COMMAND_REJECTED');
});

test('await without a connection is a structured NO_CONNECTION error, not fire-and-forget (#129)', async () => {
  const { RED, node } = setup({ action: 'gripper', gripAction: 'grab', delivery: 'await' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'NO_CONNECTION');
});

test('await on a broadcast (target_system 0) is a structured BROADCAST_NO_ACK error (#129)', async () => {
  const { RED, node } = setup({ action: 'gripper', gripAction: 'grab', delivery: 'await' }, { withConnection: true, ack: true });
  const { collected } = await RED.inject(node, { payload: { target_system: 0 } });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'BROADCAST_NO_ACK');
});

test('await is skipped for a message verb (gimbal-manager degrades to a send) (#129)', async (t) => {
  const { RED, conn, node } = setup(
    { action: 'gimbal_manager_aim', delivery: 'await', pitch: '-45' },
    { withConnection: true, ack: true }
  );
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(conn.sent.length, 1, 'no ack awaited for a non-COMMAND_LONG verb — sent directly instead');
  assert.strictEqual(conn.sent[0].name, 'GIMBAL_MANAGER_SET_PITCHYAW');
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'payload/sent');
});

test('await-ack emits nothing and clears workflows when the node closes mid-flight (#129)', async () => {
  const { RED, node } = setup(
    { action: 'gripper', gripAction: 'grab', delivery: 'await', timeoutMs: '5000', maxRetries: '0' },
    { withConnection: true, ack: true }
  );
  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(node._active.size >= 1, 'a workflow is in flight before close');

  /** Redeploy/delete mid-flight must abort the wait without emitting a stale
   * COMMAND_ABORTED error from an obsolete node. */
  await RED.close(node);
  const { collected } = await injected;
  assert.strictEqual(collected.length, 0, 'no obsolete output after close');
  assert.strictEqual(node._active.size, 0, 'active workflows cleared on close');
});

test('missing profile emits MISSING_PROFILE', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-payload', { id: 'pl2', action: 'camera_photo', delivery: 'build' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'MISSING_PROFILE');
});

// --- Delivery modes (#207) ---------------------------------------------------

test('payload Build only emits mavlink/send on port 0, nothing on error', async (t) => {
  const { RED, node } = setup({ delivery: 'build', action: 'camera_photo' });
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].payload.name, 'COMMAND_LONG');
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('payload Send via connection emits payload/sent on port 0 (observable fire-and-forget)', async (t) => {
  const { RED, conn, node } = setup({ delivery: 'send', action: 'camera_photo' }, { withConnection: true });
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(conn.sent.length, 1, 'sent directly');
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'payload/sent');
  assert.strictEqual(out.payload.sent, true);
});

test('payload with no delivery set fails closed on the error port', async (t) => {
  const { RED, node } = setup({ action: 'camera_photo', delivery: undefined }); // no delivery
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: {} });
  const err = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(err.payload.code, 'DELIVERY_UNSET');
});

/**
 * Both Codex and Greptile flagged the same gap (#308): before this, a node
 * saved without a `delivery` value only failed at the first input, so it
 * looked healthy right after deploy. resolveDeliveryMode is now also called
 * at construct time, so the red badge appears immediately.
 */
test('payload node badges a construct-time DELIVERY_UNSET before any input (#308)', () => {
  const { node } = setup({ action: 'camera_photo', delivery: undefined }); // no delivery
  assert.ok(node._configError, 'node._configError set at construct time');
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });
});

/**
 * #308 review finding G1: the construct-time DELIVERY_UNSET badge above must
 * survive a `flows:started` refresh (e.g. an unrelated config-node redeploy)
 * instead of watchConfigBadge's own refresh silently clearing it to idle.
 */
test('payload node keeps the DELIVERY_UNSET badge across a flows:started refresh (#308 G1)', () => {
  const { RED, node } = setup({ action: 'camera_photo', delivery: undefined }); // no delivery
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });

  RED.events.emit('flows:started');

  assert.ok(node._configError, 'node._configError remains set after refresh');
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });
});

/**
 * #308 review finding G2: the Send (fire-and-forget) path awaits
 * connection.send() and, before this fix, emitted payload/sent unconditionally
 * once it resolved — even if the node closed mid-flight. Mirrors the
 * await-ack path's own close guard above.
 */
test('payload Send via connection emits nothing if the node closes before the in-flight send resolves (#308 G2)', async () => {
  const { RED, conn, node } = setup({ delivery: 'send', action: 'camera_photo' }, { withConnection: true });
  let resolveSend;
  conn.send = () => new Promise((resolve) => {
    resolveSend = resolve;
  });
  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));
  const closed = RED.close(node);
  resolveSend();
  const [{ collected }] = await Promise.all([injected, closed]);
  const sentOutput = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(sentOutput, undefined, 'no payload/sent output from a closed node');
});

test('payload Send & await result emits command/ack on port 0 for a COMMAND_LONG action', async (t) => {
  const { RED, conn, node } = setup(
    { delivery: 'await', action: 'gripper', gripAction: 'grab', timeoutMs: '50', maxRetries: '1' },
    { withConnection: true, ack: true }
  );
  t.after(() => RED.close(node));
  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));
  conn.deliverAck({ command: conn.sent[0].fields.command, result: 0 });
  const { collected } = await injected;
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'command/ack');
});

test('payload await on a non-COMMAND_LONG verb degrades to a send-confirm', async (t) => {
  const { RED, conn, node } = setup({ delivery: 'await', connection: 'conn1', action: 'gimbal_manager_aim', pitch: 10, yaw: 0 }, { withConnection: true, ack: true });
  t.after(() => RED.close(node));
  const sends = [];
  conn.send = (e) => { sends.push(e); return Promise.resolve(); };
  const { collected } = await RED.inject(node, { payload: { pitch: 10, yaw: 0 } });
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(collected.map((o) => o[0]).find(Boolean).topic, 'payload/sent');
});
