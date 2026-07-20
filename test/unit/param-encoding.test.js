'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { standard } = require('node-mavlink');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { resolveParamEncoding } = require('../../lib/param/param-encoding');

const DIALECT = loadDialect('ardupilotmega');

function opts(extra = {}) {
  return { enums: DIALECT.enums, dialect: DIALECT.name, ...extra };
}

test('capability bits win over the firmware label (#233)', () => {
  assert.deepStrictEqual(
    resolveParamEncoding(opts({ capabilities: standard.MavProtocolCapability.PARAM_ENCODE_BYTEWISE, firmware: 'generic' })),
    { encoding: 'bytewise', source: 'capabilities' }
  );
  assert.deepStrictEqual(
    resolveParamEncoding(opts({ capabilities: standard.MavProtocolCapability.PARAM_ENCODE_C_CAST, firmware: 'px4' })),
    { encoding: 'ccast', source: 'capabilities' }
  );
});

test('a vehicle advertising both bits resolves to bytewise (lossless for NaN-pattern ints)', () => {
  const both = BigInt(standard.MavProtocolCapability.PARAM_ENCODE_BYTEWISE) |
    BigInt(standard.MavProtocolCapability.PARAM_ENCODE_C_CAST);
  assert.strictEqual(resolveParamEncoding(opts({ capabilities: both, firmware: 'generic' })).encoding, 'bytewise');
});

test('no encoding bits (or no report) falls back to the firmware label', () => {
  assert.deepStrictEqual(resolveParamEncoding(opts({ capabilities: 0x8n, firmware: 'px4' })), {
    encoding: 'bytewise',
    source: 'firmware'
  });
  assert.deepStrictEqual(resolveParamEncoding(opts({ capabilities: undefined, firmware: 'generic' })), {
    encoding: 'ccast',
    source: 'firmware'
  });
  assert.strictEqual(resolveParamEncoding(opts()).encoding, 'ccast');
});

test('capabilities accepted as Number or BigInt; garbage falls back to the label', () => {
  const bytewise = standard.MavProtocolCapability.PARAM_ENCODE_BYTEWISE;
  assert.strictEqual(resolveParamEncoding(opts({ capabilities: bytewise, firmware: 'generic' })).encoding, 'bytewise');
  assert.strictEqual(resolveParamEncoding(opts({ capabilities: BigInt(bytewise), firmware: 'generic' })).encoding, 'bytewise');
  assert.deepStrictEqual(resolveParamEncoding(opts({ capabilities: 'not-a-number', firmware: 'px4' })), {
    encoding: 'bytewise',
    source: 'firmware'
  });
});

test('missing capability members fail with complete protocol context', () => {
  for (const member of ['PARAM_ENCODE_BYTEWISE', 'PARAM_ENCODE_C_CAST']) {
    const enums = { ...DIALECT.enums, enumsByName: { ...DIALECT.enums.enumsByName } };
    enums.enumsByName.MavProtocolCapability = { ...enums.enumsByName.MavProtocolCapability };
    delete enums.enumsByName.MavProtocolCapability[member];
    assert.throws(
      () => resolveParamEncoding({ enums, dialect: 'incomplete', firmware: 'px4' }),
      (err) => {
        assert.strictEqual(err.code, 'ENUM_VALUE_UNAVAILABLE');
        assert.deepStrictEqual(err.context, {
          enum: 'MavProtocolCapability',
          member,
          dialect: 'incomplete',
          consumer: 'param-encoding'
        });
        return true;
      }
    );
  }
});
