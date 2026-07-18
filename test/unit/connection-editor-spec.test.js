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

test('editor presence rules agree with the runtime validator, case by case (#243, CodeRabbit review)', () => {
  /**
   * The editor inlines a pure copy of the presence rules
   * (transportPresenceState) that both the field validators and the live
   * derived-role hint consume. Extract and execute it against the shared
   * runtime validator across the interesting cases, so the hint can never
   * claim a role the runtime would reject.
   */
  const match = /function transportPresenceState\(t, v\) \{[\s\S]*?\n    \}/.exec(HTML);
  assert.ok(match, 'expected the editor to define transportPresenceState');
  const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
  const editorState = new Function('isBlank', `return ${match[0]}`)(isBlank);

  const cases = [
    { t: 'udp', v: { bindPort: 14550, remoteHost: '', remotePort: '' } },
    { t: 'udp', v: { bindPort: '', remoteHost: '10.0.0.5', remotePort: 14550 } },
    { t: 'udp', v: { bindPort: 14550, remoteHost: '10.0.0.5', remotePort: 14551 } },
    { t: 'udp', v: { bindPort: '', remoteHost: '', remotePort: '' } },
    { t: 'udp', v: { bindPort: 14550, remoteHost: '10.0.0.5', remotePort: '' } },
    { t: 'udp', v: { bindPort: 14550, remoteHost: '', remotePort: 14551 } },
    { t: 'udp', v: { bindPort: '', remoteHost: '10.0.0.5', remotePort: 0 } },
    { t: 'udp', v: { bindPort: '', remoteHost: '10.0.0.5', remotePort: 70000 } },
    { t: 'tcp', v: { bindPort: 5760, remoteHost: '', remotePort: '' } },
    { t: 'tcp', v: { bindPort: '', remoteHost: '10.0.0.5', remotePort: 5760 } },
    { t: 'tcp', v: { bindPort: 5760, remoteHost: '10.0.0.5', remotePort: 5761 } },
    { t: 'tcp', v: { bindPort: '', remoteHost: '', remotePort: '' } },
    { t: 'tcp', v: { bindPort: 5760, remoteHost: '10.0.0.5', remotePort: '' } },
    { t: 'tcp', v: { bindPort: '', remoteHost: '10.0.0.5', remotePort: 0 } }
  ];
  for (const { t, v } of cases) {
    const runtime = validateConnectionConfig(Object.assign({ transport: t }, v));
    const editor = editorState(t, v);
    const label = `${t} ${JSON.stringify(v)}`;
    // Deployability must agree exactly.
    assert.strictEqual(
      Object.keys(editor.bad).length === 0,
      runtime.length === 0,
      `${label}: editor says ${JSON.stringify(editor.bad)}, runtime says ${JSON.stringify(runtime)}`
    );
    // And every runtime-implicated field must be flagged by the editor too, so
    // the red marker lands on the same input the deploy error names.
    for (const problem of runtime) {
      assert.ok(editor.bad[problem.field], `${label}: editor misses field '${problem.field}' (${JSON.stringify(editor.bad)})`);
    }
  }
});
