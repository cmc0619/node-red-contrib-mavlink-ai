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
  'mavlink-ai-connection.html',
  'mavlink-ai-formation.html',
  'mavlink-ai-vehicle-state.html'
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
  ['mavlink-ai-connection.html', 'heartbeatIntervalMs', (v) => nb.acceptsAtLeast(1000)(v)],
  // Same runtime clamps as swarm, one node over (VehicleRegistry / engine).
  ['mavlink-ai-formation.html', 'staleMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-formation.html', 'expireMs', (v) => nb.acceptsNonNegative(v)],
  ['mavlink-ai-vehicle-state.html', 'staleMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-vehicle-state.html', 'statustextBuffer', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-vehicle-state.html', 'intervalSeconds', (v) => nb.acceptsNonNegative(v)]
];

// Values exercised at every field to prove editor == module.
const MATRIX = ['', '   ', null, undefined, 0, '0', 1, '1', -1, '-5', 0.5, 2.5, 1000, '2500', 999, 'abc', Infinity, NaN];

function read(file) {
  return fs.readFileSync(path.join(NODES_DIR, file), 'utf8');
}

/**
 * Return the `{ ... }` block starting at the first `{` at or after `from`,
 * matched by brace depth. Brace-matching (rather than an indentation- or
 * one-liner-anchored regex) keeps the extraction robust to reformatting and
 * to multi-line/early-return function bodies (Greptile #310 P2). The editor
 * code this scans contains no braces inside string/regex literals, so a plain
 * depth counter is sufficient.
 *
 * @param {string} src
 * @param {number} from  index to begin searching for the opening brace
 * @param {string} what  label for the assertion message
 * @returns {string} the balanced `{ ... }` substring (inclusive)
 */
function sliceBalancedBraces(src, from, what) {
  const open = src.indexOf('{', from);
  assert.ok(open !== -1, `expected an opening brace for ${what}`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') {
      depth += 1;
    } else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(open, i + 1);
      }
    }
  }
  assert.fail(`unbalanced braces while extracting ${what}`);
  return '';
}

/** Extract and evaluate the inline mavlinkNumericBounds() factory from an editor. */
function extractBounds(html) {
  const at = html.indexOf('function mavlinkNumericBounds()');
  assert.ok(at !== -1, 'expected the editor to inline a function named exactly mavlinkNumericBounds()');
  const body = sliceBalancedBraces(html, at, 'mavlinkNumericBounds() body');
  return new Function(`return (function mavlinkNumericBounds() ${body})();`)();
}

/**
 * Extract a field's `validate` function from the editor's defaults block. The
 * validators here are one-liners, but this scans by brace depth so a future
 * multi-line or early-return validator still extracts correctly and fails
 * loudly with a specific message if the field/validate is missing.
 *
 * @param {string} html
 * @param {string} field  the defaults key (e.g. 'timeoutMs')
 * @returns {Function} a factory taking `mavlinkNumericBounds` → the validate fn
 */
function extractFieldValidate(html, field) {
  const fieldAt = new RegExp(`\\b${field}:\\s*\\{`).exec(html);
  assert.ok(fieldAt, `expected the editor to define a '${field}' defaults field`);
  const fieldObj = sliceBalancedBraces(html, fieldAt.index, `${field} defaults object`);
  const vAt = fieldObj.indexOf('validate:');
  assert.ok(vAt !== -1, `expected the '${field}' field to have a validate function`);
  const fnAt = fieldObj.indexOf('function', vAt);
  assert.ok(fnAt !== -1, `expected '${field}'.validate to be a function expression`);
  const fnBody = sliceBalancedBraces(fieldObj, fnAt, `${field}.validate body`);
  return new Function('mavlinkNumericBounds', `return (function (v) ${fnBody});`);
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
