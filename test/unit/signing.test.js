'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MavLinkPacketSignature } = require('node-mavlink');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { MockRED } = require('../helpers/mock-red');

const bundle = loadDialect('ardupilotmega');

const HEARTBEAT = {
  type: 'MAV_TYPE_GCS',
  autopilot: 'MAV_AUTOPILOT_INVALID',
  base_mode: 0,
  custom_mode: 0,
  system_status: 'MAV_STATE_ACTIVE'
};

/**
 * Decode a single wire buffer through a codec's streaming decoder and resolve
 * with the parsed packet (which carries `.signature` for signed frames).
 */
function decodeOne(codec, buffer) {
  return new Promise((resolve, reject) => {
    const decoder = codec.createDecoder(
      (packet) => {
        decoder.destroy();
        resolve(packet);
      },
      (err) => {
        decoder.destroy();
        reject(err);
      }
    );
    decoder.write(buffer);
    setTimeout(() => reject(new Error('no packet decoded')), 100).unref();
  });
}

test('signing off: encode produces an unsigned frame (unchanged behavior) (#15)', async () => {
  const codec = new MavlinkCodec({ bundle, version: 'v2', sysid: 1, compid: 1 });
  assert.strictEqual(codec.signsOutbound(), false);
  const buf = codec.encode('HEARTBEAT', HEARTBEAT);
  const packet = await decodeOne(codec, buf);
  assert.strictEqual(packet.signature, null); // no signature block
});

test('sign outbound: encode appends a valid signature block (#15)', async () => {
  const codec = new MavlinkCodec({
    bundle,
    version: 'v2',
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'swarmsecret', linkId: 7, signOutbound: true }
  });
  assert.strictEqual(codec.signsOutbound(), true);
  const buf = codec.encode('HEARTBEAT', HEARTBEAT);
  const packet = await decodeOne(codec, buf);
  assert.ok(packet.signature, 'frame carries a signature');
  assert.strictEqual(packet.signature.linkId, 7);
  const key = MavLinkPacketSignature.key('swarmsecret');
  assert.strictEqual(packet.signature.matches(key), true);
  assert.strictEqual(packet.signature.matches(MavLinkPacketSignature.key('wrong')), false);
});

test('signing forces MAVLink 2 even when the version is v1 (#15)', async () => {
  // Signed frames are v2-only; a v1 profile setting must not drop signing.
  const codec = new MavlinkCodec({
    bundle,
    version: 'v1',
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'k', linkId: 0, signOutbound: true }
  });
  const buf = codec.encode('HEARTBEAT', HEARTBEAT);
  assert.strictEqual(buf[0], 0xfd); // v2 magic, not 0xfe
  const packet = await decodeOne(codec, buf);
  assert.ok(packet.signature);
});

test('verify disabled: verifyInboundPacket returns null (pass-through) (#15)', () => {
  const codec = new MavlinkCodec({ bundle, sysid: 1, compid: 1, signing: { passphrase: 'k', signOutbound: true } });
  assert.strictEqual(codec.verifyInboundPacket({ signature: null }), null);
});

test('verify inbound decision matrix (#15)', async () => {
  const signer = new MavlinkCodec({
    bundle,
    sysid: 2,
    compid: 1,
    signing: { passphrase: 'linkkey', linkId: 3, signOutbound: true }
  });
  const signedBuf = signer.encode('HEARTBEAT', HEARTBEAT);
  const unsignedBuf = new MavlinkCodec({ bundle, version: 'v2', sysid: 2, compid: 1 }).encode('HEARTBEAT', HEARTBEAT);

  const verifier = new MavlinkCodec({
    bundle,
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'linkkey', verifyInbound: true, requireSignature: false }
  });
  const requirer = new MavlinkCodec({
    bundle,
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'linkkey', verifyInbound: true, requireSignature: true }
  });
  const wrongKey = new MavlinkCodec({
    bundle,
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'different', verifyInbound: true }
  });

  const signedPkt = await decodeOne(verifier, signedBuf);
  const unsignedPkt = await decodeOne(verifier, unsignedBuf);

  // Good signature + right key -> accepted.
  assert.deepStrictEqual(verifier.verifyInboundPacket(signedPkt), {
    accepted: true,
    reason: 'signature-valid',
    signed: true
  });
  // Unsigned, not required -> accepted.
  assert.deepStrictEqual(verifier.verifyInboundPacket(unsignedPkt), {
    accepted: true,
    reason: 'unsigned-allowed',
    signed: false
  });
  // Unsigned, required -> rejected.
  assert.deepStrictEqual(requirer.verifyInboundPacket(unsignedPkt), {
    accepted: false,
    reason: 'signature-required',
    signed: false
  });
  // Signed but the verifier holds the wrong key -> rejected.
  assert.strictEqual(wrongKey.verifyInboundPacket(signedPkt).accepted, false);
  assert.strictEqual(wrongKey.verifyInboundPacket(signedPkt).reason, 'signature-invalid');
});

