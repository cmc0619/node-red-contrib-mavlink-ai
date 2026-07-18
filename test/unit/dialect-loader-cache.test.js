'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadDialect } = require('../../lib/dialects/dialect-loader');

const fixture = (name) => path.join(__dirname, '..', 'fixtures', 'dialects', name);

/**
 * Bundled dialect bundles are immutable and cached per resolved name: every
 * profile config node loads its dialect on deploy, and rebuilding the merged
 * registry + enum index per profile was pure repeated work. Custom XML
 * compiles stay uncached so an edited file is honored on the next deploy.
 */

test('bundled dialect loads are cached: the same name returns the same bundle object', () => {
  const first = loadDialect('ardupilotmega');
  const second = loadDialect('ardupilotmega');
  assert.ok(first.valid, 'bundle loads');
  assert.strictEqual(second, first, 'second load reuses the built bundle');
  assert.notStrictEqual(loadDialect('common'), first, 'different dialects keep distinct bundles');
});

test('a custom request naming a bundled basename shares the cached innards but reports requested "custom"', () => {
  const plain = loadDialect('common');
  const viaCustom = loadDialect('custom', { customDialectPath: 'common' });
  assert.strictEqual(plain.requested, 'common');
  assert.strictEqual(viaCustom.requested, 'custom', 'diagnostics keep the caller\'s own name');
  assert.strictEqual(viaCustom.registry, plain.registry, 'registry is shared, not rebuilt');
  assert.strictEqual(viaCustom.enums, plain.enums, 'enum index is shared, not rebuilt');
  assert.strictEqual(viaCustom.fieldEnums, plain.fieldEnums, 'field-enum map is shared, not rebuilt');
});

test('custom XML compiles are never cached: each load recompiles the file', () => {
  const first = loadDialect('custom', { customDialectPath: fixture('custom_vehicle.xml') });
  const second = loadDialect('custom', { customDialectPath: fixture('custom_vehicle.xml') });
  assert.ok(first.valid && second.valid, 'both compiles succeed');
  assert.notStrictEqual(second, first, 'a fresh compile per load — an edited file must win');
  assert.notStrictEqual(second.registry, first.registry, 'no shared state between compiles');
});
