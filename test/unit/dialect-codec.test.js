'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect, getMessageClass } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { LinkState } = require('../../lib/protocol/link-state');
const { enc } = require('../helpers/v3-config');

/**
 * The codec is dialect-scoped only in v3 (#192, #228): source identity and
 * per-link sequence/signing state live outside it. encode() takes the
 * sender ids + a LinkState explicitly; every outbound frame is MAVLink 2.
 * `enc()` (test helper) supplies a fresh LinkState and default 255/190 unless a
 * test threads its own.
 */

test('ardupilotmega loads with merged registry', () => {
  const b = loadDialect('ardupilotmega');
  assert.ok(b.valid);
  assert.ok(getMessageClass(b, 'HEARTBEAT'));
  assert.ok(getMessageClass(b, 'COMMAND_LONG'));
  assert.ok(getMessageClass(b, 0)); // by id
});

test('unknown dialect fails loudly (no silent fallback)', () => {
  const b = loadDialect('definitely-not-a-dialect');
  assert.strictEqual(b.valid, false);
  assert.strictEqual(b.error.code, 'DIALECT_LOAD_FAILED');
});

test('a nonexistent custom XML path fails loudly', () => {
  // Custom XML is now compiled at runtime (#2); a missing file still fails
  // loudly rather than falling back to a bundled dialect.
  const b = loadDialect('custom', { customDialectPath: '/data/mine.xml' });
  assert.strictEqual(b.valid, false);
  assert.strictEqual(b.error.code, 'DIALECT_XML_NOT_FOUND');
});

test('a custom value that is neither a bundled name nor an .xml path fails loudly', () => {
  const b = loadDialect('custom', { customDialectPath: 'not-a-dialect' });
  assert.strictEqual(b.valid, false);
  assert.strictEqual(b.error.code, 'DIALECT_LOAD_FAILED');
});

test('codec round-trips a HEARTBEAT', async () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b });
  const buf = enc(codec, 'HEARTBEAT', {
    type: 'MAV_TYPE_QUADROTOR',
    autopilot: 'MAV_AUTOPILOT_ARDUPILOTMEGA',
    base_mode: 81,
    custom_mode: 0,
    system_status: 'MAV_STATE_ACTIVE'
  }, { sysid: 1, compid: 1 });

  const decoded = await new Promise((resolve) => {
    const dec = codec.createDecoder((packet) => resolve(codec.decode(packet, { profile: 'Copter' })));
    dec.write(buf);
  });

  assert.strictEqual(decoded.name, 'HEARTBEAT');
  assert.strictEqual(decoded.sysid, 1);
  assert.strictEqual(decoded.profile, 'Copter');
  assert.strictEqual(decoded.fields.type, 2); // MAV_TYPE_QUADROTOR
  assert.strictEqual(decoded.fields.base_mode, 81);
});

test('codec encodes COMMAND_LONG with enum + target defaults', async () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b });
  const buf = enc(
    codec,
    'COMMAND_LONG',
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 1 },
    { sysid: 255, compid: 190, targetSystem: 1, targetComponent: 1 }
  );
  const decoded = await new Promise((resolve) => {
    const dec = codec.createDecoder((packet) => resolve(codec.decode(packet)));
    dec.write(buf);
  });
  assert.strictEqual(decoded.name, 'COMMAND_LONG');
  assert.strictEqual(decoded.fields.command, 400);
  assert.strictEqual(decoded.fields.target_system, 1);
  assert.strictEqual(decoded.fields.param1, 1);
});

test('encode throws UNKNOWN_MESSAGE for bad name', () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  assert.throws(() => enc(codec, 'NOPE_MESSAGE', {}), /UNKNOWN_MESSAGE|not defined/);
});

test('encode requires a LinkState (channel state is connection-owned) (#192)', () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  assert.throws(
    () => codec.encode('HEARTBEAT', { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 }, { sysid: 1, compid: 1 }),
    (e) => e.code === 'LINK_STATE_REQUIRED'
  );
});

