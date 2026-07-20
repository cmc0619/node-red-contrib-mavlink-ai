'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect, getMessageClass } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * The wire-boundary safety net the greenfield spec §3.5 requires: prove the
 * codec is a faithful boundary between JavaScript's loose numbers and MAVLink's
 * exact bytes, across *every* field type, so the recurring sign/NaN/char[]/
 * overflow bugs (see WIRE_ENCODING_GOTCHAS.md) are caught mechanically instead
 * of one review round at a time.
 *
 * Two layers, per §3.5:
 *  1. Property round-trip over every message/field type in the bundled dialects:
 *     encode(x) -> decode -> the field values reproduce `x`, compared NaN-aware
 *     and at float32 precision (a round trip alone catches asymmetric bugs).
 *  2. Golden payload-byte vectors for canonical messages: the encoded payload
 *     equals bytes derived by hand from the MAVLink field-ordering rule — an
 *     external anchor that a symmetric encode/decode bug cannot satisfy.
 */

const DIALECTS = ['common', 'ardupilotmega', 'development'];

/**
 * Decode one framed buffer back to `{ name, fields }` through the codec. Rejects
 * (never hangs) if the splitter drops the frame — CRC/length/msgid regression —
 * or if `decode` throws, so this exhaustive net reports the offending message
 * instead of stalling, which is exactly when it must be useful (Codex review).
 */
