'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MAV_COMP_ID, DEFAULT_TARGET_COMPONENT } = require('../../lib/payload/components');

/**
 * Payload component addressing (#155 item 3). The camera/gimbal verbs default to
 * the autopilot component — a deliberate default (ArduPilot's onboard driver
 * answers there), not an accident — while a standalone MAVLink camera (100) or
 * gimbal (154) can be addressed explicitly. These tests pin the well-known ids
 * and confirm the node's default/override behavior.
 */

test('well-known component ids and the default are the documented values', () => {
  assert.strictEqual(MAV_COMP_ID.AUTOPILOT1, 1);
  assert.strictEqual(MAV_COMP_ID.CAMERA, 100);
  assert.strictEqual(MAV_COMP_ID.GIMBAL, 154);
  /** The unspecified-everywhere default is the autopilot component. */
  assert.strictEqual(DEFAULT_TARGET_COMPONENT, 1);
});

/**
 * A minimal valid profile that intentionally supplies no defaultTargetComponent,
 * so the payload node must fall back to DEFAULT_TARGET_COMPONENT.
 */
function profileWithoutComponentDefault(id) {
  const bundle = loadDialect('common');
  return {
    id,
    name: 'NoCompDefault',
    isValid: () => true,
    getDialect: () => bundle,
    getDefaults: () => ({ defaultTargetSystem: 1 })
  };
}

function setup(profile, payloadConfig) {
  const RED = new MockRED().loadNodes();
  RED._nodes.set(profile.id, profile);
  const node = RED.create(
    'mavlink-ai-payload',
    Object.assign({ id: 'pl1', profile: profile.id, connection: '' }, payloadConfig)
  );
  return { RED, node };
}

test('a camera verb with no component set falls back to the autopilot component (#155)', async () => {
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/send');
  assert.strictEqual(collected[0].payload.target_component, DEFAULT_TARGET_COMPONENT);
});

test('a camera verb honors an explicit per-message component (a standalone camera) (#155)', async () => {
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo' });
  const { collected } = await RED.inject(node, { payload: { target_component: MAV_COMP_ID.CAMERA } });
  assert.strictEqual(collected[0].payload.target_component, 100);
});

test('the node-configured component wins over the fallback for a gimbal verb (#155)', async () => {
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), {
    action: 'gimbal_aim',
    targetComponent: String(MAV_COMP_ID.GIMBAL)
  });
  const { collected } = await RED.inject(node, { payload: { pitch: -20 } });
  assert.strictEqual(collected[0].payload.target_component, 154);
});
