'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { resolveFrame } = require('../../lib/move/setpoint');
const { buildPayload } = require('../../lib/payload/payload');
const { resolveParamEncoding } = require('../../lib/param/param-encoding');

const ENUMS = loadDialect('ardupilotmega').enums;

/**
 * These resolvers can carry dialect-specific values (custom frames, payload
 * actions, capability bits), so they bind strictly to the profile's dialect
 * index. A missing dialect index cannot happen in normal operation — the
 * connection fails closed on a broken dialect before any send — so an absent
 * index is treated as an impossible state and fails loud with
 * ENUM_VALUE_UNAVAILABLE rather than silently substituting a value.
 */

test('resolveFrame resolves against the loaded dialect', () => {
  assert.strictEqual(resolveFrame('LOCAL_NED', ENUMS), 1); // MAV_FRAME_LOCAL_NED
  assert.strictEqual(resolveFrame('GLOBAL_INT', ENUMS), 5); // MAV_FRAME_GLOBAL_INT
});

test('resolveFrame fails loud with no dialect index', () => {
  assert.throws(() => resolveFrame('LOCAL_NED', null), (err) => err.code === 'ENUM_VALUE_UNAVAILABLE');
});

test('resolveFrame fails loud for an unknown member', () => {
  assert.throws(() => resolveFrame('NOT_A_REAL_FRAME', ENUMS), (err) => err.code === 'ENUM_VALUE_UNAVAILABLE');
});

test('buildPayload resolves against the loaded dialect', () => {
  const built = buildPayload('camera_photo', { enums: ENUMS, count: 1, targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(built.name, 'COMMAND_LONG');
  assert.strictEqual(typeof built.fields.command, 'number');
});

test('buildPayload fails loud with no dialect index', () => {
  assert.throws(
    () => buildPayload('camera_photo', { enums: null, count: 1, targetSystem: 1, targetComponent: 1 }),
    (err) => err.code === 'ENUM_VALUE_UNAVAILABLE'
  );
});

test('resolveParamEncoding fails loud with no dialect index', () => {
  assert.throws(
    () => resolveParamEncoding({ firmware: 'px4', enums: null }),
    (err) => err.code === 'ENUM_VALUE_UNAVAILABLE'
  );
});
