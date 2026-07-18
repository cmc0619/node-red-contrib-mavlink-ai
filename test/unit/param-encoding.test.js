'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  resolveParamEncoding,
  PARAM_ENCODE_BYTEWISE,
  PARAM_ENCODE_C_CAST
} = require('../../lib/param/param-encoding');

test('capability bits win over the firmware label (#233)', () => {
  /** BYTEWISE-advertising vehicle behind a generic/ArduPilot-labeled profile. */
  assert.deepStrictEqual(resolveParamEncoding({ capabilities: PARAM_ENCODE_BYTEWISE, firmware: 'generic' }), {
    encoding: 'bytewise',
    source: 'capabilities'
  });
  /** C_CAST-advertising vehicle behind a px4-labeled profile. */
  assert.deepStrictEqual(resolveParamEncoding({ capabilities: PARAM_ENCODE_C_CAST, firmware: 'px4' }), {
    encoding: 'ccast',
    source: 'capabilities'
  });
});

test('a vehicle advertising both bits resolves to bytewise (lossless for NaN-pattern ints)', () => {
  const both = PARAM_ENCODE_BYTEWISE | PARAM_ENCODE_C_CAST;
  assert.strictEqual(resolveParamEncoding({ capabilities: both, firmware: 'generic' }).encoding, 'bytewise');
});

test('no encoding bits (or no report) falls back to the firmware label', () => {
  /** Capabilities reported but with neither encoding bit — e.g. only MISSION_INT. */
  assert.deepStrictEqual(resolveParamEncoding({ capabilities: 0x8n, firmware: 'px4' }), {
    encoding: 'bytewise',
    source: 'firmware'
  });
  assert.deepStrictEqual(resolveParamEncoding({ capabilities: undefined, firmware: 'generic' }), {
    encoding: 'ccast',
    source: 'firmware'
  });
  assert.strictEqual(resolveParamEncoding({}).encoding, 'ccast');
});

test('capabilities accepted as Number or BigInt; garbage falls back to the label', () => {
  assert.strictEqual(resolveParamEncoding({ capabilities: 16, firmware: 'generic' }).encoding, 'bytewise');
  assert.strictEqual(resolveParamEncoding({ capabilities: 16n, firmware: 'generic' }).encoding, 'bytewise');
  const garbage = resolveParamEncoding({ capabilities: 'not-a-number', firmware: 'px4' });
  assert.deepStrictEqual(garbage, { encoding: 'bytewise', source: 'firmware' });
});
