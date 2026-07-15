'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { compileXmlDialect } = require('../../lib/dialects/xml-dialect-compiler');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { LinkState } = require('../../lib/protocol/link-state');

const DIR = path.join(__dirname, '..', 'fixtures', 'dialects');
const fixture = (name) => path.join(DIR, name);

/** Encode then decode a message through a codec, returning the decoded payload. */
function roundTrip(bundle, name, fields) {
  const codec = new MavlinkCodec({ bundle, version: 'v2' });
  const buf = codec.encode(name, fields, { sysid: 42, compid: 1, link: new LinkState() });
  let decoded = null;
  let error = null;
  const dec = codec.createDecoder(
    (packet) => {
      decoded = codec.decode(packet, {});
    },
    (e) => {
      error = e;
    }
  );
  dec.write(buf);
  dec.destroy();
  assert.strictEqual(error, null, error && error.message);
  assert.ok(decoded, 'packet decoded');
  return decoded;
}

test('compiles a custom dialect including a base (minimal <- common <- custom)', () => {
  const compiled = compileXmlDialect(fixture('custom_vehicle.xml'));
  assert.strictEqual(compiled.name, 'custom_vehicle');
  const ids = Object.keys(compiled.module.REGISTRY).map(Number).sort((a, b) => a - b);
  // HEARTBEAT (0, from minimal), ATTITUDE (30, from common), custom (9100).
  assert.deepStrictEqual(ids, [0, 30, 9100]);
  assert.ok(compiled.magicNumbers[9100] > 0);
});

test('a standalone dialect compiles with only its own messages/enums', () => {
  const compiled = compileXmlDialect(fixture('custom_no_common.xml'));
  const names = Object.values(compiled.module.REGISTRY).map((c) => c.MSG_NAME);
  assert.deepStrictEqual(names, ['CUSTOM_STANDALONE']);
});

test('loadDialect compiles a custom .xml path into a valid bundle', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('custom_vehicle.xml') });
  assert.strictEqual(bundle.valid, true);
  assert.strictEqual(bundle.name, 'custom_vehicle');
  assert.ok(bundle.byName.HEARTBEAT);
  assert.ok(bundle.byName.CUSTOM_VEHICLE_STATUS);
  // Custom magic wins, base ids still present from the global table.
  assert.strictEqual(bundle.magicNumbers[9100], bundle.byName.CUSTOM_VEHICLE_STATUS.MAGIC_NUMBER);
});

test('a compiled custom message round-trips through the codec', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('custom_vehicle.xml') });
  const decoded = roundTrip(bundle, 'CUSTOM_VEHICLE_STATUS', { mode: 7 });
  assert.strictEqual(decoded.name, 'CUSTOM_VEHICLE_STATUS');
  assert.strictEqual(decoded.fields.mode, 7);
});

test('a base message from an included dialect round-trips', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('custom_vehicle.xml') });
  const decoded = roundTrip(bundle, 'HEARTBEAT', { type: 2, custom_mode: 12345 });
  assert.strictEqual(decoded.name, 'HEARTBEAT');
  assert.strictEqual(decoded.fields.type, 2);
  assert.strictEqual(decoded.fields.custom_mode, 12345);
});

test('enum-name strings resolve to numbers for a custom dialect', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('custom_enum.xml') });
  // Full name, unprefixed member, and raw number should all encode/decode.
  assert.strictEqual(roundTrip(bundle, 'CUSTOM_LAMP', { color: 'CUSTOM_COLOR_WHITE', brightness: 5 }).fields.color, 7);
  assert.strictEqual(roundTrip(bundle, 'CUSTOM_LAMP', { color: 'GREEN', brightness: 1 }).fields.color, 1);
  assert.strictEqual(roundTrip(bundle, 'CUSTOM_LAMP', { color: 7, brightness: 1 }).fields.color, 7);
});

test('a missing include yields an invalid bundle (loud failure, no throw)', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('missing_include.xml') });
  assert.strictEqual(bundle.valid, false);
  assert.strictEqual(bundle.error.code, 'DIALECT_INCLUDE_NOT_FOUND');
});

test('an include cycle yields an invalid bundle', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('cycle_a.xml') });
  assert.strictEqual(bundle.valid, false);
  assert.strictEqual(bundle.error.code, 'DIALECT_INCLUDE_CYCLE');
});

