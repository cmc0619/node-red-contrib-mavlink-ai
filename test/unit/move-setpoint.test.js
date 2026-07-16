'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const {
  buildTypeMask,
  resolveTypeMask,
  resolveFrame,
  buildSetpoint,
  setpointWarnings,
  DIM_BITS,
  FORCE_BIT
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

test('acceleration presets clear the accel bits but leave the force bit unset (#128)', () => {
  const accel = resolveTypeMask('acceleration');
  assert.strictEqual(accel, ALL_IGNORE & ~DIM_BITS.accel);
  assert.strictEqual(accel & FORCE_BIT, 0, 'acceleration is not a force');
  assert.strictEqual(resolveTypeMask('acceleration_yaw'), ALL_IGNORE & ~DIM_BITS.accel & ~DIM_BITS.yaw);
});

test('force presets clear the accel bits and set the force mode bit (#128)', () => {
  const force = resolveTypeMask('force');
  assert.strictEqual(force, (ALL_IGNORE & ~DIM_BITS.accel) | FORCE_BIT);
  assert.strictEqual(force & FORCE_BIT, FORCE_BIT, 'force sets bit 9');
  assert.strictEqual(resolveTypeMask('force_yaw'), (ALL_IGNORE & ~DIM_BITS.accel & ~DIM_BITS.yaw) | FORCE_BIT);
});

test('buildSetpoint fills the af vector with up-positive accel mapped to -afz (#128)', () => {
  const { fields } = buildSetpoint({
    coordinate: 'local',
    preset: 'acceleration',
    frame: 'MAV_FRAME_LOCAL_NED',
    accelNorth: 1.5,
    accelEast: -0.5,
    accelUp: 2
  });
  assert.strictEqual(fields.afx, 1.5);
  assert.strictEqual(fields.afy, -0.5);
  assert.strictEqual(fields.afz, -2);
  assert.strictEqual(fields.type_mask & FORCE_BIT, 0);
});

test('a force setpoint sends the af inputs with the force bit set (#128)', () => {
  const { fields } = buildSetpoint({
    coordinate: 'local',
    preset: 'force',
    frame: 'MAV_FRAME_LOCAL_NED',
    accelNorth: 3,
    accelEast: 0,
    accelUp: 1
  });
  assert.strictEqual(fields.afx, 3);
  assert.strictEqual(fields.afz, -1);
  assert.strictEqual(fields.type_mask & FORCE_BIT, FORCE_BIT);
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
    velEast: 0,
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
    north: 0,
    east: 0,
    altitude: 0,
    yaw: 90,
    yawRate: 180
  });
  assert.ok(Math.abs(fields.yaw - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(fields.yaw_rate - Math.PI) < 1e-9);
});

test('MAV_FRAME_BODY_NED (PX4 body frame) resolves via the fallback map and the dialect enum index (#128)', () => {
  /** No enums: the FRAME_FALLBACK map. BODY_NED (8) — not BODY_FRD — is the
   * body frame SET_POSITION_TARGET_LOCAL_NED accepts. */
  assert.strictEqual(resolveFrame('MAV_FRAME_BODY_NED', null), 8);
  /** With a real dialect index: the enum-lookup branch. */
  const enums = loadDialect('ardupilotmega').enums;
  assert.strictEqual(resolveFrame('MAV_FRAME_BODY_NED', enums), 8);
  const { fields } = buildSetpoint({
    coordinate: 'local',
    preset: 'velocity',
    frame: 'MAV_FRAME_BODY_NED',
    enums,
    velNorth: 2,
    velEast: 0,
    climb: 1
  });
  assert.strictEqual(fields.coordinate_frame, 8);
  assert.strictEqual(fields.vz, -1, 'body NED z stays down-positive, so climb is negated');
});

test('setpointWarnings normalizes a mixed-case firmware value (#128)', () => {
  const forceMask = resolveTypeMask('force');
  const warnings = setpointWarnings({ firmware: 'ArduPilot', typeMask: forceMask, frameName: 'MAV_FRAME_LOCAL_NED' });
  assert.strictEqual(warnings.length, 1, 'mixed-case firmware still warns');
});

test('setpointWarnings flags force setpoints on both known firmwares (#128)', () => {
  const forceMask = resolveTypeMask('force');
  for (const firmware of ['ardupilot', 'px4']) {
    const warnings = setpointWarnings({ firmware, typeMask: forceMask, frameName: 'MAV_FRAME_LOCAL_NED' });
    assert.strictEqual(warnings.length, 1, `${firmware} warns on FORCE`);
    assert.match(warnings[0], /FORCE/);
  }
});

test('setpointWarnings flags acceleration on ArduPilot only (#128)', () => {
  const accelMask = resolveTypeMask('acceleration');
  const ap = setpointWarnings({ firmware: 'ardupilot', typeMask: accelMask, frameName: 'MAV_FRAME_LOCAL_NED' });
  assert.strictEqual(ap.length, 1);
  assert.match(ap[0], /acceleration/i);
  const px4 = setpointWarnings({ firmware: 'px4', typeMask: accelMask, frameName: 'MAV_FRAME_LOCAL_NED' });
  assert.deepStrictEqual(px4, [], 'PX4 OFFBOARD supports acceleration setpoints');
});

