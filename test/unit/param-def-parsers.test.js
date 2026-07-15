'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseApmPdefJson,
  parsePx4ParamsJson,
  normalizeValues,
  normalizeBitmask
} = require('../../lib/params/param-def-parsers');

/** Look up a parsed ParamDef by id. */
function byId(list, id) {
  return list.find((p) => p.paramId === id);
}

test('parseApmPdefJson normalizes ranges, values, bitmask, and units (#125)', () => {
  const text = JSON.stringify({
    'ArduCopter 4.5.0': {
      '': { SYSID_THISMAV: { Description: 'MAVLink system ID', Range: { low: 1, high: 255 } } },
      RC: { RC1_MIN: { Description: 'RC min', Units: 'PWM', Range: { low: 800, high: 2200 } } },
      FLTMODE: { FLTMODE1: { Description: 'Flight mode 1', Values: { 0: 'Stabilize', 5: 'Loiter', 2: 'AltHold' } } },
      LOG: { LOG_BITMASK: { Description: 'Log bitmask', Bitmask: { 0: 'Fast attitude', 2: 'GPS' } } }
    }
  });
  const params = parseApmPdefJson(text);
  assert.strictEqual(params.length, 4);

  const sysid = byId(params, 'SYSID_THISMAV');
  assert.deepStrictEqual(sysid.range, { min: 1, max: 255 });
  assert.deepStrictEqual(sysid.values, []);
  assert.strictEqual(sysid.type, null);

  assert.strictEqual(byId(params, 'RC1_MIN').units, 'PWM');

  const mode = byId(params, 'FLTMODE1');
  assert.deepStrictEqual(mode.values, [
    { value: 0, label: 'Stabilize' },
    { value: 2, label: 'AltHold' },
    { value: 5, label: 'Loiter' }
  ]);

  const log = byId(params, 'LOG_BITMASK');
  assert.deepStrictEqual(log.bitmask, [
    { bit: 0, label: 'Fast attitude' },
    { bit: 2, label: 'GPS' }
  ]);
});

test('parseApmPdefJson uppercases ids and dedupes, first definition wins (#125)', () => {
  const text = JSON.stringify({
    ArduPlane: {
      G1: { rc1_min: { Description: 'first' } },
      G2: { RC1_MIN: { Description: 'second (dropped)' } }
    }
  });
  const params = parseApmPdefJson(text);
  assert.strictEqual(params.length, 1);
  assert.strictEqual(params[0].paramId, 'RC1_MIN');
  assert.strictEqual(params[0].description, 'first');
});

test('parseApmPdefJson skips non-object group markers and bad JSON throws (#125)', () => {
  const withMarker = JSON.stringify({ ArduCopter: { json: 5, RealGroup: { P: { Description: 'ok' } } } });
  const params = parseApmPdefJson(withMarker);
  assert.deepStrictEqual(params.map((p) => p.paramId), ['P']);

  assert.throws(() => parseApmPdefJson('{not json'), (e) => e.code === 'PARAM_DEF_PARSE_FAILED');
});

test('parseApmPdefJson finds params at varied nesting depth via metadata keys (#125)', () => {
  /** A flatter group->param shape (no vehicle label) plus a deeper nested one. */
  const text = JSON.stringify({
    RC: { RC1_MIN: { Description: 'flat', Range: { low: 800, high: 2200 } } },
    Vehicles: { ArduCopter: { FLTMODE: { FLTMODE1: { DisplayName: 'deep' } } } }
  });
  const params = parseApmPdefJson(text);
  assert.deepStrictEqual(params.map((p) => p.paramId).sort(), ['FLTMODE1', 'RC1_MIN']);
  assert.deepStrictEqual(byId(params, 'RC1_MIN').range, { min: 800, max: 2200 });
  assert.strictEqual(byId(params, 'FLTMODE1').description, 'deep');
});

