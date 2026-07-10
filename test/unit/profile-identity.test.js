'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { loadDialect } = require('../../lib/dialects/dialect-loader');

/**
 * Profile identity validation (#90): MAVLink identity fields are wire uint8s.
 * Out-of-range / non-integer values must mark the profile invalid at runtime
 * (imported/API flows bypass the editor), never be silently truncated,
 * wrapped, or replaced with a default.
 */

function makeProfile(overrides) {
  const RED = new MockRED().loadNodes();
  return RED.create(
    'mavlink-ai-profile',
    Object.assign(
      {
        id: 'p1',
        name: 'P',
        dialect: 'ardupilotmega',
        mavlinkVersion: 'auto'
      },
      overrides
    )
  );
}

test('valid boundary identity values are accepted (#90)', () => {
  const profile = makeProfile({
    sourceSystemId: 1,
    sourceComponentId: 0,
    defaultTargetSystem: 0,
    defaultTargetComponent: 255,
    signingLinkId: 255
  });
  assert.strictEqual(profile.isValid(), true);
  assert.strictEqual(profile.sourceSystemId, 1);
  assert.strictEqual(profile.sourceComponentId, 0);
  assert.strictEqual(profile.defaultTargetSystem, 0);
  assert.strictEqual(profile.defaultTargetComponent, 255);
  assert.strictEqual(profile.signingLinkId, 255);
});

test('blank identity values take the documented defaults (#90)', () => {
  const profile = makeProfile({});
  assert.strictEqual(profile.isValid(), true);
  assert.strictEqual(profile.sourceSystemId, 255);
  assert.strictEqual(profile.sourceComponentId, 190);
  assert.strictEqual(profile.defaultTargetSystem, 1);
  assert.strictEqual(profile.defaultTargetComponent, 1);
});

test('out-of-range and non-integer identity values invalidate the profile (#90)', () => {
  const bad = [
    { sourceSystemId: 0 }, // 0 = unknown/broadcast, not a valid sender id
    { sourceSystemId: 256 },
    { sourceSystemId: -1 },
    { sourceSystemId: 12.5 },
    { sourceSystemId: 'abc' },
    { sourceComponentId: 300 },
    { defaultTargetSystem: 999 },
    { defaultTargetComponent: -2 },
    { signingLinkId: 256 },
    { signingLinkId: 1.5 }
  ];
  for (const overrides of bad) {
    const profile = makeProfile(overrides);
    assert.strictEqual(profile.isValid(), false, `${JSON.stringify(overrides)} should invalidate the profile`);
    const err = profile.getError();
    assert.strictEqual(err.code, 'IDENTITY_INVALID');
    assert.match(err.message, /must be an integer/);
  }
});

test('every invalid identity field is reported at once (#90)', () => {
  const profile = makeProfile({ sourceSystemId: 300, signingLinkId: -1 });
  assert.strictEqual(profile.isValid(), false);
  const err = profile.getError();
  assert.match(err.message, /Source system ID/);
  assert.match(err.message, /Signing link ID/);
});

test('codec rejects out-of-range source identity (#90)', () => {
  const bundle = loadDialect('common');
  assert.throws(() => new MavlinkCodec({ bundle, sysid: 0, compid: 1 }), (e) => e.code === 'IDENTITY_INVALID');
  assert.throws(() => new MavlinkCodec({ bundle, sysid: 256, compid: 1 }), (e) => e.code === 'IDENTITY_INVALID');
  assert.throws(() => new MavlinkCodec({ bundle, sysid: 1, compid: 1.5 }), (e) => e.code === 'IDENTITY_INVALID');
  const ok = new MavlinkCodec({ bundle, sysid: 255, compid: 0 });
  assert.strictEqual(ok.sysid, 255);
  assert.strictEqual(ok.compid, 0);
});

test('connection refuses to start on an identity-invalid profile (#90)', async () => {
  const RED = new MockRED().loadNodes();
  const profile = RED.create('mavlink-ai-profile', {
    id: 'p-bad',
    name: 'Bad',
    dialect: 'common',
    sourceSystemId: 4711
  });
  assert.strictEqual(profile.isValid(), false);
  const connection = RED.create('mavlink-ai-connection', {
    id: 'c1',
    name: 'C',
    profile: 'p-bad',
    transport: 'udp-peer',
    bindPort: 0
  });
  assert.ok(connection.errors.some((e) => /IDENTITY_INVALID/.test(String(e))), 'connection logged the identity error');
  await assert.rejects(connection.send({ name: 'HEARTBEAT', fields: {} }), (e) => e.code === 'CONNECTION_INVALID');
  await RED.close(connection);
});