test('setpointWarnings flags PX4-unsupported frames (#128)', () => {
  const posMask = resolveTypeMask('position');
  const terrain = setpointWarnings({ firmware: 'px4', typeMask: posMask, frameName: 'MAV_FRAME_GLOBAL_TERRAIN_ALT_INT' });
  assert.strictEqual(terrain.length, 1);
  assert.match(terrain[0], /terrain/i);
  const offset = setpointWarnings({ firmware: 'px4', typeMask: posMask, frameName: 'MAV_FRAME_BODY_OFFSET_NED' });
  assert.strictEqual(offset.length, 1);
  assert.match(offset[0], /OFFSET/);
  const bodyNed = setpointWarnings({ firmware: 'px4', typeMask: posMask, frameName: 'MAV_FRAME_BODY_NED' });
  assert.deepStrictEqual(bodyNed, [], 'body NED is fine on PX4');
  const apOffset = setpointWarnings({ firmware: 'ardupilot', typeMask: posMask, frameName: 'MAV_FRAME_BODY_OFFSET_NED' });
  assert.deepStrictEqual(apOffset, [], 'body offset is ArduPilot-native');
});

test('setpointWarnings stays silent for unknown firmwares (#128)', () => {
  const forceMask = resolveTypeMask('force');
  assert.deepStrictEqual(setpointWarnings({ firmware: 'generic', typeMask: forceMask, frameName: 'MAV_FRAME_LOCAL_NED' }), []);
  assert.deepStrictEqual(setpointWarnings({ typeMask: forceMask, frameName: 'MAV_FRAME_LOCAL_NED' }), []);
});

test('a position-driving global setpoint requires finite, in-range lat/lon', () => {
  /**
   * num() collapses absent inputs to 0 — for a commanded position that means a
   * live OFFBOARD/GUIDED vehicle heading for 0N 0E. Must fail loudly instead.
   */
  assert.throws(
    () => buildSetpoint({ coordinate: 'global', preset: 'position', frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT', altitude: 20 }),
    (e) => e.code === 'BAD_SETPOINT_POSITION'
  );
  assert.throws(
    () =>
      buildSetpoint({
        coordinate: 'global',
        preset: 'position',
        frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT',
        lat: 91,
        lon: 0,
        altitude: 20
      }),
    (e) => e.code === 'BAD_SETPOINT_POSITION'
  );
  /** velocity-only masks ignore position: no coordinates required */
  const vel = buildSetpoint({
    coordinate: 'global',
    preset: 'velocity',
    frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT',
    velNorth: 1,
    velEast: 0,
    climb: 0
  });
  assert.strictEqual(vel.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  /** valid coordinates still build */
  const ok = buildSetpoint({
    coordinate: 'global',
    preset: 'position',
    frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT',
    lat: 47.397742,
    lon: 8.545594,
    altitude: 20
  });
  assert.strictEqual(ok.fields.lat_int, 473977420);
});

test('a blank active field fails instead of shipping a value-substituted zero (#235)', () => {
  /**
   * The preset activates a whole dimension group. A local position setpoint with
   * a blank axis would otherwise fly the vehicle toward the local origin on that
   * axis; a partly-filled velocity/acceleration would hold zero on an axis the
   * operator meant to drive. Every active axis must be finite (0 allowed only if
   * entered), naming the offending field/preset/frame.
   */
  const cases = [
    { preset: 'position', opts: { north: 5, altitude: 2 }, missing: 'east' },
    { preset: 'velocity', opts: { velNorth: 1, velEast: 0 }, missing: 'climb' },
    { preset: 'acceleration', opts: { accelNorth: 1, accelUp: 1 }, missing: 'accelEast' },
    { preset: 'position_yaw', opts: { north: 0, east: 0, altitude: 0 }, missing: 'yaw' }
  ];
  for (const c of cases) {
    assert.throws(
      () => buildSetpoint({ coordinate: 'local', preset: c.preset, frame: 'MAV_FRAME_LOCAL_NED', ...c.opts }),
      (e) => e.code === 'BAD_SETPOINT_FIELD' && e.context.fields.includes(c.missing) && /MAV_FRAME_LOCAL_NED/.test(e.message),
      `${c.preset} with blank ${c.missing} must fail`
    );
  }
});

test('NaN / Infinity active fields fail; intentional zeros build (#235)', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'x', '']) {
    assert.throws(
      () => buildSetpoint({ coordinate: 'local', preset: 'velocity', frame: 'MAV_FRAME_LOCAL_NED', velNorth: bad, velEast: 0, climb: 0 }),
      (e) => e.code === 'BAD_SETPOINT_FIELD' && e.context.fields.includes('velNorth')
    );
  }
  /** Explicit zeros on every active axis are a real command and must build. */
  const { fields } = buildSetpoint({
    coordinate: 'local',
    preset: 'velocity',
    frame: 'MAV_FRAME_LOCAL_NED',
    velNorth: 0,
    velEast: 0,
    climb: 0
  });
  assert.strictEqual(fields.vx, 0);
  assert.strictEqual(fields.vy, 0);
  assert.strictEqual(fields.vz, -0);
});

test('ignored axes need no value; global altitude is validated only when active (#235)', () => {
  /** A yaw-only setpoint ignores position/velocity/accel — blanks there are masked, not sent. */
  const yawOnly = buildSetpoint({ coordinate: 'local', preset: 'yaw', frame: 'MAV_FRAME_LOCAL_NED', yaw: 45 });
  assert.strictEqual(yawOnly.fields.x, 0, 'ignored position axis is masked, sent as 0');
  /** A global position setpoint whose altitude axis is active but blank must fail. */
  assert.throws(
    () => buildSetpoint({ coordinate: 'global', preset: 'position', frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT', lat: 47.39, lon: 8.54 }),
    (e) => e.code === 'BAD_SETPOINT_FIELD' && e.context.fields.includes('altitude')
  );
});