test('encode rejects an out-of-range source identity (#90)', () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  const link = new LinkState();
  const hb = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };
  // Source sysid 0 = unknown/broadcast, not a valid sender.
  assert.throws(() => codec.encode('HEARTBEAT', hb, { sysid: 0, compid: 1, link }), (e) => e.code === 'IDENTITY_INVALID');
  assert.throws(() => codec.encode('HEARTBEAT', hb, { sysid: 256, compid: 1, link }), (e) => e.code === 'IDENTITY_INVALID');
  assert.throws(() => codec.encode('HEARTBEAT', hb, { sysid: 1, compid: 1.5, link }), (e) => e.code === 'IDENTITY_INVALID');
  /** Source compid 0 is MAV_COMP_ID_ALL (broadcast), never a sender id (#153). */
  assert.throws(() => codec.encode('HEARTBEAT', hb, { sysid: 1, compid: 0, link }), (e) => e.code === 'IDENTITY_INVALID');
  // Valid boundary values still encode.
  assert.ok(Buffer.isBuffer(codec.encode('HEARTBEAT', hb, { sysid: 255, compid: 1, link })));
});

test('encode rejects unresolvable enum-name strings with the field named (#36)', () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b });
  assert.throws(
    () => enc(codec, 'COMMAND_LONG', { command: 'MAV_CMD_ARM_DISRAM', target_system: 1, target_component: 1 }),
    (e) => {
      assert.strictEqual(e.code, 'UNRESOLVED_FIELD_VALUE');
      assert.match(e.message, /command/);
      assert.match(e.message, /MAV_CMD_ARM_DISRAM/);
      return true;
    }
  );
  // Valid enum names, numeric strings, and char[] fields keep working.
  const ok = enc(codec, 'COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 1, target_component: 1 });
  assert.ok(Buffer.isBuffer(ok));
  const statustext = enc(codec, 'STATUSTEXT', { severity: 6, text: 'hello' });
  assert.ok(Buffer.isBuffer(statustext));
});

test('encode accepts a decimal string on a float field but rejects it on an integer field (#153)', async () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b });
  /** param1 is a float field: "1.5" (as from an MQTT/CSV source) must encode as 1.5. */
  const decoded = await roundTrip(codec, 'COMMAND_LONG', {
    command: 'MAV_CMD_COMPONENT_ARM_DISARM',
    target_system: 1,
    target_component: 1,
    param1: '1.5'
  });
  assert.strictEqual(decoded.fields.param1, 1.5);
  /** target_system is an integer field: a fractional string is still a typo. */
  assert.throws(
    () => enc(codec, 'COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: '1.5', target_component: 1 }),
    (e) => e.code === 'UNRESOLVED_FIELD_VALUE'
  );
  /**
   * "NaN"/"Infinity"/"-Infinity" are the reversible sentinels for the non-finite
   * float values MAVLink uses (NaN = "ignore this field") — accepted on a float
   * field so a decoded sentinel round-trips (#153).
   */
  assert.strictEqual((await roundTrip(codec, 'COMMAND_LONG', {
    command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 1, target_component: 1, param1: 'NaN'
  })).fields.param1, 'NaN');
  /** A genuine typo on a float field (not a sentinel) still fails loudly. */
  assert.throws(
    () => enc(codec, 'COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 1, target_component: 1, param1: 'NAM' }),
    (e) => e.code === 'UNRESOLVED_FIELD_VALUE'
  );
  /** On an integer field the sentinel is meaningless and stays a typo. */
  assert.throws(
    () => enc(codec, 'COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 'NaN', target_component: 1 }),
    (e) => e.code === 'UNRESOLVED_FIELD_VALUE'
  );
  /** A blank/whitespace string must fail, not silently become 0 (a missing value). */
  for (const blank of ['', '   ']) {
    assert.throws(
      () => enc(codec, 'COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 1, target_component: 1, param1: blank }),
      (e) => e.code === 'UNRESOLVED_FIELD_VALUE'
    );
  }
});

/**
 * Round-trip a message through encode + the streaming decoder.
 *
 * @param {MavlinkCodec} codec
 * @param {string} name
 * @param {object} fields
 * @returns {Promise<object>} decoded normalized message
 */
function roundTrip(codec, name, fields) {
  const buf = enc(codec, name, fields);
  return new Promise((resolve) => {
    const dec = codec.createDecoder((packet) => resolve(codec.decode(packet, { profile: 'x' })));
    dec.write(buf);
  });
}

/**
 * Each char-field case would corrupt before the #137 fix: "123" becomes the
 * Number 123 and serializes to zero bytes; "GENERIC" collides with enum member
 * names; a numeric param_id must address that literal parameter, not param
 * index 42. A normal param name (ARMING_CHECK) must still round-trip unchanged.
 */
test('char[] fields are never enum/number-resolved: digit and enum-name text survive (#137)', async () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b });

  const digits = await roundTrip(codec, 'STATUSTEXT', { severity: 6, text: '123' });
  assert.strictEqual(digits.fields.text, '123');

  const collide = await roundTrip(codec, 'STATUSTEXT', { severity: 6, text: 'GENERIC' });
  assert.strictEqual(collide.fields.text, 'GENERIC');

  const param = await roundTrip(codec, 'PARAM_SET', {
    target_system: 1,
    target_component: 1,
    param_id: '42',
    param_value: 1,
    param_type: 2
  });
  assert.strictEqual(param.fields.param_id, '42');

  const named = await roundTrip(codec, 'PARAM_SET', {
    target_system: 1,
    target_component: 1,
    param_id: 'ARMING_CHECK',
    param_value: 1,
    param_type: 2
  });
  assert.strictEqual(named.fields.param_id, 'ARMING_CHECK');
});

