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
