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

test('char[] fields are never enum/number-resolved: digit and enum-name text survive (#137)', async () => {
  const b = loadDialect('ardupilotmega');
  const codec = new MavlinkCodec({ bundle: b, version: 'v2', sysid: 1, compid: 1 });

  // All-digit text would become the Number 123 and serialize to zero bytes.
  const digits = await roundTrip(codec, 'STATUSTEXT', { severity: 6, text: '123' });
  assert.strictEqual(digits.fields.text, '123');

  // "GENERIC" collides with MAV_TYPE_GENERIC / other enum members.
  const collide = await roundTrip(codec, 'STATUSTEXT', { severity: 6, text: 'GENERIC' });
  assert.strictEqual(collide.fields.text, 'GENERIC');

  // A numeric param_id must address that literal parameter, not param index 42.
  const param = await roundTrip(codec, 'PARAM_SET', {
    target_system: 1,
    target_component: 1,
    param_id: '42',
    param_value: 1,
    param_type: 2
  });
  assert.strictEqual(param.fields.param_id, '42');

  // A normal param name still round-trips unchanged.
  const named = await roundTrip(codec, 'PARAM_SET', {
    target_system: 1,
    target_component: 1,
    param_id: 'ARMING_CHECK',
    param_value: 1,
    param_type: 2
  });
  assert.strictEqual(named.fields.param_id, 'ARMING_CHECK');
});
