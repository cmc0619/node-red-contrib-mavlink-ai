'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { minimal, common, ardupilotmega } = require('node-mavlink');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { resolveInEnum } = require('../../lib/protocol/enum-resolver');
const {
  requireEnumMember,
  enumMembers,
  coreEnumMember,
  bindEnumValues,
  coreEnumValues
} = require('../../lib/protocol/protocol-values');

const ARDU = loadDialect('ardupilotmega');
const CONTEXT = { dialect: ARDU.name, consumer: 'test' };

test('bindEnumValues carries dialect and consumer context across lookups', () => {
  const value = bindEnumValues(ARDU.enums, {
    dialect: ARDU.name,
    consumer: 'bound-test'
  });
  assert.strictEqual(value('MavCmd', 'COMPONENT_ARM_DISARM'), common.MavCmd.COMPONENT_ARM_DISARM);
  assert.ok(value.members('MavResult').some((entry) => entry.name === 'ACCEPTED'));
  assert.throws(
    () => value('MavCmd', 'NOT_A_MEMBER'),
    (err) =>
      err.code === 'ENUM_VALUE_UNAVAILABLE' &&
      err.context.dialect === ARDU.name &&
      err.context.consumer === 'bound-test'
  );
});

test('coreEnumValues resolves public core mappings through the same adapter', () => {
  const value = coreEnumValues({ consumer: 'core-bound-test' });
  assert.strictEqual(value('MavComponent', 'AUTOPILOT1'), minimal.MavComponent.AUTOPILOT1);
});

test('coreEnumMember resolves from node-mavlink core exports', () => {
  assert.strictEqual(
    coreEnumMember('MavComponent', 'AUTOPILOT1', { consumer: 'test' }),
    minimal.MavComponent.AUTOPILOT1
  );
});

test('requireEnumMember resolves base and dialect-specific members from a merged active dialect', () => {
  assert.strictEqual(
    requireEnumMember(ARDU.enums, 'MavCmd', 'COMPONENT_ARM_DISARM', CONTEXT),
    common.MavCmd.COMPONENT_ARM_DISARM
  );
  assert.strictEqual(
    requireEnumMember(ARDU.enums, 'MavCmd', 'SET_EKF_SOURCE_SET', CONTEXT),
    ardupilotmega.MavCmd.SET_EKF_SOURCE_SET
  );
  assert.strictEqual(
    requireEnumMember(ARDU.enums, 'CopterMode', 'GUIDED', CONTEXT),
    ardupilotmega.CopterMode.GUIDED
  );
});

test('enumMembers returns only generated forward keys and numeric values', () => {
  const members = enumMembers(ARDU.enums, 'CopterMode', CONTEXT);
  assert.ok(members.some(({ name, value }) => name === 'GUIDED' && value === ardupilotmega.CopterMode.GUIDED));
  assert.ok(members.every(({ name, value }) => !/^\d+$/.test(name) && typeof value === 'number'));
});

test('strict helpers resolve enums compiled from a custom XML dialect', () => {
  const custom = loadDialect('custom', {
    customDialectPath: path.join(__dirname, '..', 'fixtures', 'dialects', 'custom_enum.xml')
  });
  const context = { dialect: custom.name, consumer: 'test' };
  assert.strictEqual(requireEnumMember(custom.enums, 'CustomColor', 'WHITE', context), 7);
  assert.deepStrictEqual(enumMembers(custom.enums, 'CustomColor', context), [
    { name: 'RED', value: 0 },
    { name: 'GREEN', value: 1 },
    { name: 'WHITE', value: 7 }
  ]);
});

test('requireEnumMember rejects non-canonical member inputs', () => {
  for (const member of ['MAV_FRAME_GLOBAL_INT', '5', 5]) {
    assert.throws(
      () => requireEnumMember(ARDU.enums, 'MavFrame', member, CONTEXT),
      (err) => err.code === 'ENUM_VALUE_UNAVAILABLE' && err.context.member === member
    );
  }
});

test('strict failures identify enum, member, dialect, and consumer', () => {
  assert.throws(
    () => requireEnumMember(ARDU.enums, 'MavFrame', 'NOT_REAL', CONTEXT),
    (err) => {
      assert.strictEqual(err.code, 'ENUM_VALUE_UNAVAILABLE');
      assert.deepStrictEqual(err.context, {
        enum: 'MavFrame',
        member: 'NOT_REAL',
        dialect: 'ardupilotmega',
        consumer: 'test'
      });
      return true;
    }
  );
  assert.throws(
    () => enumMembers(ARDU.enums, 'NotAnEnum', CONTEXT),
    (err) => err.code === 'ENUM_VALUE_UNAVAILABLE' && err.context.enum === 'NotAnEnum' && err.context.member === null
  );
});

test('the explicit raw resolver remains permissive', () => {
  assert.strictEqual(
    resolveInEnum(ARDU.enums, 'MavFrame', 'MAV_FRAME_GLOBAL_INT'),
    common.MavFrame.GLOBAL_INT
  );
  assert.strictEqual(resolveInEnum(ARDU.enums, 'MavFrame', '230'), 230);
});