test('verify requested with no passphrase fails closed on signed frames (#15)', async () => {
  const signer = new MavlinkCodec({
    bundle,
    sysid: 2,
    compid: 1,
    signing: { passphrase: 'linkkey', signOutbound: true }
  });
  const signedPkt = await decodeOne(signer, signer.encode('HEARTBEAT', HEARTBEAT));
  // verifyInbound + requireSignature but no passphrase configured.
  const keyless = new MavlinkCodec({
    bundle,
    sysid: 1,
    compid: 1,
    signing: { verifyInbound: true, requireSignature: true }
  });
  const decision = keyless.verifyInboundPacket(signedPkt);
  assert.strictEqual(decision.accepted, false);
  assert.strictEqual(decision.reason, 'signature-no-key');
});

test('empty signing config is treated as no signing (#15)', () => {
  const codec = new MavlinkCodec({ bundle, sysid: 1, compid: 1, signing: {} });
  assert.strictEqual(codec.signing, null);
  assert.strictEqual(codec.signsOutbound(), false);
  assert.strictEqual(codec.verifyInboundPacket({ signature: null }), null);
});

test('linkId is clamped into a byte (#15)', () => {
  const codec = new MavlinkCodec({
    bundle,
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'k', linkId: 259, signOutbound: true }
  });
  assert.strictEqual(codec.signing.linkId, 3); // 259 % 256
});

// --- profile threading (#15) -------------------------------------------------

function makeProfile(config) {
  const RED = new MockRED().loadNodes();
  return RED.create(
    'mavlink-ai-profile',
    Object.assign(
      {
        id: 'p1',
        name: 'P',
        dialect: 'ardupilotmega',
        mavlinkVersion: 'auto',
        sourceSystemId: 255,
        sourceComponentId: 190
      },
      config
    )
  );
}

test('profile exposes null signing when nothing is configured (#15)', () => {
  const profile = makeProfile({});
  assert.strictEqual(profile.getSigningOptions(), null);
  assert.strictEqual(profile.getProtocolOptions().signing, null);
});

test('profile reads the passphrase from credentials, not plain config (#15)', () => {
  const profile = makeProfile({
    signOutbound: true,
    verifyInbound: true,
    requireSignature: true,
    signingLinkId: 5,
    credentials: { signingPassphrase: 'secret' }
  });
  const signing = profile.getSigningOptions();
  assert.strictEqual(signing.passphrase, 'secret');
  assert.strictEqual(signing.linkId, 5);
  assert.strictEqual(signing.signOutbound, true);
  assert.strictEqual(signing.verifyInbound, true);
  assert.strictEqual(signing.requireSignature, true);
  // A codec built from these options actually signs.
  const codec = new MavlinkCodec(Object.assign({ bundle }, profile.getProtocolOptions()));
  assert.strictEqual(codec.signsOutbound(), true);
});

test('profile with only verify flags (no passphrase) still returns signing (#15)', () => {
  // So inbound verification can fail closed rather than silently pass.
  const profile = makeProfile({ verifyInbound: true, requireSignature: true });
  const signing = profile.getSigningOptions();
  assert.ok(signing);
  assert.strictEqual(signing.passphrase, '');
  assert.strictEqual(signing.verifyInbound, true);
});
