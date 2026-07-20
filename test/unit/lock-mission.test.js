'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LockManager } = require('../../lib/runtime/lock-manager');
const { missionTypeToNumber } = require('../../lib/mission/mission-state-machine');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { common } = require('node-mavlink');

test('lock manager prevents double acquire', () => {
  const locks = new LockManager();
  const lock = locks.acquire('mission:c1:p1:0', 'owner-a');
  assert.throws(() => locks.acquire('mission:c1:p1:0', 'owner-b'), /LOCK_HELD|already held/);
  lock.release();
  // After release a new owner can acquire.
  assert.doesNotThrow(() => locks.acquire('mission:c1:p1:0', 'owner-b'));
});

test('lock release is owner-scoped', () => {
  const locks = new LockManager();
  locks.acquire('k', 'a');
  assert.strictEqual(locks.release('k', 'b'), false); // wrong owner
  assert.strictEqual(locks.release('k', 'a'), true);
});

test('missionTypeToNumber maps names, enums and numbers', () => {
  const b = loadDialect('ardupilotmega');
  const context = { dialect: b.name, consumer: 'mission' };
  assert.strictEqual(missionTypeToNumber('mission', b.enums, context), common.MavMissionType.MISSION);
  assert.strictEqual(missionTypeToNumber('fence', b.enums, context), common.MavMissionType.FENCE);
  assert.strictEqual(missionTypeToNumber('rally', b.enums, context), common.MavMissionType.RALLY);
  assert.strictEqual(missionTypeToNumber('all', b.enums, context), common.MavMissionType.ALL);
  assert.strictEqual(
    missionTypeToNumber('MAV_MISSION_TYPE_FENCE', b.enums, context),
    common.MavMissionType.FENCE
  );
  assert.strictEqual(missionTypeToNumber(common.MavMissionType.RALLY, b.enums, context), common.MavMissionType.RALLY);
});

test('missionTypeToNumber rejects unknown strings (no silent default to 0)', () => {
  const b = loadDialect('ardupilotmega');
  assert.throws(
    () => missionTypeToNumber('fecnce', b.enums, { dialect: b.name, consumer: 'mission' }),
    /BAD_MISSION_TYPE|Unknown mission type/
  );
});

test('missionTypeToNumber fails with complete context when MavMissionType is unavailable', () => {
  const b = loadDialect('ardupilotmega');
  const enums = { ...b.enums, enumsByName: { ...b.enums.enumsByName } };
  delete enums.enumsByName.MavMissionType;
  assert.throws(
    () => missionTypeToNumber('mission', enums, { dialect: 'missing-mission-type', consumer: 'mission' }),
    (err) => {
      assert.strictEqual(err.code, 'ENUM_VALUE_UNAVAILABLE');
      assert.deepStrictEqual(err.context, {
        enum: 'MavMissionType',
        member: 'MISSION',
        dialect: 'missing-mission-type',
        consumer: 'mission'
      });
      return true;
    }
  );
});
