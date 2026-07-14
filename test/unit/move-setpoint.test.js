'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const {
  buildTypeMask,
  resolveTypeMask,
  resolveFrame,
  buildSetpoint,
  DIM_BITS
} = require('../../lib/move/setpoint');

const ALL_IGNORE = DIM_BITS.position | DIM_BITS.velocity | DIM_BITS.accel | DIM_BITS.yaw | DIM_BITS.yawRate;

test('buildTypeMask clears only the active dimensions (set bit = ignore)', () => {
  assert.strictEqual(buildTypeMask({ position: true }), ALL_IGNORE & ~DIM_BITS.position);
  assert.strictEqual(buildTypeMask({ velocity: true }), ALL_IGNORE & ~DIM_BITS.velocity);
  assert.strictEqual(buildTypeMask({ yaw: true }), ALL_IGNORE & ~DIM_BITS.yaw);
  assert.strictEqual(
    buildTypeMask({ position: true, velocity: true }),
    ALL_IGNORE & ~DIM_BITS.position & ~DIM_BITS.velocity
  );
  assert.strictEqual(buildTypeMask({}), ALL_IGNORE);
});

test('preset masks resolve to the documented inverted values', () => {
  assert.strictEqual(resolveTypeMask('position'), 3576);
  assert.strictEqual(resolveTypeMask('velocity'), 3527);
  assert.strictEqual(resolveTypeMask('position_yaw'), 2552);
  assert.strictEqual(resolveTypeMask('yaw'), 2559);
  assert.strictEqual(resolveTypeMask('yaw_rate'), 1535);
});

test('custom preset takes the raw mask and rejects out-of-range values', () => {
  assert.strictEqual(resolveTypeMask('custom', 0), 0);
  assert.strictEqual(resolveTypeMask('custom', 65535), 65535);
  assert.throws(() => resolveTypeMask('custom', 70000), (e) => e.code === 'BAD_TYPE_MASK');
  assert.throws(() => resolveTypeMask('custom', 'x'), (e) => e.code === 'BAD_TYPE_MASK');
});

test('unknown preset throws BAD_PRESET', () => {
  assert.throws(() => resolveTypeMask('bogus'), (e) => e.code === 'BAD_PRESET');
});

test('resolveFrame uses the dialect enum, then the standard fallback', () => {
  const enums = loadDialect('ardupilotmega').enums;
  assert.strictEqual(resolveFrame('MAV_FRAME_LOCAL_NED', enums), 1);
  assert.strictEqual(resolveFrame('MAV_FRAME_LOCAL_NED', null), 1);
  assert.strictEqual(resolveFrame('MAV_FRAME_GLOBAL_RELATIVE_ALT_INT', null), 6);
  assert.throws(() => resolveFrame('MAV_FRAME_NOPE', null), (e) => e.code === 'BAD_FRAME');
});

test('local setpoint maps up-positive altitude/climb to negative z/vz', () => {
  const { name, fields } = buildSetpoint({
    coordinate: 'local',
    preset: 'position',
    frame: 'MAV_FRAME_LOCAL_NED',
    north: 5,
    east: -2,
    altitude: 10,
    targetSystem: 1,
    targetComponent: 1
  });
  assert.strictEqual(name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.strictEqual(fields.x, 5);
  assert.strictEqual(fields.y, -2);
  assert.strictEqual(fields.z, -10);
  assert.strictEqual(fields.type_mask, 3576);
  assert.strictEqual(fields.coordinate_frame, 1);
});

test('global setpoint converts degrees to 1e7 ints and keeps altitude up-positive', () => {
  const { name, fields } = buildSetpoint({
    coordinate: 'global',
    preset: 'position_velocity',
    frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT',
    lat: 47.397742,
    lon: 8.545594,
    altitude: 5,
    velNorth: 1,
    climb: 2
  });
  assert.strictEqual(name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.strictEqual(fields.lat_int, 473977420);
  assert.strictEqual(fields.lon_int, 85455940);
  assert.strictEqual(fields.alt, 5);
  assert.strictEqual(fields.vx, 1);
  assert.strictEqual(fields.vz, -2);
  assert.strictEqual(fields.coordinate_frame, 6);
});

test('yaw and yaw-rate are converted from degrees to radians', () => {
  const { fields } = buildSetpoint({
    coordinate: 'local',
    preset: 'position_yaw',
    frame: 'MAV_FRAME_LOCAL_NED',
    yaw: 90,
    yawRate: 180
  });
  assert.ok(Math.abs(fields.yaw - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(fields.yaw_rate - Math.PI) < 1e-9);
});
