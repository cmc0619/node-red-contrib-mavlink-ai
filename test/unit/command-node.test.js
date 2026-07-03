'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

function setup(commandConfig) {
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
  const node = RED.create('mavlink-ai-command', Object.assign({ id: 'c1', profile: 'p1' }, commandConfig));
  return { RED, node };
}

test('preset arm builds COMMAND_LONG with fixed param1', async () => {
  const { RED, node } = setup({ command: 'arm' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0].payload;
  assert.strictEqual(out.name, 'COMMAND_LONG');
  assert.strictEqual(out.fields.command, 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.strictEqual(out.fields.param1, 1);
  assert.strictEqual(out.target_system, 1);
});

test('preset param1 override is ignored (safety-critical)', async () => {
  const { RED, node } = setup({ command: 'arm' });
  const { collected } = await RED.inject(node, { payload: { param1: 0 } });
  // arm's param1 must stay 1 despite the incoming override.
  assert.strictEqual(collected[0].payload.fields.param1, 1);
});

test('raw MAV_CMD selection builds a COMMAND_LONG with that command', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_SET_SERVO' });
  const { collected } = await RED.inject(node, { payload: { param1: 5, param2: 1500 } });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_SET_SERVO');
  assert.strictEqual(out.fields.param1, 5);
  assert.strictEqual(out.fields.param2, 1500);
});

test('raw MAV_CMD uses static config params (editor fields JSON)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_SET_SERVO', fields: '{"param1":9,"param2":1900}' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_SET_SERVO');
  assert.strictEqual(out.fields.param1, 9);
  assert.strictEqual(out.fields.param2, 1900);
});

test('stop_message_interval disables the stream (param2 = -1)', async () => {
  const { RED, node } = setup({ command: 'stop_message_interval' });
  const { collected } = await RED.inject(node, { payload: { message_id: 33 } });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_SET_MESSAGE_INTERVAL');
  assert.strictEqual(out.fields.param1, 33);
  assert.strictEqual(out.fields.param2, -1);
});

test('unknown command yields a structured error', async () => {
  const { RED, node } = setup({ command: 'not_a_command' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'UNKNOWN_COMMAND');
});

function setupWithFirmware(commandConfig, profileExtra) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', Object.assign({
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    sourceSystemId: 255,
    sourceComponentId: 190,
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  }, profileExtra));
  const node = RED.create('mavlink-ai-command', Object.assign({ id: 'c1', profile: 'p1' }, commandConfig));
  return { RED, node };
}

test('set_mode resolves a mode name via profile firmware/vehicle type (#20)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'set_mode' }, { firmware: 'ardupilot', profileType: 'copter' });
  const { collected } = await RED.inject(node, { payload: { mode: 'GUIDED' } });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_SET_MODE');
  assert.strictEqual(out.fields.param1, 1); // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
  assert.strictEqual(out.fields.param2, 4); // copter GUIDED
});

test('set_mode with an unknown mode name yields UNKNOWN_MODE (#20)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'set_mode' }, { firmware: 'ardupilot', profileType: 'copter' });
  const { collected } = await RED.inject(node, { payload: { mode: 'WARP_SPEED' } });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'UNKNOWN_MODE');
});

test('set_mode numeric custom_mode still works without a firmware table (#20)', async () => {
  const { RED, node } = setup({ command: 'set_mode' });
  const { collected } = await RED.inject(node, { payload: { custom_mode: 4 } });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.param2, 4);
});

test('sendAs int builds COMMAND_INT with degE7 lat/lon (#17)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_REPOSITION', sendAs: 'int' });
  const { collected } = await RED.inject(node, {
    payload: { lat: 47.397742, lon: 8.545594, alt: 30, param1: -1 }
  });
  const out = collected[0].payload;
  assert.strictEqual(out.name, 'COMMAND_INT');
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_REPOSITION');
  assert.strictEqual(out.fields.x, 473977420);
  assert.strictEqual(out.fields.y, 85455940);
  assert.strictEqual(out.fields.z, 30);
  assert.strictEqual(out.fields.param1, -1);
  assert.strictEqual(out.fields.frame, 'MAV_FRAME_GLOBAL');
  assert.strictEqual(out.fields.confirmation, undefined); // COMMAND_INT has none
  assert.strictEqual(out.fields.param5, undefined);
});

test('msg.payload.command_int switches a single message to COMMAND_INT (#17)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_SET_ROI_LOCATION' });
  const { collected } = await RED.inject(node, {
    payload: { command_int: true, x: 473977420, y: 85455940, z: 10, frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT' }
  });
  const out = collected[0].payload;
  assert.strictEqual(out.name, 'COMMAND_INT');
  assert.strictEqual(out.fields.x, 473977420);
  assert.strictEqual(out.fields.frame, 'MAV_FRAME_GLOBAL_RELATIVE_ALT');
});
