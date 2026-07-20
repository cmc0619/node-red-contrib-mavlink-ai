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
    Object.assign({ id: 'pl1', profile: profile.id, connection: '', delivery: 'build' }, payloadConfig)
  );
  return { RED, node };
}

test('a camera verb with no component set falls back to the autopilot component (#155)', async () => {
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].payload.target_component, DEFAULT_TARGET_COMPONENT);
});

test('a camera verb honors an explicit per-message component (a standalone camera) (#155)', async () => {
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo' });
  const { collected } = await RED.inject(node, { payload: { target_component: MAV_COMP_ID.CAMERA } });
  assert.strictEqual(collected[0][0].payload.target_component, 100);
});

test('the node-configured component wins over the fallback for a gimbal verb (#155)', async () => {
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), {
    action: 'gimbal_aim',
    targetComponent: String(MAV_COMP_ID.GIMBAL)
  });
  const { collected } = await RED.inject(node, { payload: { pitch: -20 } });
  assert.strictEqual(collected[0][0].payload.target_component, 154);
});

test('camera_photo sequence defaults to 1 only for single captures (spec: 0 for multi-shot)', async () => {
  const single = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo' });
  const one = await single.RED.inject(single.node, { payload: {} });
  assert.strictEqual(one.collected[0][0].payload.fields.param3, 1);
  assert.strictEqual(one.collected[0][0].payload.fields.param4, 1);

  const burst = setup(profileWithoutComponentDefault('p2'), { action: 'camera_photo' });
  const many = await burst.RED.inject(burst.node, { payload: { count: 5, interval: 1 } });
  assert.strictEqual(many.collected[0][0].payload.fields.param3, 5);
  assert.strictEqual(many.collected[0][0].payload.fields.param4, 0);

  /** An explicit sequence override is only meaningful for a single capture —
   * forced to 0 for bursts so saved editor values can't go out of spec. */
  const overridden = setup(profileWithoutComponentDefault('p3'), { action: 'camera_photo' });
  const forced = await overridden.RED.inject(overridden.node, { payload: { count: 5, sequence: 7, interval: 1 } });
  assert.strictEqual(forced.collected[0][0].payload.fields.param4, 0);
});

test('gripper resolves grab/release strictly and fails an unknown action closed (#218)', async () => {
  /** Explicit grab / release map to the documented raw values. */
  const grabNode = setup(profileWithoutComponentDefault('g1'), { action: 'gripper', gripAction: 'grab' });
  const grab = await grabNode.RED.inject(grabNode.node, { payload: {} });
  assert.strictEqual(grab.collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(grab.collected[0][0].payload.fields.param2, 1); /** GRIPPER_GRAB */

  const relNode = setup(profileWithoutComponentDefault('g2'), { action: 'gripper', gripAction: 'release' });
  const rel = await relNode.RED.inject(relNode.node, { payload: {} });
  assert.strictEqual(rel.collected[0][0].payload.fields.param2, 0); /** GRIPPER_RELEASE */

  /**
   * An unknown/misspelled action must NOT fall through to the destructive
   * release — it fails with a structured error and sends nothing (#218).
   */
  const badNode = setup(profileWithoutComponentDefault('g3'), { action: 'gripper' });
  const bad = await badNode.RED.inject(badNode.node, { payload: { grip_action: 'oepn' } });
  assert.strictEqual(bad.collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(bad.collected[0][1].payload.code, 'BAD_GRIPPER_ACTION');
  assert.ok(!bad.collected.some((m) => m[0] && m[0].topic === 'mavlink/send'), 'no command was sent');
});

test('payload re-resolves a Connection re-created on a later deploy (#238)', async () => {
  /**
   * Node-RED leaves the payload node in place when only its referenced
   * Connection config node changed, so a one-time constructor resolution kept
   * node.connection pointing at the destroyed old object (in/out/swarm already
   * re-resolve on flows:started, #164 — payload was missed).
   */
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo', connection: 'c1', delivery: 'send' });
  assert.strictEqual(node.connection, null, 'connection did not exist at construction');

  /** The Connection config node appears on a later deploy. */
  const sent = [];
  RED._nodes.set('c1', {
    id: 'c1',
    name: 'Conn',
    send: (m) => {
      sent.push(m);
      return Promise.resolve();
    }
  });
  RED.events.emit('flows:started');
  assert.ok(node.connection, 're-resolved the recreated connection');
  assert.strictEqual(node.connection.id, 'c1');

  /** The direct-send path now uses the fresh object, not the stale null. */
  await RED.inject(node, { payload: {} });
  assert.strictEqual(sent.length, 1, 'sent directly through the recreated connection');
});

test('a refresh that nulls the connection mid-send still emits a structured error (#238)', async () => {
  /**
   * The live flows:started refresh can null/replace node.connection while a
   * direct send is pending. The handler captures the connection before the
   * await, so the catch path names the connection actually used instead of
   * TypeError-ing on the stale null and leaving done() uncalled.
   */
  const { RED, node } = setup(profileWithoutComponentDefault('p1'), { action: 'camera_photo', connection: 'c1', delivery: 'send' });
  let rejectSend;
  RED._nodes.set('c1', {
    id: 'c1',
    name: 'Conn',
    send: () => new Promise((_resolve, reject) => { rejectSend = reject; })
  });
  RED.events.emit('flows:started');
  assert.ok(node.connection, 'resolved before the send');

  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));

  /** The connection config node is removed on a later deploy mid-flight. */
  RED.remove('c1');
  RED.events.emit('flows:started');
  assert.strictEqual(node.connection, null, 'live refresh nulled the reference');

  rejectSend(new Error('link down'));
  const { collected } = await injected;
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'SEND_FAILED');
  assert.strictEqual(collected[0][1].payload.connection, 'Conn', 'names the connection it actually sent on');
});

test('build-only output stamps CRITICAL only for safety verbs (#241)', async () => {
  /** Parachute resolves to a critical MAV_CMD (DO_PARACHUTE) — the stamp rides
   * the emitted message so Payload -> mavlink-ai-out keeps the critical band. */
  const parachute = setup(profileWithoutComponentDefault('p1'), { action: 'parachute', parachuteAction: 'release' });
  const rel = await parachute.RED.inject(parachute.node, { payload: {} });
  assert.strictEqual(rel.collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(rel.collected[0][0].priority, 0, 'parachute rides CRITICAL');

  /** A camera verb is not critical: no stamp, flows keep control of the field. */
  const camera = setup(profileWithoutComponentDefault('p2'), { action: 'camera_photo' });
  const shot = await camera.RED.inject(camera.node, { payload: {} });
  assert.strictEqual(shot.collected[0][0].priority, undefined, 'camera carries no stamp');
});
