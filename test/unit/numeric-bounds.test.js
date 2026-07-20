'use strict';

const test = require('node:test');
const assert = require('node:assert');

const nb = require('../../lib/util/numeric-bounds');

test('isBlank treats empty/whitespace/null/undefined as blank', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.strictEqual(nb.isBlank(v), true, `blank: ${JSON.stringify(v)}`);
  }
  for (const v of ['0', 0, '5']) {
    assert.strictEqual(nb.isBlank(v), false, `not blank: ${JSON.stringify(v)}`);
  }
});

test('acceptsPositive: finite > 0, blank allowed', () => {
  for (const v of ['', 1, '3000', 0.5]) assert.strictEqual(nb.acceptsPositive(v), true, `ok: ${v}`);
  for (const v of [0, '0', -1, '-5', 'abc', Infinity, -Infinity, NaN]) {
    assert.strictEqual(nb.acceptsPositive(v), false, `rejected: ${v}`);
  }
});

test('acceptsNonNegativeInteger: integer >= 0, blank allowed, fractional rejected', () => {
  for (const v of ['', 0, '0', 3, '10']) assert.strictEqual(nb.acceptsNonNegativeInteger(v), true, `ok: ${v}`);
  for (const v of [-1, '-1', 2.5, '2.5', 'x', Infinity, NaN]) {
    assert.strictEqual(nb.acceptsNonNegativeInteger(v), false, `rejected: ${v}`);
  }
});

test('acceptsNonNegative: finite >= 0, blank allowed, negative rejected', () => {
  for (const v of ['', 0, '0', 0.5, 30000]) assert.strictEqual(nb.acceptsNonNegative(v), true, `ok: ${v}`);
  for (const v of [-0.1, '-1', 'x', Infinity, NaN]) {
    assert.strictEqual(nb.acceptsNonNegative(v), false, `rejected: ${v}`);
  }
});

test('acceptsAtLeast(1000): finite >= 1000, blank allowed', () => {
  const f = nb.acceptsAtLeast(1000);
  for (const v of ['', 1000, '1000', 2500]) assert.strictEqual(f(v), true, `ok: ${v}`);
  for (const v of [999, '500', 0, -1, 'x', Infinity, NaN]) assert.strictEqual(f(v), false, `rejected: ${v}`);
});

test('acceptsIntegerAtLeast(1): integer >= 1, blank allowed, fractional/sub-min rejected', () => {
  const f = nb.acceptsIntegerAtLeast(1);
  for (const v of ['', 1, '1', 8]) assert.strictEqual(f(v), true, `ok: ${v}`);
  for (const v of [0, '0', 0.5, 2.5, -3, 'x', Infinity, NaN]) assert.strictEqual(f(v), false, `rejected: ${v}`);
});
