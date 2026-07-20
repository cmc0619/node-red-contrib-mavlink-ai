'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * Focused coverage for the Build node (#282). Until now its input handler had
 * no unit tests at all — only the #102 runtime smoke-load, which never injects
 * a message — and lib/protocol/message-validator.js is reachable ONLY through
 * this node, so its behavior was equally unpinned. These tests pin the node's
 * observable contracts (§13.3 / §14.2) ahead of any refactor of the path.
 */

function setup(buildConfig) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    defaultTargetSystem: 3,
    defaultTargetComponent: 4
  });
  const node = RED.create('mavlink-ai-build', Object.assign({ id: 'b1', profile: 'p1' }, buildConfig));
  return { RED, node };
}

test('valid construction: §14.2 envelope with normalized fields and profile reference', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT' });
  const { collected, err } = await RED.inject(node, { payload: { type: 2, autopilot: 3 } });
  assert.strictEqual(err, undefined);
  const out = collected[0];
  assert.strictEqual(out.topic, 'mavlink/send');
  assert.strictEqual(out.payload.name, 'HEARTBEAT');
  assert.strictEqual(out.payload.fields.type, 2);
  assert.strictEqual(out.payload.fields.autopilot, 3);
  assert.strictEqual(out.payload.vehicleProfile, 'p1', 'canonical config-node id reference');
  assert.strictEqual(out.payload.vehicleProfileName, 'Copter', 'display name rides along');
});

test('default targets from the profile apply, and applyDefaults:false omits them', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT' });
  const { collected } = await RED.inject(node, { payload: { type: 2 } });
  assert.strictEqual(collected[0].payload.target_system, 3);
  assert.strictEqual(collected[0].payload.target_component, 4);

  const bare = setup({ messageName: 'HEARTBEAT', applyDefaults: false });
  const result = await bare.RED.inject(bare.node, { payload: { type: 2 } });
  assert.ok(!('target_system' in result.collected[0].payload), 'no injected target without applyDefaults');
  assert.ok(!('target_component' in result.collected[0].payload));
});

test('bitmask checklist output: a numeric-string type_mask carries the combined value', async () => {
  /** The editor's additive checklist persists the OR-combined value as one
   * number ("5" = roll|yaw rate ignore); the runtime must accept it as-is. */
  const { RED, node } = setup({ messageName: 'ATTITUDE_TARGET', fields: '{"type_mask":"5"}' });
  const { collected, err } = await RED.inject(node, { payload: {} });
  assert.strictEqual(err, undefined);
  assert.strictEqual(collected[0].topic, 'mavlink/send');
  assert.strictEqual(collected[0].payload.fields.type_mask, 5);
});

test('payload arrays OR-combine on scalar bitmask fields and reject elsewhere', async () => {
  const { RED, node } = setup({ messageName: 'ATTITUDE_TARGET' });
  const { collected } = await RED.inject(node, {
    payload: {
      type_mask: ['ATTITUDE_TARGET_TYPEMASK_BODY_ROLL_RATE_IGNORE', 'ATTITUDE_TARGET_TYPEMASK_BODY_YAW_RATE_IGNORE']
    }
  });
  assert.strictEqual(collected[0].topic, 'mavlink/send');
  assert.strictEqual(collected[0].payload.fields.type_mask, 5, 'flags are additive, not mutually exclusive');

  /** An array on an exclusive-enum scalar is a caller bug, surfaced as the
   * structured error instead of leaking an array into the scalar writer. */
  const bad = setup({ messageName: 'HEARTBEAT' });
  const result = await bad.RED.inject(bad.node, { payload: { type: ['MAV_TYPE_QUADROTOR', 'MAV_TYPE_GCS'] } });
  assert.strictEqual(result.collected[0].topic, 'mavlink/error');
  assert.strictEqual(result.collected[0].payload.code, 'FIELD_NOT_ARRAY');
});

test('an explicit target_system in the payload wins over the profile default', async () => {
  const { RED, node } = setup({ messageName: 'COMMAND_LONG' });
  const { collected } = await RED.inject(node, { payload: { command: 'MAV_CMD_DO_SET_SERVO', target_system: 7 } });
  assert.strictEqual(collected[0].payload.target_system, 7);
  assert.strictEqual(collected[0].payload.target_component, 4, 'unspecified component still defaults');
});

