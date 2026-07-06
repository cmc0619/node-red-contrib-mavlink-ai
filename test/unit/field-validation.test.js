'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  requireFinite,
  requireRange,
  requireIntRange,
  validateTargetSystem,
  validateTargetComponent,
  validateLatitude,
  validateLongitude
} = require('../../lib/util/field-validation');

const isInvalid = (err) => err.code === 'INVALID_FIELD';

test('requireFinite coerces numeric strings, rejects junk (#55)', () => {
  assert.strictEqual(requireFinite('47.5', 'x'), 47.5);
  assert.strictEqual(requireFinite(3, 'x'), 3);
  assert.throws(() => requireFinite('', 'x'), isInvalid);
  assert.throws(() => requireFinite(null, 'x'), isInvalid);
  assert.throws(() => requireFinite('abc', 'x'), isInvalid);
  assert.throws(() => requireFinite(NaN, 'x'), isInvalid);
});

test('requireRange enforces bounds and reports them in context (#55)', () => {
  assert.strictEqual(requireRange(5, 'v', 0, 10), 5);
  assert.throws(
    () => requireRange(11, 'v', 0, 10),
    (err) => isInvalid(err) && err.context.field === 'v' && err.context.value === 11 && /0 and 10/.test(err.context.expected)
  );
});

test('requireIntRange rejects non-integers (#55)', () => {
  assert.strictEqual(requireIntRange(200, 'id', 0, 255), 200);
  assert.throws(() => requireIntRange(2.5, 'id', 0, 255), isInvalid);
});

test('target system/component ranges (0..255) (#55)', () => {
  assert.strictEqual(validateTargetSystem(1), 1);
  assert.strictEqual(validateTargetSystem(0), 0); // broadcast
  assert.throws(() => validateTargetSystem(999), (e) => isInvalid(e) && e.context.field === 'target_system');
  assert.throws(() => validateTargetSystem(-1), isInvalid);
  assert.strictEqual(validateTargetComponent(190), 190);
  assert.throws(() => validateTargetComponent(300), isInvalid);
});

test('latitude/longitude bounds (#55)', () => {
  assert.strictEqual(validateLatitude(47.5), 47.5);
  assert.strictEqual(validateLongitude(-122.4), -122.4);
  assert.throws(() => validateLatitude(200), (e) => isInvalid(e) && e.context.field === 'lat');
  assert.throws(() => validateLongitude(-999), (e) => isInvalid(e) && e.context.field === 'lon');
  // extra context (e.g. sysid/seq) is carried through.
  assert.throws(() => validateLatitude(91, { sysid: 3 }), (e) => e.context.sysid === 3);
});
