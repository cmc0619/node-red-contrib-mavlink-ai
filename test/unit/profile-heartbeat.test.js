'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { makeIdentity, enc } = require('../helpers/v3-config');
const { MavLinkPacketSplitter, MavLinkPacketParser } = require('node-mavlink');

/**
 * HEARTBEAT identity now lives on the Local Identity config node (#195, #228):
 * a GCS or companion advertises its own MAV_TYPE, never the target vehicle's.
 */

test('heartbeat fields advertise mavlink_version 3 (#66)', () => {
  const RED = new MockRED().loadNodes();
  const id = makeIdentity(RED, { role: 'gcs' });
  assert.strictEqual(id.getHeartbeatFields().mavlink_version, 3);
});

test('companion identity heartbeat identifies as onboard controller (#106, #195)', () => {
  const RED = new MockRED().loadNodes();
  const id = makeIdentity(RED, { role: 'companion' });
  const hb = id.getHeartbeatFields();
  assert.strictEqual(hb.type, 'MAV_TYPE_ONBOARD_CONTROLLER');
  // The onboard-controller identity must not imply an autopilot (#106).
  assert.strictEqual(hb.autopilot, 'MAV_AUTOPILOT_INVALID');
});

test('an explicit heartbeat type overrides the role default (#106)', () => {
  const RED = new MockRED().loadNodes();
  const id = makeIdentity(RED, { role: 'companion', heartbeatType: 'MAV_TYPE_GIMBAL' });
  assert.strictEqual(id.getHeartbeatFields().type, 'MAV_TYPE_GIMBAL');
});

test('companion HEARTBEAT encodes to MAV_TYPE_ONBOARD_CONTROLLER (18) (#106)', { timeout: 2000 }, (t, done) => {
  const RED = new MockRED().loadNodes();
  const bundle = loadDialect('ardupilotmega');
  const id = makeIdentity(RED, { role: 'companion' });
  const codec = new MavlinkCodec({ bundle, version: 'v2' });
  const buf = enc(codec, 'HEARTBEAT', id.getHeartbeatFields(), { sysid: 1, compid: 191 });

  const splitter = new MavLinkPacketSplitter({}, { magicNumbers: bundle.magicNumbers });
  const parser = new MavLinkPacketParser();
  splitter.pipe(parser);
  parser.on('data', (packet) => {
    const decoded = codec.decode(packet, {});
    assert.strictEqual(decoded.name, 'HEARTBEAT');
    // MAV_TYPE_ONBOARD_CONTROLLER === 18 in the common message set.
    assert.strictEqual(Number(decoded.fields.type), 18);
    done();
  });
  splitter.write(buf);
});

test('encoded HEARTBEAT round-trips mavlink_version = 3 (#66)', { timeout: 2000 }, (t, done) => {
  const RED = new MockRED().loadNodes();
  const bundle = loadDialect('ardupilotmega');
  const id = makeIdentity(RED, { role: 'gcs' });
  const codec = new MavlinkCodec({ bundle, version: 'v2' });
  const buf = enc(codec, 'HEARTBEAT', id.getHeartbeatFields(), { sysid: 1, compid: 1 });

  const splitter = new MavLinkPacketSplitter({}, { magicNumbers: bundle.magicNumbers });
  const parser = new MavLinkPacketParser();
  splitter.pipe(parser);
  parser.on('data', (packet) => {
    const decoded = codec.decode(packet, {});
    assert.strictEqual(decoded.name, 'HEARTBEAT');
    assert.strictEqual(Number(decoded.fields.mavlink_version), 3);
    done();
  });
  splitter.write(buf);
});
