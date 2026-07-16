'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toInt, toNum, toBool, parseList, parseIdList, isWildcard, idAccepted } = require('../../lib/util/validation');

test('toInt coerces and falls back', () => {
  assert.strictEqual(toInt('42', 0), 42);
  assert.strictEqual(toInt('', 7), 7);
  assert.strictEqual(toInt(undefined, 7), 7);
  assert.strictEqual(toInt('nope', 3), 3);
});

test('toNum preserves fractions and falls back (#29)', () => {
  assert.strictEqual(toNum('0.5', 0), 0.5);
  assert.strictEqual(toNum(2.5, 0), 2.5);
  assert.strictEqual(toNum('42', 0), 42);
  assert.strictEqual(toNum('', 7), 7);
  assert.strictEqual(toNum(undefined, 7), 7);
  assert.strictEqual(toNum('nope', 3), 3);
});

test('toBool handles node-red string booleans', () => {
  assert.strictEqual(toBool('true'), true);
  assert.strictEqual(toBool('false'), false);
  assert.strictEqual(toBool('', true), true);
  assert.strictEqual(toBool(true), true);
});

test('parseList splits on commas and whitespace', () => {
  assert.deepStrictEqual(parseList('HEARTBEAT, ATTITUDE  GPS'), ['HEARTBEAT', 'ATTITUDE', 'GPS']);
  assert.deepStrictEqual(parseList(''), []);
});

test('parseIdList treats wildcards as no-constraint', () => {
  assert.deepStrictEqual(parseIdList('1,2,3'), [1, 2, 3]);
  assert.deepStrictEqual(parseIdList('*'), []);
  assert.deepStrictEqual(parseIdList('any'), []);
});

test('isWildcard and idAccepted', () => {
  assert.ok(isWildcard('*'));
  assert.ok(isWildcard(''));
  assert.ok(!isWildcard('1'));
  assert.ok(idAccepted(5, [])); // empty == accept all
  assert.ok(idAccepted(5, [5, 6]));
  assert.ok(!idAccepted(7, [5, 6]));
});

test('parseIdListStrict reports malformed tokens instead of widening to wildcard (#193)', () => {
  const { parseIdListStrict } = require('../../lib/util/validation');
  // Blank yields an empty id list (which idAccepted treats as accept-all); an
  // explicit wildcard token sets the flag. Both mean "accept everything".
  assert.deepStrictEqual(parseIdListStrict(''), { ids: [], wildcard: false, invalid: [] });
  assert.deepStrictEqual(parseIdListStrict('*'), { ids: [], wildcard: true, invalid: [] });
  assert.deepStrictEqual(parseIdListStrict('any'), { ids: [], wildcard: true, invalid: [] });
  // Valid ids parse.
  assert.deepStrictEqual(parseIdListStrict('1,2,3'), { ids: [1, 2, 3], wildcard: false, invalid: [] });
  // An all-invalid value does NOT become [] (accept everything) — it is reported.
  assert.deepStrictEqual(parseIdListStrict('1O'), { ids: [], wildcard: false, invalid: ['1O'] });
  // A mixed value keeps the good ids AND reports the bad token (never silently narrows).
  assert.deepStrictEqual(parseIdListStrict('1,2x'), { ids: [1], wildcard: false, invalid: ['2x'] });
  // Out-of-range and fractional are invalid for uint8 identities.
  assert.deepStrictEqual(parseIdListStrict('300').invalid, ['300']);
  assert.deepStrictEqual(parseIdListStrict('1.5').invalid, ['1.5']);
  // Message ids allow the 24-bit range with an explicit max.
  assert.deepStrictEqual(parseIdListStrict('300', 0xffffff), { ids: [300], wildcard: false, invalid: [] });
});

test('parseJsonObjectConfig fails malformed static JSON instead of substituting {} (#204)', () => {
  const { parseJsonObjectConfig } = require('../../lib/util/validation');
  // Blank is the documented empty default.
  assert.deepStrictEqual(parseJsonObjectConfig('', 'fields'), { value: {}, error: null });
  assert.deepStrictEqual(parseJsonObjectConfig(undefined, 'fields'), { value: {}, error: null });
  // A valid object parses.
  assert.deepStrictEqual(parseJsonObjectConfig('{"param1":1}', 'fields'), { value: { param1: 1 }, error: null });
  // Malformed JSON is an error, not {}.
  assert.strictEqual(parseJsonObjectConfig('{bad', 'fields').error !== null, true);
  // Valid JSON of the wrong shape (array/scalar) is also an error.
  assert.strictEqual(parseJsonObjectConfig('[1,2]', 'fields').error !== null, true);
  assert.strictEqual(parseJsonObjectConfig('42', 'fields').error !== null, true);
});
