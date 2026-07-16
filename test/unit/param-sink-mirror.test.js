'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Command-editor param sink mirroring (#251). Every param control writes user
 * edits through one shared sink; renderParamField rebuilds each control from
 * savedParams[key], so before the mirror a metadata refresh mid-edit (profile,
 * target component, or command change) silently reverted unsaved edits in all
 * five control types. The sink now mirrors every write into savedParams — an
 * empty write removes the key — so a re-render builds from the latest edit.
 *
 * Like the bitmask spec test (#242), this extracts the editor's real makeSink
 * source and drives it with a minimal jQuery stand-in, so the mechanism under
 * test is the shipped code, not a copy.
 */

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'mavlink-ai-command.html'), 'utf8');

/** Minimal chainable stand-in for the jQuery surface makeSink touches. */
function fakeJq() {
  const el = { attrs: {}, value: '' };
  const $obj = {
    attr(name, value) {
      el.attrs[name] = value;
      return $obj;
    },
    val(value) {
      if (!arguments.length) {
        return el.value;
      }
      el.value = String(value);
      return $obj;
    }
  };
  return $obj;
}

/**
 * Extract the editor's makeSink (defined at 6-space indent, closing at the
 * first 6-space brace) and bind it to a given savedParams object.
 *
 * @param {object} savedParams
 * @returns {function}
 */
function editorMakeSink(savedParams) {
  const match = /(function makeSink\(key, saved\) \{[\s\S]*?\n      \})/.exec(HTML);
  assert.ok(match, 'expected the editor to define makeSink');
  return new Function('$', 'savedParams', `${match[1]}\nreturn makeSink;`)(fakeJq, savedParams);
}

test('a control write mirrors into savedParams so a re-render keeps the edit (#251)', () => {
  const savedParams = { param1: 400 };
  const makeSink = editorMakeSink(savedParams);

  const $sink = makeSink('param1', savedParams.param1);
  assert.strictEqual($sink.val(), '400', 'renders the last-saved value');

  /** The user edits (any of the five controls writes through the sink)... */
  $sink.val('21196');
  assert.strictEqual(savedParams.param1, '21196', 'the edit is mirrored');

  /** ...then a metadata refresh re-renders the field from savedParams. */
  const $rebuilt = makeSink('param1', savedParams.param1);
  assert.strictEqual($rebuilt.val(), '21196', 'the re-render keeps the unsaved edit');
});

test('an empty write removes the key, matching the collector\'s unset semantics (#251)', () => {
  const savedParams = { param2: 7 };
  const makeSink = editorMakeSink(savedParams);

  const $sink = makeSink('param2', savedParams.param2);
  $sink.val('');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(savedParams, 'param2'), false, 'cleared, not stored as ""');
  const $rebuilt = makeSink('param2', savedParams.param2);
  assert.strictEqual($rebuilt.val(), '', 'a re-render shows the field unset');
});

test('the initial render never mutates savedParams (#251)', () => {
  const savedParams = {};
  const makeSink = editorMakeSink(savedParams);

  /** Rendering an absent value must not create the key... */
  makeSink('param3', savedParams.param3);
  assert.deepStrictEqual(savedParams, {}, 'rendering from nothing stores nothing');

  /** ...and reads never write. */
  const $sink = makeSink('param3', undefined);
  $sink.val();
  assert.deepStrictEqual(savedParams, {});
});
