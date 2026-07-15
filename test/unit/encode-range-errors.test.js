'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { enc } = require('../helpers/v3-config');

/**
 * Named encode errors for out-of-range integers and non-Latin-1 char fields
 * (#153 item 6).
 *
 * node-mavlink's serializer throws a bare Node RangeError ("The value of
 * \"value\" is out of range...") with no field name when an integer value
 * overflows its wire type or a char field carries a character above U+00FF, so a
 * flow author cannot tell which of a dozen fields is at fault. The codec now
 * catches that failure and re-throws a structured FIELD_OUT_OF_RANGE error
 * naming the field, its wire type, and the offending value — without changing
 * the success path.
 */

const codec = () => new MavlinkCodec({ bundle: loadDialect('common'), version: 'v2' });

test('an out-of-range integer names the field, type and value (#153)', () => {
  assert.throws(
    () => enc(codec(), 'COMMAND_LONG', { command: 400, target_system: 300, target_component: 1 }),
    (e) => {
      assert.strictEqual(e.code, 'FIELD_OUT_OF_RANGE');
      assert.strictEqual(e.context.field, 'target_system');
      assert.strictEqual(e.context.type, 'uint8_t');
      assert.match(e.message, /target_system/);
      assert.match(e.message, /\[0, 255\]/);
      assert.match(e.message, /300/);
      return true;
    }
  );
});

test('a 64-bit overflow names the field with the BigInt range (#153)', () => {
  assert.throws(
    () => enc(codec(), 'SYSTEM_TIME', { time_unix_usec: '18446744073709551616', time_boot_ms: 1 }),
    (e) => {
      assert.strictEqual(e.code, 'FIELD_OUT_OF_RANGE');
      assert.strictEqual(e.context.field, 'time_unix_usec');
      assert.match(e.message, /uint64_t/);
      return true;
    }
  );
});

test('a non-Latin-1 char field names the field and shows the character (#153)', () => {
  assert.throws(
    () => enc(codec(), 'STATUSTEXT', { severity: 6, text: 'hi \u{1F600}' }),
    (e) => {
      assert.strictEqual(e.code, 'FIELD_OUT_OF_RANGE');
      assert.strictEqual(e.context.field, 'text');
      assert.match(e.message, /non-Latin-1/);
      assert.match(e.message, /😀/u);
      return true;
    }
  );
});

test('an out-of-range element inside an array field is caught and named (#153)', () => {
  assert.throws(
    () => enc(codec(), 'GPS_STATUS', { satellites_visible: 1, satellite_prn: [1, 2, 300] }),
    (e) => {
      assert.strictEqual(e.code, 'FIELD_OUT_OF_RANGE');
      assert.strictEqual(e.context.field, 'satellite_prn');
      assert.match(e.message, /\[0, 255\]/);
      return true;
    }
  );
});

test('valid boundary and Latin-1 values still encode (no false positives) (#153)', () => {
  const c = codec();
  /** uint8 min/max at the boundary must pass. */
  assert.ok(Buffer.isBuffer(enc(c, 'COMMAND_LONG', { command: 400, target_system: 255, target_component: 0 })));
  /** A Latin-1 accented character (é = U+00E9 = 233) fits one byte and is fine. */
  assert.ok(Buffer.isBuffer(enc(c, 'STATUSTEXT', { severity: 6, text: 'héllo café' })));
  /** uint64 max (2^64 - 1) is in range and encodes. */
  assert.ok(Buffer.isBuffer(enc(c, 'SYSTEM_TIME', { time_unix_usec: '18446744073709551615', time_boot_ms: 1 })));
});