test('a nonexistent custom path yields an invalid bundle', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('does_not_exist.xml') });
  assert.strictEqual(bundle.valid, false);
  assert.strictEqual(bundle.error.code, 'DIALECT_XML_NOT_FOUND');
});

test('a bare custom basename still resolves to a bundled dialect', () => {
  const bundle = loadDialect('custom', { customDialectPath: 'common' });
  assert.strictEqual(bundle.valid, true);
  assert.strictEqual(bundle.name, 'common');
});

test('omitted string/array/64-bit fields zero-fill like generated classes', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('custom_hard_types.xml') });
  const decoded = roundTrip(bundle, 'HARD_TYPES', {});
  assert.strictEqual(decoded.fields.big, '0'); // 64-bit fields decode as decimal strings (§14.1)
  assert.strictEqual(decoded.fields.label, '');
  assert.deepStrictEqual(decoded.fields.arr, [0, 0, 0, 0]);
  assert.strictEqual(decoded.fields.small, 0);
});

test('a plain Number is coerced to BigInt for uint64 fields (custom and bundled)', () => {
  // Flow payloads come from JSON, which has no BigInt; a Number must not throw.
  // The decoded value comes back as the JSON-safe decimal string (§14.1).
  const custom = loadDialect('custom', { customDialectPath: fixture('custom_hard_types.xml') });
  const c = roundTrip(custom, 'HARD_TYPES', { big: 12345, label: 'hi', arr: [1, 2], small: 9 });
  assert.strictEqual(c.fields.big, '12345');
  assert.deepStrictEqual(c.fields.arr, [1, 2, 0, 0]); // short array pads

  const bundled = loadDialect('common');
  const b = roundTrip(bundled, 'SYSTEM_TIME', { time_unix_usec: 777, time_boot_ms: 1 });
  assert.strictEqual(b.fields.time_unix_usec, '777');
});

test('a numeric string for a uint64 field converts losslessly (no Number round-trip)', () => {
  // uint64 max is not representable as a JS Number: a lossy Number() conversion
  // would round it up to 2^64 and crash serialization out of range. It survives
  // the full round-trip and decodes back to the same decimal string (§14.1).
  const bundle = loadDialect('custom', { customDialectPath: fixture('custom_hard_types.xml') });
  const decoded = roundTrip(bundle, 'HARD_TYPES', { big: '18446744073709551615' });
  assert.strictEqual(decoded.fields.big, '18446744073709551615');
});

test('decoded 64-bit fields are JSON-safe decimal strings at min/max range (#92)', () => {
  const bundle = loadDialect('custom', { customDialectPath: fixture('custom_hard_types.xml') });

  // Unsigned 64-bit: 0 and uint64 max (2^64 - 1).
  const uMax = roundTrip(bundle, 'HARD_TYPES', { big: '18446744073709551615', sbig: 0 });
  assert.strictEqual(uMax.fields.big, '18446744073709551615');
  assert.strictEqual(typeof uMax.fields.big, 'string');

  // Signed 64-bit: int64 min (-2^63) and max (2^63 - 1) both preserved exactly.
  const sMin = roundTrip(bundle, 'HARD_TYPES', { big: 0, sbig: '-9223372036854775808' });
  assert.strictEqual(sMin.fields.sbig, '-9223372036854775808');
  const sMax = roundTrip(bundle, 'HARD_TYPES', { big: 0, sbig: '9223372036854775807' });
  assert.strictEqual(sMax.fields.sbig, '9223372036854775807');

  // The whole decoded payload must survive JSON.stringify without throwing, and
  // the 64-bit fields must round-trip through JSON unchanged.
  let json;
  assert.doesNotThrow(() => {
    json = JSON.stringify(uMax);
  });
  assert.strictEqual(JSON.parse(json).fields.big, '18446744073709551615');
});

test('messages in a second <messages> section are not dropped', () => {
  const compiled = compileXmlDialect(fixture('custom_hard_types.xml'));
  const names = Object.values(compiled.module.REGISTRY).map((cl) => cl.MSG_NAME).sort();
  assert.deepStrictEqual(names, ['HARD_TYPES', 'SECOND_SECTION']);
});