test('parsePx4ParamsJson maps type, range, values, and bitmask (#125)', () => {
  const text = JSON.stringify({
    version: 1,
    parameters: [
      { name: 'MC_ROLLRATE_P', type: 'FLOAT', min: 0, max: 1, units: '1/s', shortDesc: 'Roll rate P' },
      { name: 'SYS_AUTOSTART', type: 'INT32', shortDesc: 'Airframe', values: [{ value: 4001, description: 'Quad' }, { value: 0, description: 'None' }] },
      { name: 'COM_FLAGS', type: 'INT32', bitmask: [{ index: 1, description: 'B' }, { index: 0, description: 'A' }] }
    ]
  });
  const params = parsePx4ParamsJson(text);
  assert.strictEqual(params.length, 3);

  const roll = byId(params, 'MC_ROLLRATE_P');
  assert.strictEqual(roll.type, 'MAV_PARAM_TYPE_REAL32');
  assert.deepStrictEqual(roll.range, { min: 0, max: 1 });
  assert.strictEqual(roll.units, '1/s');

  const airframe = byId(params, 'SYS_AUTOSTART');
  assert.strictEqual(airframe.type, 'MAV_PARAM_TYPE_INT32');
  assert.deepStrictEqual(airframe.values, [
    { value: 0, label: 'None' },
    { value: 4001, label: 'Quad' }
  ]);

  assert.deepStrictEqual(byId(params, 'COM_FLAGS').bitmask, [
    { bit: 0, label: 'A' },
    { bit: 1, label: 'B' }
  ]);
});

test('parsePx4ParamsJson accepts a parameters object map and a bare array (#125)', () => {
  const asMap = JSON.stringify({ parameters: { a: { name: 'P_A', type: 'INT32' }, b: { name: 'P_B', type: 'FLOAT' } } });
  assert.deepStrictEqual(parsePx4ParamsJson(asMap).map((p) => p.paramId).sort(), ['P_A', 'P_B']);

  const asArray = JSON.stringify([{ name: 'P_C', type: 'FLOAT' }]);
  assert.deepStrictEqual(parsePx4ParamsJson(asArray).map((p) => p.paramId), ['P_C']);

  assert.throws(() => parsePx4ParamsJson('nope'), (e) => e.code === 'PARAM_DEF_PARSE_FAILED');
});

test('normalizeValues accepts object maps, arrays, and "k:v" strings; drops non-numeric keys (#125)', () => {
  assert.deepStrictEqual(normalizeValues({ 0: 'Off', 1: 'On' }), [
    { value: 0, label: 'Off' },
    { value: 1, label: 'On' }
  ]);
  assert.deepStrictEqual(normalizeValues('2:Loiter, 0:Stabilize'), [
    { value: 0, label: 'Stabilize' },
    { value: 2, label: 'Loiter' }
  ]);
  assert.deepStrictEqual(normalizeValues([{ val: 3, name: 'Three' }]), [{ value: 3, label: 'Three' }]);
  assert.deepStrictEqual(normalizeValues({ notNumeric: 'x', 4: 'Four' }), [{ value: 4, label: 'Four' }]);
  assert.deepStrictEqual(normalizeValues(null), []);
});

test('normalizeBitmask accepts the same shapes and rejects negative/non-integer bits (#125)', () => {
  assert.deepStrictEqual(normalizeBitmask({ 0: 'A', 3: 'B' }), [
    { bit: 0, label: 'A' },
    { bit: 3, label: 'B' }
  ]);
  assert.deepStrictEqual(normalizeBitmask('1:Pitch,0:Roll'), [
    { bit: 0, label: 'Roll' },
    { bit: 1, label: 'Pitch' }
  ]);
  assert.deepStrictEqual(normalizeBitmask([{ index: 2, description: 'Two' }]), [{ bit: 2, label: 'Two' }]);
  assert.deepStrictEqual(normalizeBitmask({ '-1': 'bad', 1.5: 'bad', 2: 'ok' }), [{ bit: 2, label: 'ok' }]);
});
