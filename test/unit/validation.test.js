'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toInt, toBool, parseList, parseIdList, isWildcard, idAccepted } = require('../../lib/util/validation');

test('toInt coerces and falls back', () => {
  assert.strictEqual(toInt('42', 0), 42);
  assert.strictEqual(toInt('', 7), 7);
  assert.strictEqual(toInt(undefined, 7), 7);
  assert.strictEqual(toInt('nope', 3), 3);
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
