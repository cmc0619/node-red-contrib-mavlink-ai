'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect, getMessageClass } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

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
  const codec = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 1, compid: 1 });
  const buf = codec.encode('HEARTBEAT', {
    type: 'MAV_TYPE_QUADROTOR',
    autopilot: 'MAV_AUTOPILOT_ARDUPILOTMEGA',
    base_mode: 81,
    custom_mode: 0,
    system_status: 'MAV_STATE_ACTIVE'
  });

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
  const codec = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 255, compid: 190 });
  const buf = codec.encode(
    'COMMAND_LONG',
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 1 },
    { targetSystem: 1, targetComponent: 1 }
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
  assert.throws(() => codec.encode('NOPE_MESSAGE', {}), /UNKNOWN_MESSAGE|not defined/);
});

test('auto version follows the detected inbound wire version (#19)', () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b, version: 'auto', sysid: 255, compid: 190 });
  const hb = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };

  // Before any inbound traffic: v2 framing (0xFD magic).
  assert.strictEqual(codec.effectiveVersion(), 'v2');
  assert.strictEqual(codec.encode('HEARTBEAT', hb)[0], 0xfd);

  // A v1 peer appears: outbound switches to v1 framing (0xFE magic).
  codec.noteInboundMagic(0xfe);
  assert.strictEqual(codec.effectiveVersion(), 'v1');
  assert.strictEqual(codec.encode('HEARTBEAT', hb)[0], 0xfe);

  // The peer upgrades to v2: outbound follows.
  codec.noteInboundMagic(0xfd);
  assert.strictEqual(codec.effectiveVersion(), 'v2');
  assert.strictEqual(codec.encode('HEARTBEAT', hb)[0], 0xfd);

  // Unknown magic bytes are ignored.
  codec.noteInboundMagic(0x00);
  assert.strictEqual(codec.effectiveVersion(), 'v2');
});

test('auto tracks wire version per peer sysid (#69)', () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b, version: 'auto', sysid: 255, compid: 190 });
  const hb = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };

  // Vehicle 1 speaks v1, vehicle 2 speaks v2 on the same connection.
  codec.noteInboundMagic(0xfe, 1);
  codec.noteInboundMagic(0xfd, 2);

  // Each peer's outbound framing follows its own observed version, regardless
  // of who spoke last.
  assert.strictEqual(codec.effectiveVersion(1), 'v1');
  assert.strictEqual(codec.effectiveVersion(2), 'v2');
  assert.strictEqual(codec.encode('HEARTBEAT', hb, { targetSystem: 1 })[0], 0xfe);
  assert.strictEqual(codec.encode('HEARTBEAT', hb, { targetSystem: 2 })[0], 0xfd);

  // An unknown/untargeted peer falls back to the most recent inbound version.
  assert.strictEqual(codec.effectiveVersion(99), 'v2');
  assert.strictEqual(codec.effectiveVersion(), 'v2');
});

test('auto keeps v2 framing for message ids above 255 even with a v1 peer (#19)', () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b, version: 'auto', sysid: 255, compid: 190 });
  codec.noteInboundMagic(0xfe); // v1 peer
  // BUTTON_CHANGE has msgid 257 — v1 framing cannot express it.
  const buf = codec.encode('BUTTON_CHANGE', { time_boot_ms: 1, last_change_ms: 1, state: 1 });
  assert.strictEqual(buf[0], 0xfd);
});

test('explicit v1/v2 settings ignore inbound magic (#19)', () => {
  const b = loadDialect('ardupilotmega');
  const hb = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };
  const v2 = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 255, compid: 190 });
  v2.noteInboundMagic(0xfe);
  assert.strictEqual(v2.encode('HEARTBEAT', hb)[0], 0xfd);
  const v1 = new MavlinkCodec({ bundle: b, version: 'v1', sysid: 255, compid: 190 });
  v1.noteInboundMagic(0xfd);
  assert.strictEqual(v1.encode('HEARTBEAT', hb)[0], 0xfe);
});

