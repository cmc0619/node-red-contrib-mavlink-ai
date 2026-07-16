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

test('camera_photo sequence defaults to 1 only for single captures (spec: 0 for multi-shot)', async () => {
  const single = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo' });
  const one = await single.RED.inject(single.node, { payload: {} });
  assert.strictEqual(one.collected[0].payload.fields.param3, 1);
  assert.strictEqual(one.collected[0].payload.fields.param4, 1);

  const burst = setup(profileWithoutComponentDefault('p2'), { action: 'camera_photo' });
  const many = await burst.RED.inject(burst.node, { payload: { count: 5, interval: 1 } });
  assert.strictEqual(many.collected[0].payload.fields.param3, 5);
  assert.strictEqual(many.collected[0].payload.fields.param4, 0);

  /** An explicit sequence override is only meaningful for a single capture —
   * forced to 0 for bursts so saved editor values can't go out of spec. */
  const overridden = setup(profileWithoutComponentDefault('p3'), { action: 'camera_photo' });
  const forced = await overridden.RED.inject(overridden.node, { payload: { count: 5, sequence: 7, interval: 1 } });
  assert.strictEqual(forced.collected[0].payload.fields.param4, 0);
});