test('unknown message name yields the structured UNKNOWN_MESSAGE error', async () => {
  const { RED, node } = setup({ messageName: 'NOT_A_MESSAGE' });
  const { collected, err } = await RED.inject(node, { payload: {} });
  assert.strictEqual(err, undefined, 'error is delivered on the output, not via done(err)');
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'UNKNOWN_MESSAGE');
  assert.match(collected[0].payload.message, /NOT_A_MESSAGE/);
});

test('malformed static fields JSON fails as INVALID_CONFIG, not a zero-filled message (#204)', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT', fields: '{not json' });
  assert.strictEqual(node.statusHistory[node.statusHistory.length - 1].text, 'invalid config');
  const { collected } = await RED.inject(node, { payload: { type: 2 } });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'INVALID_CONFIG');
});

test('a missing/invalid profile fails as INVALID_PROFILE on input', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-build', { id: 'b1', messageName: 'HEARTBEAT' });
  const { collected } = await RED.inject(node, { payload: { type: 2 } });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'INVALID_PROFILE');
});

test('reserved envelope keys are stripped from a direct payload, silently', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT' });
  /**
   * When the payload is used directly as the field set, the §14.2 envelope
   * keys must neither leak into the MAVLink fields nor produce spurious
   * unknown-field warnings.
   */
  const { collected } = await RED.inject(node, {
    payload: {
      name: 'HEARTBEAT',
      fields: null,
      vehicleProfile: 'ignored',
      localIdentity: '',
      profile: 'ignored',
      type: 2
    }
  });
  const fields = collected[0].payload.fields;
  assert.strictEqual(fields.type, 2);
  for (const reserved of ['name', 'vehicleProfile', 'localIdentity', 'profile']) {
    assert.ok(!(reserved in fields), `reserved key '${reserved}' must not become a MAVLink field`);
  }
  assert.deepStrictEqual(node.warnings, [], 'reserved keys are not warned as unknown fields');
});

test('an explicit payload.fields object is used as-is and payload wins over config fields', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT', fields: '{"type":1,"autopilot":8}' });
  const viaFields = await RED.inject(node, { payload: { fields: { type: 6 } } });
  assert.strictEqual(viaFields.collected[0].payload.fields.type, 6);

  const merged = setup({ messageName: 'HEARTBEAT', fields: '{"type":1,"autopilot":8}' });
  const result = await merged.RED.inject(merged.node, { payload: { type: 2 } });
  assert.strictEqual(result.collected[0].payload.fields.type, 2, 'payload overrides config');
  assert.strictEqual(result.collected[0].payload.fields.autopilot, 8, 'config fills the rest');
});

test('unknown fields warn but do not block the message', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT' });
  const { collected } = await RED.inject(node, { payload: { type: 2, bogus_field: 1 } });
  assert.strictEqual(collected[0].topic, 'mavlink/send', 'message still built');
  assert.strictEqual(node.warnings.length, 1);
  assert.match(node.warnings[0], /bogus_field/);
});

test('enum names resolve against the profile dialect; a misspelled name is a structured error', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT' });
  const ok = await RED.inject(node, { payload: { type: 'MAV_TYPE_QUADROTOR' } });
  assert.strictEqual(ok.collected[0].topic, 'mavlink/send');

  const bad = setup({ messageName: 'HEARTBEAT' });
  const { collected, err } = await bad.RED.inject(bad.node, { payload: { type: 'MAV_TYPE_QUADROTORZ' } });
  assert.strictEqual(err, undefined);
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'UNRESOLVED_FIELD_VALUE');
});

test('msg.messageName overrides the configured message', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT' });
  const { collected } = await RED.inject(node, {
    messageName: 'PARAM_REQUEST_LIST',
    payload: { target_system: 1, target_component: 1 }
  });
  assert.strictEqual(collected[0].payload.name, 'PARAM_REQUEST_LIST');
});

test('an explicit localIdentity request rides along untouched; absent stays absent (#228)', async () => {
  const { RED, node } = setup({ messageName: 'HEARTBEAT' });
  const withId = await RED.inject(node, { payload: { type: 2, localIdentity: 'id9' } });
  assert.strictEqual(withId.collected[0].payload.localIdentity, 'id9');

  const without = setup({ messageName: 'HEARTBEAT' });
  const result = await without.RED.inject(without.node, { payload: { type: 2 } });
  assert.ok(!('localIdentity' in result.collected[0].payload), 'never derived from the Vehicle Profile');
});
