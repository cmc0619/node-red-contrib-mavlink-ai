'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const enums = require('../../lib/protocol/enum-resolver');

const bundle = loadDialect('ardupilotmega');

test('camelToScreaming derives enum prefixes', () => {
  assert.strictEqual(enums.camelToScreaming('MavCmd'), 'MAV_CMD');
  assert.strictEqual(enums.camelToScreaming('MavType'), 'MAV_TYPE');
  assert.strictEqual(enums.camelToScreaming('MavModeFlag'), 'MAV_MODE_FLAG');
});

test('resolves fully-qualified enum names to numbers', () => {
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, 'MAV_CMD_COMPONENT_ARM_DISARM'), 400);
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, 'MAV_TYPE_QUADROTOR'), 2);
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, 'MAV_STATE_ACTIVE'), 4);
});

test('resolves unprefixed member names too', () => {
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, 'QUADROTOR'), 2);
});

test('passes through numbers and unknown strings', () => {
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, 5), 5);
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, '5'), 5);
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, 'NOT_AN_ENUM'), 'NOT_AN_ENUM');
});

test('nameFor maps numbers back to names', () => {
  assert.strictEqual(enums.nameFor(bundle.enums, 'MavType', 2), 'MAV_TYPE_QUADROTOR');
});
