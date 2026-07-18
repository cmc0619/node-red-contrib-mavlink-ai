'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { boundedSet, MAX_TRACKED_KEYS } = require('../../lib/util/bounded-map');

test('boundedSet caps the map and evicts oldest-inserted first', () => {
  const map = new Map();
  for (let i = 0; i < MAX_TRACKED_KEYS + 500; i += 1) {
    boundedSet(map, `key${i}`, i);
  }
  assert.strictEqual(map.size, MAX_TRACKED_KEYS, 'size never exceeds the cap');
  assert.strictEqual(map.has('key0'), false, 'oldest entries were evicted');
  assert.strictEqual(map.has(`key${MAX_TRACKED_KEYS + 499}`), true, 'newest entry retained');
});

test('re-setting an existing key updates in place without evicting', () => {
  const map = new Map();
  for (let i = 0; i < MAX_TRACKED_KEYS; i += 1) {
    boundedSet(map, `key${i}`, i);
  }
  boundedSet(map, 'key5', 'updated');
  assert.strictEqual(map.size, MAX_TRACKED_KEYS, 'no eviction for an in-place update');
  assert.strictEqual(map.get('key5'), 'updated');
  assert.strictEqual(map.has('key0'), true, 'nothing was displaced');
});