function roundtrip(codec, buffer, label = 'frame') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no decoded packet for ${label} — splitter dropped the frame?`)),
      2000
    );
    try {
      const dec = codec.createDecoder((packet) => {
        clearTimeout(timer);
        try {
          resolve(codec.decode(packet, { profile: 'RT' }));
        } catch (err) {
          reject(err);
        }
      });
      dec.write(buffer);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/** Split `uint16_t[4]` into `{ base: 'uint16_t', count: 4 }`; scalars get count 0. */
function fieldShape(field) {
  const m = /^(.*?)\[(\d*)\]$/.exec(field.type);
  if (!m) {
    return { base: field.type, count: 0 };
  }
  /**
   * Element count: an explicit bracket count if the type carries one, else the
   * field metadata. Bundled dialects (mavlink-mappings) store it on `length`;
   * the custom-XML compiler uses `arrayLength`. Honor all three so the net
   * exercises arrays regardless of dialect source (Codex review). A per-dialect
   * assertion below fails loudly if this ever resolves arrays to 0.
   */
  const bracket = m[2] ? Number(m[2]) : 0;
  return { base: m[1], count: bracket || field.arrayLength || field.length || 0 };
}

/**
 * A representative scalar value per base type, chosen to expose the classic
 * boundary bugs: unsigned values above the signed-32 line, negatives on signed
 * fields, and a float that must narrow to IEEE float32.
 */
function sampleScalar(base) {
  switch (base) {
    case 'uint8_t':
    case 'uint8_t_mavlink_version':
      return 200; // > 127: catches int8/uint8 sign confusion
    case 'int8_t':
      return -5;
    case 'uint16_t':
      return 60000;
    case 'int16_t':
      return -1000;
    case 'uint32_t':
      return 4000000000; // > 2^31: catches JS signed-32 mishandling
    case 'int32_t':
      return -123456789;
    case 'uint64_t':
      return 18000000000000000000n; // > 2^63
    case 'int64_t':
      return -9000000000000000n;
    case 'float':
      return 3.14159; // not float32-exact: proves the narrowing is handled
    case 'double':
      return 3.141592653589793;
    case 'char':
      return 'RT';
    default:
      throw new Error(`unhandled base type '${base}'`);
  }
}

/**
 * A per-index, in-range value for array element `i`. Distinct across indices
 * (step coprime with the modulus) so a bug that writes element 0 into every
 * slot, or reads from the wrong offset, cannot round-trip to the same repeated
 * array and slip through (Codex review).
 */
function sampleScalarAt(base, i) {
  switch (base) {
    case 'uint8_t':
    case 'uint8_t_mavlink_version':
      return (i * 13 + 5) % 250;
    case 'int8_t':
      return ((i * 13 + 5) % 200) - 100;
    case 'uint16_t':
      return (i * 1237 + 7) % 60000;
    case 'int16_t':
      return ((i * 1237 + 7) % 60000) - 30000;
    case 'uint32_t':
      return i * 1000003 + 11;
    case 'int32_t':
      return i * 1000003 - 500000;
    case 'uint64_t':
      return BigInt(i) * 1000003n + 11n;
    case 'int64_t':
      return BigInt(i) * 1000003n - 500000n;
    case 'float':
    case 'double':
      return i + 0.5; // float32-exact, distinct per index
    default:
      throw new Error(`unhandled array base type '${base}'`);
  }
}

/**
 * An exact-width string of `count` distinct printable Latin-1 chars, so a
 * `char[N]` field is exercised at full width — an encoder/decoder that drops or
 * corrupts the final byte of `PARAM_SET.param_id[16]` / `STATUSTEXT.text[50]`
 * fails instead of passing on a 2-char stub (Codex review; §3.5 checklist).
 */
function charSample(count) {
  let s = '';
  for (let i = 0; i < count; i += 1) {
    s += String.fromCharCode(65 + (i % 58)); // 'A'..'z', all printable, none NUL/space
  }
  return s;
}

/** Build a fields object assigning every field a type-appropriate sample value. */
function sampleFields(clazz) {
  const fields = {};
  for (const field of clazz.FIELDS) {
    const { base, count } = fieldShape(field);
    if (base === 'char') {
      fields[field.source] = count > 0 ? charSample(count) : 'RT';
    } else if (count > 0) {
      fields[field.source] = Array.from({ length: count }, (_v, i) => sampleScalarAt(base, i));
    } else {
      fields[field.source] = sampleScalar(base);
    }
  }
  return fields;
}

/** float32-aware / BigInt-aware / NaN-aware equality for a single scalar. */
function scalarEqual(base, expected, actual) {
  if (base === 'float' || base === 'double') {
    if (Number.isNaN(expected)) {
      return Number.isNaN(actual);
    }
    const exp = base === 'float' ? Math.fround(expected) : expected;
    return Object.is(exp, typeof actual === 'number' ? actual : Number(actual));
  }
  if (base === 'uint64_t' || base === 'int64_t') {
    return BigInt(expected) === BigInt(actual);
  }
  return expected === actual;
}

/** Compare a decoded field value against what was encoded, honoring arrays. */
function fieldEqual(field, expected, actual) {
  const { base, count } = fieldShape(field);
  if (base === 'char') {
    // Decoded char[] comes back as a string; the codec pads to width, so compare
    // the meaningful prefix (trailing NULs / spaces stripped).
    return String(actual).replace(/[\0 ]+$/, '') === String(expected).replace(/[\0 ]+$/, '');
  }
  if (count > 0) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    return expected.every((v, i) => scalarEqual(base, v, actual[i]));
  }
  return scalarEqual(base, expected, actual);
}

for (const dialect of DIALECTS) {
  test(`round-trips every message/field type in '${dialect}' (§3.5)`, async () => {
    const bundle = loadDialect(dialect);
    assert.ok(bundle.valid, `dialect '${dialect}' should load`);
    const codec = new MavlinkCodec({ bundle });

    const failures = [];
    let messages = 0;
    let fieldsChecked = 0;
    let arraysChecked = 0;

    for (const id of Object.keys(bundle.registry)) {
      const clazz = getMessageClass(bundle, Number(id));
      if (!clazz || !clazz.FIELDS || !clazz.FIELDS.length) {
        continue;
      }
      const input = sampleFields(clazz);
      let decoded;
      try {
        const buf = enc(codec, clazz.MSG_NAME, input, { sysid: 1, compid: 1 });
        decoded = await roundtrip(codec, buf, clazz.MSG_NAME);
      } catch (err) {
        failures.push(`${clazz.MSG_NAME}: encode/decode threw — ${err.message}`);
        continue;
      }
      messages += 1;
      for (const field of clazz.FIELDS) {
        fieldsChecked += 1;
        if (fieldShape(field).count > 0) {
          arraysChecked += 1;
        }
        const expected = input[field.source];
        const actual = decoded.fields[field.source];
        if (!fieldEqual(field, expected, actual)) {
          failures.push(
            `${clazz.MSG_NAME}.${field.source} (${field.type}): sent ${JSON.stringify(
              expected,
              (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)
            )}, got ${JSON.stringify(actual, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`
          );
        }
      }
    }

    assert.strictEqual(
      failures.length,
      0,
      `wire round-trip failures in '${dialect}' (${messages} msgs / ${fieldsChecked} fields):\n` +
        failures.slice(0, 40).join('\n')
    );
    /**
     * Guard against a silent regression to "arrays sampled/compared as scalars"
     * (e.g. a field-metadata shape change): every bundled dialect has array
     * fields, so a zero here means the net stopped actually exercising them.
     */
    assert.ok(
      arraysChecked > 0,
      `'${dialect}': expected the net to verify array fields, but none were exercised`
    );
  });
}

test('NaN is preserved as a sentinel on a float field, not silently 0/null (§3.5)', async () => {
  const bundle = loadDialect('common');
  const codec = new MavlinkCodec({ bundle });
  /**
   * SET_POSITION_TARGET_LOCAL_NED uses NaN in unused axes as a real "keep
   * current" signal. The codec preserves a non-finite float as the JSON-safe
   * sentinel string 'NaN' (not 0/null), so it survives normalized transport and
   * can be fed straight back — that IS the round-trip contract here.
   */
  const buf = enc(
    codec,
    'SET_POSITION_TARGET_LOCAL_NED',
    { time_boot_ms: 1, x: NaN, y: 1.5, z: NaN, type_mask: 0, coordinate_frame: 1 },
    { sysid: 1, compid: 1 }
  );
  const decoded = await roundtrip(codec, buf);
  assert.strictEqual(decoded.fields.x, 'NaN', 'NaN must be preserved as the sentinel, not become 0');
  assert.strictEqual(decoded.fields.z, 'NaN');
  assert.strictEqual(Math.fround(1.5), decoded.fields.y);

  /** Feeding the decoded sentinel back must re-encode to a real NaN on the wire. */
  const rebuf = enc(codec, 'SET_POSITION_TARGET_LOCAL_NED', decoded.fields, { sysid: 1, compid: 1 });
  const redecoded = await roundtrip(codec, rebuf);
  assert.strictEqual(redecoded.fields.x, 'NaN', 'the sentinel must survive a second round trip losslessly');
});

test('golden HEARTBEAT payload matches hand-derived MAVLink bytes (§3.5)', () => {
  const bundle = loadDialect('common');
  const codec = new MavlinkCodec({ bundle });
  const buf = enc(
    codec,
    'HEARTBEAT',
    { type: 2, autopilot: 3, base_mode: 81, custom_mode: 0, system_status: 4, mavlink_version: 3 },
    { sysid: 1, compid: 1 }
  );
  /**
   * MAVLink orders payload fields by wire-type size (largest first), so HEARTBEAT
   * (id 0) serializes as: custom_mode (uint32, LE) | type | autopilot | base_mode
   * | system_status | mavlink_version. This byte sequence is derived from that
   * rule, independent of node-mavlink — a symmetric encode/decode bug cannot
   * produce it. The v2 header is 10 bytes; a 9-byte payload follows.
   */
  const expected = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x51, 0x04, 0x03]);
  const payload = buf.subarray(10, 10 + expected.length);
  assert.deepStrictEqual(payload, expected);
});
