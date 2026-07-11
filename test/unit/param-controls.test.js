'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildMetadata } = require('../../lib/dialects/message-metadata');
const { modeChoices } = require('../../lib/command/flight-modes');
const {
  paramControl,
  registerParamControl,
  looksBoolean
} = require('../../lib/command/param-metadata');
const { resolveParamChoices } = require('../../lib/command/param-resolvers');

// --- generic metadata carried onto raw command params (#97) -----------------

test('ordinary enum command param carries its enum name', () => {
  const md = buildMetadata('ardupilotmega');
  const speedType = md.commands.MAV_CMD_DO_CHANGE_SPEED.params.find((p) => p.index === 1);
  assert.strictEqual(speedType.enum, 'SPEED_TYPE');
  assert.ok(!speedType.bitmask);
  assert.ok(!speedType.resolver);
});

test('bitmask command param carries its bitmask enum name', () => {
  const md = buildMetadata('ardupilotmega');
  const baseMode = md.commands.MAV_CMD_DO_SET_MODE.params.find((p) => p.index === 1);
  assert.strictEqual(baseMode.bitmask, 'MAV_MODE_FLAG');
  // The flag members are single-bit powers of two the editor can OR together.
  const flags = md.enums.MAV_MODE_FLAG;
  assert.ok(flags.every((f) => f.value > 0 && (f.value & (f.value - 1)) === 0));
});

test('profile-aware command param carries a resolver + control kind', () => {
  const md = buildMetadata('ardupilotmega');
  const customMode = md.commands.MAV_CMD_DO_SET_MODE.params.find((p) => p.index === 2);
  assert.strictEqual(customMode.control, 'flight-mode');
  assert.strictEqual(customMode.resolver, 'profile-flight-mode');
  assert.strictEqual(customMode.profileAware, true);
});

test('boolean command param is identified from the MAV_BOOL convention', () => {
  const md = buildMetadata('ardupilotmega');
  const useCurrent = md.commands.MAV_CMD_DO_SET_HOME.params.find((p) => p.index === 1);
  assert.strictEqual(useCurrent.boolean, true);
});

test('numeric constraints (min/max/increment) ride the param when present', () => {
  const md = buildMetadata('ardupilotmega');
  const roll = md.commands.MAV_CMD_DO_SET_HOME.params.find((p) => p.name === 'roll');
  assert.strictEqual(roll.min, -180);
  assert.strictEqual(roll.max, 180);
  // A param with no declared constraints keeps them null (numeric fallback).
  const speed = md.commands.MAV_CMD_DO_CHANGE_SPEED.params.find((p) => p.name === 'speed');
  assert.strictEqual(speed.min, -2);
  assert.strictEqual(speed.max, null);
});

test('a param with no reliable metadata stays a plain numeric', () => {
  const md = buildMetadata('ardupilotmega');
  const subMode = md.commands.MAV_CMD_DO_SET_MODE.params.find((p) => p.index === 3);
  assert.ok(!subMode.enum);
  assert.ok(!subMode.bitmask);
  assert.ok(!subMode.boolean);
  assert.ok(!subMode.resolver);
});

// --- flight-mode choices: Copter vs Plane differ (GUIDED 4 vs 15) -----------

test('modeChoices maps the same name to different wire values per vehicle', () => {
  const copter = modeChoices('ardupilot', 'copter');
  const plane = modeChoices('ardupilot', 'plane');
  assert.strictEqual(copter.find((m) => m.name === 'GUIDED').value, 4);
  assert.strictEqual(plane.find((m) => m.name === 'GUIDED').value, 15);
  // Unsupported combination yields no choices (editor falls back to numeric).
  assert.deepStrictEqual(modeChoices('generic', 'copter'), []);
});

// --- resolver dispatch ------------------------------------------------------

test('profile-flight-mode resolver is profile-scoped and firmware-specific', () => {
  const copter = resolveParamChoices('profile-flight-mode', { firmware: 'ardupilot', vehicleType: 'copter' });
  assert.strictEqual(copter.scope, 'profile');
  assert.strictEqual(copter.generic, false);
  assert.strictEqual(copter.choices.find((c) => c.name === 'GUIDED').value, 4);
  const plane = resolveParamChoices('profile-flight-mode', { firmware: 'ardupilot', vehicleType: 'plane' });
  assert.strictEqual(plane.choices.find((c) => c.name === 'GUIDED').value, 15);
});

test('component-mode resolver returns different choices per target component', () => {
  const md = buildMetadata('ardupilotmega');
  const camera = resolveParamChoices('component-mode', { componentType: 'camera', enums: md.enums });
  const gimbal = resolveParamChoices('component-mode', { componentType: 'gimbal', enums: md.enums });
  assert.strictEqual(camera.scope, 'component');
  assert.strictEqual(camera.enum, 'CAMERA_MODE');
  assert.strictEqual(gimbal.enum, 'MAV_MOUNT_MODE');
  // The two component types resolve to genuinely different value sets.
  assert.notStrictEqual(camera.choices.length, 0);
  assert.notStrictEqual(gimbal.choices.length, 0);
  assert.notDeepStrictEqual(
    camera.choices.map((c) => c.name),
    gimbal.choices.map((c) => c.name)
  );
});

test('unknown resolver falls back to an empty generic result', () => {
  const r = resolveParamChoices('nope', {});
  assert.strictEqual(r.unknownResolver, true);
  assert.deepStrictEqual(r.choices, []);
});

// --- registry extensibility -------------------------------------------------

test('registerParamControl adds a context hint for a new command param', () => {
  assert.strictEqual(paramControl('MAV_CMD_USER_1', 1), null);
  registerParamControl('MAV_CMD_USER_1', 1, { enum: 'MAV_FRAME' });
  assert.deepStrictEqual(paramControl('MAV_CMD_USER_1', 1), { enum: 'MAV_FRAME' });
});

test('looksBoolean trusts only the MAV_BOOL description convention', () => {
  assert.strictEqual(looksBoolean({ description: 'Use current (MAV_BOOL_FALSE: specified)' }), true);
  // A genuine 0..1 continuous ratio must not be mistaken for a checkbox.
  assert.strictEqual(looksBoolean({ description: 'Normalized throttle', min: 0, max: 1 }), false);
  assert.strictEqual(looksBoolean({ description: null }), false);
});
