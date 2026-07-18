'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TRANSPORT_FIELDS, validateConnectionConfig } = require('../../lib/transport/transport-fields');

/**
 * The connection editor (nodes/mavlink-ai-connection.html) runs in the browser
 * and can't `require` the shared spec, so it inlines its own TRANSPORT_VISIBLE /
 * TRANSPORT_REQUIRED copies of lib/transport/transport-fields.js. This test
 * guards against the two drifting apart: it extracts the editor's copies and
 * asserts they match the shared module (issue #103, CodeRabbit review).
 */

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'mavlink-ai-connection.html'), 'utf8');

/**
 * Extract a `var NAME = { ... };` object literal from the editor script and
 * evaluate it back into a plain object. The literals contain only string keys
 * and string arrays (no nested objects), so a non-greedy brace match is safe.
 *
 * @param {string} name  the variable name to extract
 * @returns {object}
 */
function extractObjectLiteral(name) {
  const match = new RegExp(`${name}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`).exec(HTML);
  assert.ok(match, `expected the editor to define ${name}`);
  return new Function(`return (${match[1]})`)();
}

/**
 * Normalize a field list to a sorted array for order-independent comparison.
 *
 * @param {string[]} list
 * @returns {string[]}
 */
function sorted(list) {
  return [...list].sort();
}

test('editor transport field spec matches the shared module', () => {
  const editorVisible = extractObjectLiteral('TRANSPORT_VISIBLE');
  const editorRequired = extractObjectLiteral('TRANSPORT_REQUIRED');

  const moduleTransports = Object.keys(TRANSPORT_FIELDS).sort();
  assert.deepStrictEqual(
    Object.keys(editorVisible).sort(),
    moduleTransports,
    'editor and module cover the same transports (visible)'
  );
  assert.deepStrictEqual(
    Object.keys(editorRequired).sort(),
    moduleTransports,
    'editor and module cover the same transports (required)'
  );

  for (const transport of moduleTransports) {
    assert.deepStrictEqual(
      sorted(editorVisible[transport]),
      sorted(TRANSPORT_FIELDS[transport].visible),
      `visible fields for ${transport} match`
    );
    /**
     * Static required-ness was replaced by presence rules (#243). The one
     * statically-required protocol is serial; derive its required fields from
     * the shared validator (what an all-blank config reports) so the editor's
     * asterisk markers can't drift from the runtime. udp/tcp deployability is
     * combination-based, so their static marker lists must stay empty — the
     * editor mirrors those rules in presenceProblemFields, exercised against
     * the runtime rules in transport-fields.test.js.
     */
    const derivedRequired =
      transport === 'serial'
        ? validateConnectionConfig({ transport, serialPath: '', serialBaud: '' }).map((p) => p.field)
        : [];
    assert.deepStrictEqual(
      sorted(editorRequired[transport]),
      sorted(derivedRequired),
      `required fields for ${transport} match the shared validator`
    );
  }
});
