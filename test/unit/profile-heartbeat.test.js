'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { MavLinkPacketSplitter, MavLinkPacketParser } = require('node-mavlink');

function makeProfile(config = {}) {
  const RED = new MockRED().loadNodes();
  return RED.create(
    'mavlink-ai-profile',
    Object.assign({ id: 'p1', name: 'P', dialect: 'ardupilotmega', profileType: 'gcs' }, config)
  );
}

test('heartbeat fields advertise mavlink_version 3 (#66)', () => {
  const profile = makeProfile();
  assert.strictEqual(profile.getHeartbeatFields().mavlink_version, 3);
});

test('encoded HEARTBEAT round-trips mavlink_version = 3 (#66)', { timeout: 2000 }, (t, done) => {
  const bundle = loadDialect('ardupilotmega');
  const profile = makeProfile();
  const codec = new MavlinkCodec({ bundle, version: 'v2', sysid: 1, compid: 1 });
  const buf = codec.encode('HEARTBEAT', profile.getHeartbeatFields());

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
