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

test('nameFor reverse-resolves base MAV_CMD values through a split enum (#64)', () => {
  // MavCmd is declared by both common and ardupilotmega; each module exports
  // only its own members. enumsByName must merge them, or reverse lookups of
  // the base (common) commands return undefined.
  assert.strictEqual(enums.nameFor(bundle.enums, 'MavCmd', 400), 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.strictEqual(enums.nameFor(bundle.enums, 'MavCmd', 16), 'MAV_CMD_NAV_WAYPOINT');
  // ArduPilot-specific commands still reverse-resolve after the merge.
  assert.strictEqual(enums.nameFor(bundle.enums, 'MavCmd', 42006), 'MAV_CMD_FIXED_MAG_CAL_YAW');
});

test('getEnum/enumsByName carries both common and ardupilot commands (#64)', () => {
  const mavCmd = bundle.enums.enumsByName.MavCmd;
  assert.strictEqual(mavCmd.COMPONENT_ARM_DISARM, 400); // common
  assert.strictEqual(mavCmd[400], 'COMPONENT_ARM_DISARM'); // reverse, common
  assert.ok(Object.keys(mavCmd).some((k) => Number(k) >= 42000)); // ardupilot extras present
});

test('digit-leading enum members keep their full source name — no double prefix', () => {
  /**
   * The generator reverts to the full name when prefix-stripping would leave
   * a leading digit (2D_FIX is not a valid identifier). nameFor must not
   * prefix again: GPS_FIX_TYPE_GPS_FIX_TYPE_2D_FIX is not a MAVLink name.
   */
  assert.strictEqual(enums.nameFor(bundle.enums, 'GpsFixType', 2), 'GPS_FIX_TYPE_2D_FIX');
  assert.strictEqual(enums.nameFor(bundle.enums, 'GpsFixType', 3), 'GPS_FIX_TYPE_3D_FIX');
  /** and the index carries the single-prefix key for forward resolution */
  assert.strictEqual(enums.resolveEnumValue(bundle.enums, 'GPS_FIX_TYPE_2D_FIX'), 2);
});
