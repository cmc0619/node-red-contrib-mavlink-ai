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

test('custom path that is not bundled fails loudly', () => {
  const b = loadDialect('custom', { customDialectPath: '/data/mine.xml' });
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
