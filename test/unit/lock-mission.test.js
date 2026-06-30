'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LockManager } = require('../../lib/runtime/lock-manager');
const { missionTypeToNumber } = require('../../lib/mission/mission-state-machine');
const { loadDialect } = require('../../lib/dialects/dialect-loader');

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
  assert.strictEqual(missionTypeToNumber('mission', b.enums), 0);
  assert.strictEqual(missionTypeToNumber('fence', b.enums), 1);
  assert.strictEqual(missionTypeToNumber('rally', b.enums), 2);
  assert.strictEqual(missionTypeToNumber('all', b.enums), 255);
  assert.strictEqual(missionTypeToNumber('MAV_MISSION_TYPE_FENCE', b.enums), 1);
  assert.strictEqual(missionTypeToNumber(2, b.enums), 2);
});
