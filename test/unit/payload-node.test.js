'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { buildPayload } = require('../../lib/payload/payload');

const enums = loadDialect('ardupilotmega').enums;

/** A stub connection exposing just the send() the payload node uses. */
function fakeConnection() {
  const conn = { id: 'conn1', name: 'Conn', sent: [] };
  conn.send = (m) => {
    conn.sent.push(m);
    return Promise.resolve();
  };
  return conn;
}

function setup(payloadConfig, { withConnection = false } = {}) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    sourceSystemId: 255,
    sourceComponentId: 190,
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  let conn = null;
  if (withConnection) {
    conn = fakeConnection();
    RED._nodes.set('conn1', conn);
  }
  const node = RED.create(
    'mavlink-ai-payload',
    Object.assign({ id: 'pl1', profile: 'p1', connection: withConnection ? 'conn1' : '' }, payloadConfig)
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
  const out = collected[0].payload;
  assert.strictEqual(collected[0].topic, 'mavlink/send');
  assert.strictEqual(out.name, 'COMMAND_LONG');
  assert.strictEqual(out.fields.param3, 3);
  assert.strictEqual(out.target_component, 100);
});

test('servo action sends directly through a connection', async () => {
  const { RED, node, conn } = setup({ action: 'servo', instance: '9', pwm: '1900' }, { withConnection: true });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected.length, 0);
  assert.strictEqual(conn.sent.length, 1);
  assert.strictEqual(conn.sent[0].fields.param1, 9);
  assert.strictEqual(conn.sent[0].fields.param2, 1900);
});

test('gimbal aim sets pitch/roll/yaw params in degrees', async () => {
  const { RED, node } = setup({ action: 'gimbal_aim', pitch: '-30', yaw: '90' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.param1, -30);
  assert.strictEqual(out.fields.param3, 90);
});

test('relay on/off maps to param2 1/0 and payload overrides the editor', async () => {
  const { RED, node } = setup({ action: 'relay', instance: '0', on: false });
  const { collected } = await RED.inject(node, { payload: { on: true } });
  assert.strictEqual(collected[0].payload.fields.param2, 1);
});

test('missing profile emits MISSING_PROFILE', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-payload', { id: 'pl2', action: 'camera_photo' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'MISSING_PROFILE');
});