test('encode rejects unresolvable enum-name strings with the field named (#36)', () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 255, compid: 190 });
  assert.throws(
    () => codec.encode('COMMAND_LONG', { command: 'MAV_CMD_ARM_DISRAM', target_system: 1, target_component: 1 }),
    (e) => {
      assert.strictEqual(e.code, 'UNRESOLVED_FIELD_VALUE');
      assert.match(e.message, /command/);
      assert.match(e.message, /MAV_CMD_ARM_DISRAM/);
      return true;
    }
  );
  // Valid enum names, numeric strings, and char[] fields keep working.
  const ok = codec.encode('COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 1, target_component: 1 });
  assert.ok(Buffer.isBuffer(ok));
  const statustext = codec.encode('STATUSTEXT', { severity: 6, text: 'hello' });
  assert.ok(Buffer.isBuffer(statustext));
});

test('encode accepts a decimal string on a float field but rejects it on an integer field (#153)', async () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 255, compid: 190 });
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
    () => codec.encode('COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: '1.5', target_component: 1 }),
    (e) => e.code === 'UNRESOLVED_FIELD_VALUE'
  );
  /** "NaN"/"Infinity" strings are not finite values and stay rejected on floats. */
  assert.throws(
    () => codec.encode('COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 1, target_component: 1, param1: 'NaN' }),
    (e) => e.code === 'UNRESOLVED_FIELD_VALUE'
  );
  /** A blank/whitespace string must fail, not silently become 0 (a missing value). */
  for (const blank of ['', '   ']) {
    assert.throws(
      () => codec.encode('COMMAND_LONG', { command: 'MAV_CMD_COMPONENT_ARM_DISARM', target_system: 1, target_component: 1, param1: blank }),
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
  const buf = codec.encode(name, fields);
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
  const codec = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 1, compid: 1 });

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

/** A HEARTBEAT with numeric fields, for version-detection round-trips. */
const HB_FIELDS = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };

test('v1 encode strips MAVLink-2 extension fields (#138)', async () => {
  const b = loadDialect('common');
  const codec = new MavlinkCodec({ bundle: b, version: 'v1', sysid: 1, compid: 1 });
  /**
   * COMMAND_ACK core is 3 bytes (command:2 + result:1); progress, result_param2,
   * target_system, target_component are MAVLink-2 extensions the v1 wire omits.
   */
  const buf = codec.encode('COMMAND_ACK', { command: 400, result: 0 });
  assert.strictEqual(buf[0], 0xfe);
  assert.strictEqual(buf[1], 3, 'v1 payload length must exclude extension fields');
  /** The truncated frame still carries a valid CRC and decodes its base fields. */
  const decoded = await roundTrip(codec, 'COMMAND_ACK', { command: 400, result: 0 });
  assert.strictEqual(decoded.fields.command, 400);
  assert.strictEqual(decoded.fields.result, 0);
});

test('raw.magic reflects the real wire version, including v1 (#138)', async () => {
  const b = loadDialect('common');
  const v1 = new MavlinkCodec({ bundle: b, version: 'v1', sysid: 1, compid: 1 });
  const v2 = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 1, compid: 1 });
  assert.strictEqual((await roundTrip(v1, 'HEARTBEAT', HB_FIELDS)).raw.magic, 0xfe);
  assert.strictEqual((await roundTrip(v2, 'HEARTBEAT', HB_FIELDS)).raw.magic, 0xfd);
});

test('auto version detects v1 from a real parsed frame, not header.magic (#138, #152)', async () => {
  const b = loadDialect('common');
  const peer = new MavlinkCodec({ bundle: b, version: 'v1', sysid: 3, compid: 1 });
  const v1frame = peer.encode('HEARTBEAT', HB_FIELDS);
  const auto = new MavlinkCodec({ bundle: b, version: 'auto', sysid: 255, compid: 190 });
  assert.strictEqual(auto.effectiveVersion(3), 'v2', 'v2 until an inbound frame is seen');

  /** Parse the real frame the way the connection does, then feed the wire byte. */
  const packet = await new Promise((resolve) => {
    const dec = auto.createDecoder((p) => resolve(p));
    dec.write(v1frame);
  });
  assert.strictEqual(packet.header.magic, 0, 'node-mavlink v1 parser leaves header.magic 0 — the bug this guards');
  auto.noteInboundMagic(packet.buffer[0], packet.header.sysid);

  assert.strictEqual(auto.effectiveVersion(3), 'v1');
  assert.strictEqual(auto.encode('HEARTBEAT', HB_FIELDS, { targetSystem: 3 })[0], 0xfe);
});
