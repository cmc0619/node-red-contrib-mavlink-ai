'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const nb = require('../../lib/util/numeric-bounds');

/**
 * The node editors run in the browser and cannot require lib/util/numeric-bounds.js,
 * so each inlines an identical `mavlinkNumericBounds()` mirror. This test extracts
 * that mirror from every editor that uses it and asserts it agrees with the module
 * across a value matrix, then asserts each numeric field is wired to the right
 * predicate. Guards against editor/runtime drift (#210).
 */

const NODES_DIR = path.join(__dirname, '..', '..', 'nodes');

const EDITOR_FILES = [
  'mavlink-ai-command.html',
  'mavlink-ai-mission.html',
  'mavlink-ai-fanout.html',
  'mavlink-ai-swarm.html',
  'mavlink-ai-connection.html'
];

// (file, field, module rule evaluated against nb)
const FIELD_RULES = [
  ['mavlink-ai-command.html', 'timeoutMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-command.html', 'maxRetries', (v) => nb.acceptsNonNegativeInteger(v)],
  ['mavlink-ai-mission.html', 'timeoutMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-mission.html', 'maxRetries', (v) => nb.acceptsNonNegativeInteger(v)],
  ['mavlink-ai-fanout.html', 'timeoutMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-fanout.html', 'maxRetries', (v) => nb.acceptsNonNegativeInteger(v)],
  ['mavlink-ai-fanout.html', 'spacingMs', (v) => nb.acceptsNonNegative(v)],
  ['mavlink-ai-fanout.html', 'concurrency', (v) => nb.acceptsIntegerAtLeast(1)(v)],
  ['mavlink-ai-swarm.html', 'staleMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-swarm.html', 'expireMs', (v) => nb.acceptsNonNegative(v)],
  ['mavlink-ai-swarm.html', 'intervalMs', (v) => nb.acceptsNonNegative(v)],
  ['mavlink-ai-connection.html', 'heartbeatIntervalMs', (v) => nb.acceptsAtLeast(1000)(v)]
];

// Values exercised at every field to prove editor == module.
const MATRIX = ['', '   ', null, undefined, 0, '0', 1, '1', -1, '-5', 0.5, 2.5, 1000, '2500', 999, 'abc', Infinity, NaN];

function read(file) {
  return fs.readFileSync(path.join(NODES_DIR, file), 'utf8');
}

/** Extract and evaluate the inline mavlinkNumericBounds() factory from an editor. */
function extractBounds(html) {
  const match = /function mavlinkNumericBounds\(\)\s*\{[\s\S]*?\n {2}\}/.exec(html);
  assert.ok(match, 'expected the editor to inline mavlinkNumericBounds()');
  return new Function(`${match[0]}; return mavlinkNumericBounds();`)();
}

/** Extract a field's validate function from the editor's defaults block. */
function extractFieldValidate(html, field) {
  const re = new RegExp(`${field}:\\s*\\{[^}]*?validate:\\s*(function \\(v\\) \\{ return [^}]*?\\})`);
  const match = re.exec(html);
  assert.ok(match, `expected ${field} to have an inline validate function`);
  return new Function('mavlinkNumericBounds', `return (${match[1]});`);
}

test('each editor inlines mavlinkNumericBounds() matching the module', () => {
  const factory = {
    positive: (b) => b.positive,
    nonNegativeInteger: (b) => b.nonNegativeInteger,
    nonNegative: (b) => b.nonNegative,
    atLeast1000: (b) => b.atLeast(1000),
    integerAtLeast1: (b) => b.integerAtLeast(1)
  };
  const moduleFns = {
    positive: nb.acceptsPositive,
    nonNegativeInteger: nb.acceptsNonNegativeInteger,
    nonNegative: nb.acceptsNonNegative,
    atLeast1000: nb.acceptsAtLeast(1000),
    integerAtLeast1: nb.acceptsIntegerAtLeast(1)
  };
  for (const file of EDITOR_FILES) {
    const bounds = extractBounds(read(file));
    for (const key of Object.keys(factory)) {
      const editorFn = factory[key](bounds);
      for (const v of MATRIX) {
        assert.strictEqual(
          Boolean(editorFn(v)),
          Boolean(moduleFns[key](v)),
          `${file} ${key}(${JSON.stringify(v)}) editor != module`
        );
      }
    }
  }
});

test('each numeric field is wired to the runtime-matching predicate', () => {
  const cache = {};
  for (const [file, field, moduleRule] of FIELD_RULES) {
    const html = (cache[file] = cache[file] || read(file));
    const bounds = extractBounds(html);
    const build = extractFieldValidate(html, field);
    const editorValidate = build(() => bounds); // mavlinkNumericBounds() → bounds
    for (const v of MATRIX) {
      assert.strictEqual(
        Boolean(editorValidate(v)),
        Boolean(moduleRule(v)),
        `${file} field ${field} validate(${JSON.stringify(v)}) != runtime rule`
      );
    }
  }
});