/** A HEARTBEAT with numeric fields, for wire round-trips. */
const HB_FIELDS = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };

test('raw.magic reflects the v2 wire version (#138)', async () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  assert.strictEqual((await roundTrip(codec, 'HEARTBEAT', HB_FIELDS)).raw.magic, 0xfd);
});

test('addressesTarget distinguishes addressed messages from broadcasts (#148)', () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  assert.strictEqual(codec.addressesTarget('COMMAND_LONG'), true);
  assert.strictEqual(codec.addressesTarget('MISSION_REQUEST_LIST'), true);
  assert.strictEqual(codec.addressesTarget('HEARTBEAT'), false);
  assert.strictEqual(codec.addressesTarget('ATTITUDE'), false);
  assert.strictEqual(codec.addressesTarget('NOT_A_REAL_MESSAGE'), false);
});

test('all-zero v2 payload keeps the spec minimum of one payload byte', async () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  /**
   * Broadcast PARAM_REQUEST_LIST serializes all-zero; node-mavlink trims that
   * to a zero-length payload, but the MAVLink 2 reference trim never goes
   * below one byte and spec-strict peers can reject length 0.
   */
  const buf = enc(codec, 'PARAM_REQUEST_LIST', { target_system: 0, target_component: 0 });
  assert.strictEqual(buf[0], 0xfd);
  assert.strictEqual(buf[1], 1, 'payload length byte');
  assert.strictEqual(buf.length, 10 + 1 + 2);
  /** the re-framed CRC is valid: the frame still decodes */
  const decoded = await new Promise((resolve) => {
    const dec = codec.createDecoder((packet) => resolve(codec.decode(packet)));
    dec.write(buf);
  });
  assert.strictEqual(decoded.name, 'PARAM_REQUEST_LIST');
});

test('outbound HEARTBEAT stamps mavlink_version 3 unless the caller sets it', async () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  const decode = (buf) =>
    new Promise((resolve) => {
      const dec = codec.createDecoder((packet) => resolve(codec.decode(packet)));
      dec.write(buf);
    });
  const stamped = await decode(enc(codec, 'HEARTBEAT', { type: 2, autopilot: 3, system_status: 4 }));
  assert.strictEqual(stamped.fields.mavlink_version, 3);
  const explicit = await decode(
    enc(codec, 'HEARTBEAT', { type: 2, autopilot: 3, system_status: 4, mavlink_version: 2 })
  );
  assert.strictEqual(explicit.fields.mavlink_version, 2);
});

test('exactFloatBits writes the exact wire pattern and decode exposes param_value_bits (#146)', async () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b });
  /** INT32 -1 byte-union: float bits 0xFFFFFFFF — a NaN pattern JS canonicalizes */
  const buf = enc(
    codec,
    'PARAM_SET',
    { target_system: 1, target_component: 1, param_id: 'COM_TEST', param_value: NaN, param_type: 6 },
    { exactFloatBits: { param_value: 0xffffffff } }
  );
  const decoded = await new Promise((resolve) => {
    const dec = codec.createDecoder((packet) => resolve(codec.decode(packet)));
    dec.write(buf);
  });
  assert.strictEqual(decoded.name, 'PARAM_SET');
  assert.strictEqual(decoded.fields.param_value_bits, 0xffffffff);
  assert.strictEqual(decoded.fields.param_value, 'NaN');
});
