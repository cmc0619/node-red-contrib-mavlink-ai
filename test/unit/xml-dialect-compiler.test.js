'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { compileXmlDialect } = require('../../lib/dialects/xml-dialect-compiler');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

const DIR = path.join(__dirname, '..', 'fixtures', 'dialects');
const fixture = (name) => path.join(DIR, name);

/** Encode then decode a message through a codec, returning the decoded payload. */
function roundTrip(bundle, name, fields) {
  const codec = new MavlinkCodec({ bundle, version: 'v2', sysid: 42, compid: 1 });
  const buf = codec.encode(name, fields, {});
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
