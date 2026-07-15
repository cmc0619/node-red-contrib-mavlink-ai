'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { fieldsSignature } = require('../../lib/util/fields-signature');
const { nonFiniteFloatToString, parseFloatSentinel } = require('../../lib/util/float-sentinels');

/**
 * Non-finite float representation (#153 item 2).
 *
 * MAVLink float/double fields carry NaN (the "ignore this field" sentinel) and
 * ±Infinity legitimately. JSON.stringify turns all of them into null, losing the
 * sentinel and collapsing the three distinct values (and a genuine null) into
 * one. The decode contract represents them as the strings "NaN"/"Infinity"/
 * "-Infinity" (mirroring the 64-bit decimal-string convention), the builder
 * accepts those strings back on float fields, and the fields-signature keeps them
 * distinct for changed-only filtering.
 */

const bundle = loadDialect('common');

/**
 * Encode then decode through the streaming decoder, returning decoded fields.
 *
 * @param {string} name
 * @param {object} fields
 * @returns {object}
 */
function roundTripFields(name, fields) {
  const enc = new MavlinkCodec({ bundle, version: 'v2', sysid: 1, compid: 1 });
  const buf = enc.encode(name, fields, {});
  const dec = new MavlinkCodec({ bundle, version: 'v2', sysid: 9, compid: 1 });
  let out = null;
  let err = null;
  const d = dec.createDecoder(
    (p) => {
      out = dec.decode(p, {});
    },
    (e) => {
      err = e;
    }
  );
  d.write(buf);
  d.destroy();
  assert.strictEqual(err, null, err && err.message);
  assert.ok(out, 'packet decoded');
  return out.fields;
}

test('nonFiniteFloatToString maps each non-finite value to its token', () => {
  assert.strictEqual(nonFiniteFloatToString(NaN), 'NaN');
  assert.strictEqual(nonFiniteFloatToString(Infinity), 'Infinity');
  assert.strictEqual(nonFiniteFloatToString(-Infinity), '-Infinity');
});

test('parseFloatSentinel whitelists the sentinels and rejects everything else', () => {
  assert.ok(Number.isNaN(parseFloatSentinel('NaN')));
  assert.ok(Number.isNaN(parseFloatSentinel('nan')));
  assert.strictEqual(parseFloatSentinel('Infinity'), Infinity);
  assert.strictEqual(parseFloatSentinel('inf'), Infinity);
  assert.strictEqual(parseFloatSentinel('+Infinity'), Infinity);
  assert.strictEqual(parseFloatSentinel('-Infinity'), -Infinity);
  assert.strictEqual(parseFloatSentinel('-inf'), -Infinity);
  /** Typos and near-misses must not silently become NaN/Infinity. */
  for (const bad of ['NAM', 'infi', '1.5', '', 'Infinityx', 'na']) {
    assert.strictEqual(parseFloatSentinel(bad), undefined, bad);
  }
});

test('decoded non-finite float fields become sentinel strings and survive JSON', () => {
  /** afx/afy/afz are float fields; send each non-finite value. */
  const f = roundTripFields('SET_POSITION_TARGET_LOCAL_NED', {
    target_system: 1,
    target_component: 1,
    coordinate_frame: 1,
    type_mask: 0,
    afx: NaN,
    afy: Infinity,
    afz: -Infinity,
    vx: 2.5
  });
  assert.strictEqual(f.afx, 'NaN');
  assert.strictEqual(f.afy, 'Infinity');
  assert.strictEqual(f.afz, '-Infinity');
  assert.strictEqual(f.vx, 2.5);
  /** The whole payload must JSON-serialize without the sentinels becoming null. */
  const json = JSON.parse(JSON.stringify(f));
  assert.strictEqual(json.afx, 'NaN');
  assert.strictEqual(json.afy, 'Infinity');
  assert.strictEqual(json.afz, '-Infinity');
});

test('sentinel strings round-trip back onto float fields (case/abbrev tolerant)', () => {
  const f = roundTripFields('SET_POSITION_TARGET_LOCAL_NED', {
    target_system: 1,
    target_component: 1,
    coordinate_frame: 1,
    type_mask: 0,
    afx: 'NaN',
    afy: 'infinity',
    afz: '-inf'
  });
  assert.strictEqual(f.afx, 'NaN');
  assert.strictEqual(f.afy, 'Infinity');
  assert.strictEqual(f.afz, '-Infinity');
});

test('fieldsSignature keeps NaN, Infinity, -Infinity and null distinct', () => {
  const sigs = [
    fieldsSignature({ a: NaN }),
    fieldsSignature({ a: Infinity }),
    fieldsSignature({ a: -Infinity }),
    fieldsSignature({ a: null })
  ];
  assert.strictEqual(new Set(sigs).size, 4, 'all four representations are distinct');
  /** The same non-finite value is stable across calls (no NaN !== NaN surprise). */
  assert.strictEqual(fieldsSignature({ a: NaN }), fieldsSignature({ a: NaN }));
  /** A decoded sentinel string and a raw non-finite number share a signature. */
  assert.strictEqual(fieldsSignature({ a: NaN }), fieldsSignature({ a: 'NaN' }));
});
