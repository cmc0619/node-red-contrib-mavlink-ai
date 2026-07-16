'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MavLinkPacketSignature } = require('node-mavlink');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec, verifyInboundPacket } = require('../../lib/protocol/mavlink-codec');
const { LinkState } = require('../../lib/protocol/link-state');
const { MockRED } = require('../helpers/mock-red');
const { makeIdentity, makeConnection } = require('../helpers/v3-config');

/**
 * MAVLink 2 signing in v3 (#15, #192, #228). Signing state is split by owner:
 *
 *  - the Local Identity owns the credential + sign/verify/require policy
 *    (getSigningPolicy() returns the derived key and flags);
 *  - the Connection owns the signing link id and the LinkState (monotonic
 *    timestamps, per-key replay memory);
 *  - the codec is dialect-scoped and stateless — encode() takes the signing
 *    context per call, and verifyInboundPacket() is a pure (packet, policy)
 *    function.
 */

const bundle = loadDialect('ardupilotmega');

const HEARTBEAT = {
  type: 'MAV_TYPE_GCS',
  autopilot: 'MAV_AUTOPILOT_INVALID',
  base_mode: 0,
  custom_mode: 0,
  system_status: 'MAV_STATE_ACTIVE'
};

const codec = new MavlinkCodec({ bundle, version: 'v2' });

/** Sign a HEARTBEAT as (sysid/compid) with a passphrase + link id. */
function signHeartbeat({ sysid = 2, compid = 1, passphrase, linkId = 0, link = new LinkState() }) {
  return codec.encode('HEARTBEAT', HEARTBEAT, {
    sysid,
    compid,
    link,
    signing: { key: MavLinkPacketSignature.key(passphrase), linkId }
  });
}

/** Encode an unsigned HEARTBEAT. */
function unsignedHeartbeat({ sysid = 2, compid = 1 } = {}) {
  return codec.encode('HEARTBEAT', HEARTBEAT, { sysid, compid, link: new LinkState() });
}

/**
 * Decode a single wire buffer through a streaming decoder and resolve with the
 * parsed packet (which carries `.signature` for signed frames).
 */
function decodeOne(buffer) {
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

/** Build an inbound-verification policy from a passphrase + flags. */
function policy({ passphrase, verifyInbound = true, requireSignature = false, link = new LinkState() }) {
  const key = passphrase ? MavLinkPacketSignature.key(passphrase) : null;
  return {
    verifyInbound,
    requireSignature,
    key,
    replay: key ? link.replayTrackerFor(key) : null
  };
}

test('signing off: encode produces an unsigned frame (#15)', async () => {
  const packet = await decodeOne(unsignedHeartbeat());
  assert.strictEqual(packet.signature, null); // no signature block
});

test('sign outbound: encode appends a valid signature block (#15)', async () => {
  const buf = signHeartbeat({ sysid: 1, compid: 1, passphrase: 'swarmsecret', linkId: 7 });
  const packet = await decodeOne(buf);
  assert.ok(packet.signature, 'frame carries a signature');
  assert.strictEqual(packet.signature.linkId, 7);
  const key = MavLinkPacketSignature.key('swarmsecret');
  assert.strictEqual(packet.signature.matches(key), true);
  assert.strictEqual(packet.signature.matches(MavLinkPacketSignature.key('wrong')), false);
});

test('signing forces MAVLink 2 even when the version is v1 (#15)', async () => {
  // Signed frames are v2-only; a v1 profile setting must not drop signing.
  const v1 = new MavlinkCodec({ bundle, version: 'v1' });
  const buf = v1.encode('HEARTBEAT', HEARTBEAT, {
    sysid: 1,
    compid: 1,
    link: new LinkState(),
    signing: { key: MavLinkPacketSignature.key('k'), linkId: 0 }
  });
  assert.strictEqual(buf[0], 0xfd); // v2 magic, not 0xfe
  const packet = await decodeOne(buf);
  assert.ok(packet.signature);
});

test('verify disabled: verifyInboundPacket returns null (pass-through) (#15)', () => {
  assert.strictEqual(verifyInboundPacket({ signature: null }, null), null);
  assert.strictEqual(verifyInboundPacket({ signature: null }, { verifyInbound: false }), null);
});

test('verify inbound decision matrix (#15)', async () => {
  const signedPkt = await decodeOne(signHeartbeat({ passphrase: 'linkkey', linkId: 3 }));
  const unsignedPkt = await decodeOne(unsignedHeartbeat());

  // Good signature + right key -> accepted.
  assert.deepStrictEqual(verifyInboundPacket(signedPkt, policy({ passphrase: 'linkkey' })), {
    accepted: true,
    reason: 'signature-valid',
    signed: true
  });
  // Unsigned, not required -> accepted.
  assert.deepStrictEqual(verifyInboundPacket(unsignedPkt, policy({ passphrase: 'linkkey' })), {
    accepted: true,
    reason: 'unsigned-allowed',
    signed: false
  });
  // Unsigned, required -> rejected.
  assert.deepStrictEqual(
    verifyInboundPacket(unsignedPkt, policy({ passphrase: 'linkkey', requireSignature: true })),
    { accepted: false, reason: 'signature-required', signed: false }
  );
  // Signed but the verifier holds the wrong key -> rejected.
  const wrong = verifyInboundPacket(signedPkt, policy({ passphrase: 'different' }));
  assert.strictEqual(wrong.accepted, false);
  assert.strictEqual(wrong.reason, 'signature-invalid');
});

test('verify requested with no key fails closed on signed frames (#15)', async () => {
  const signedPkt = await decodeOne(signHeartbeat({ passphrase: 'linkkey' }));
  const decision = verifyInboundPacket(signedPkt, policy({ passphrase: '', requireSignature: true }));
  assert.strictEqual(decision.accepted, false);
  assert.strictEqual(decision.reason, 'signature-no-key');
});

test('signing replay: an authentic frame is accepted once, its replay rejected (#100)', async () => {
  const pkt = await decodeOne(signHeartbeat({ passphrase: 'replaykey', linkId: 4 }));
  const p = policy({ passphrase: 'replaykey' });
  assert.strictEqual(verifyInboundPacket(pkt, p).reason, 'signature-valid');
  const replay = verifyInboundPacket(pkt, p);
  assert.strictEqual(replay.accepted, false);
  assert.strictEqual(replay.reason, 'signature-replayed');
});

test('replay memory survives a rebuilt policy under the same key (#192)', async () => {
  // The Connection keys its ReplayTracker by the derived key on a persistent
  // LinkState, so a fresh policy built from the same LinkState + key keeps the
  // replay memory a codec/profile rebuild used to reset.
  const link = new LinkState();
  const pkt = await decodeOne(signHeartbeat({ passphrase: 'persist', linkId: 2 }));
  assert.strictEqual(verifyInboundPacket(pkt, policy({ passphrase: 'persist', link })).reason, 'signature-valid');
  // Rebuild the policy object (as a profile edit would) from the same link:
  const rebuilt = policy({ passphrase: 'persist', link });
  const replay = verifyInboundPacket(pkt, rebuilt);
  assert.strictEqual(replay.accepted, false, 'the replay is still caught after the policy rebuild');
});

test('outbound signing timestamps are monotonic so same-ms bursts are not self-rejected (#192)', async () => {
  // One shared LinkState advances the timestamp per (sysid, compid, linkId).
  const link = new LinkState();
  const p1 = await decodeOne(signHeartbeat({ passphrase: 'burstkey', linkId: 3, link }));
  const p2 = await decodeOne(signHeartbeat({ passphrase: 'burstkey', linkId: 3, link }));
  assert.ok(p2.signature.timestamp > p1.signature.timestamp, 'second frame has a strictly greater timestamp');

  const verifyLink = new LinkState();
  const p = policy({ passphrase: 'burstkey', link: verifyLink });
  assert.strictEqual(verifyInboundPacket(p1, p).reason, 'signature-valid');
  assert.strictEqual(verifyInboundPacket(p2, p).reason, 'signature-valid');
});

/** Connection-owned signing: a MAVLink link has exactly one shared key. */

test('the connection declares its signing passphrase as a runtime credential (#245)', () => {
  /**
   * The editor's credentials block alone does not populate
   * node.credentials.signingPassphrase — the runtime registerType must declare
   * the credential too, or editor-configured signing silently fails closed with
   * SIGNING_NO_PASSPHRASE. MockRED ignores the option, so assert the registration
   * directly with a stub that captures it.
   */
  const registerConnection = require('../../nodes/mavlink-ai-connection');
  let captured = null;
  const stubRED = {
    httpAdmin: null,
    settings: {},
    nodes: {
      registerType: (type, ctor, opts) => {
        if (type === 'mavlink-ai-connection') {
          captured = opts;
        }
      }
    }
  };
  registerConnection(stubRED);
  assert.ok(captured && captured.credentials && captured.credentials.signingPassphrase, 'signingPassphrase credential is declared');
  assert.strictEqual(captured.credentials.signingPassphrase.type, 'password');
});

test('connection exposes null signing policy when nothing is configured', async () => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, {});
  assert.strictEqual(connection.getSigningPolicy(), null);
  await RED.close(connection);
});

test('connection reads the passphrase from credentials, not plain config', async () => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, {
    signOutbound: true,
    verifyInbound: true,
    requireSignature: true,
    credentials: { signingPassphrase: 'secret' }
  });
  const p = connection.getSigningPolicy();
  assert.ok(Buffer.isBuffer(p.key), 'key is derived from the passphrase');
  assert.deepStrictEqual(p.key, MavLinkPacketSignature.key('secret'));
  assert.strictEqual(p.signOutbound, true);
  assert.strictEqual(p.verifyInbound, true);
  assert.strictEqual(p.requireSignature, true);
  await RED.close(connection);
});

test('connection requireSignature implies inbound verification (#70)', async () => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, { requireSignature: true, credentials: { signingPassphrase: 'k' } });
  assert.strictEqual(connection.getSigningPolicy().verifyInbound, true);
  await RED.close(connection);
});

test('connection with only verify flags (no passphrase) still returns a policy', async () => {
  /** So inbound verification can fail closed rather than silently pass. */
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, { verifyInbound: true, requireSignature: true });
  const p = connection.getSigningPolicy();
  assert.ok(p);
  assert.strictEqual(p.key, null);
  assert.strictEqual(p.verifyInbound, true);
  await RED.close(connection);
});

test('sign-outbound with no passphrase fails the connection closed, not silently unsigned', async () => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, { id: 'c-nokey', signOutbound: true });
  assert.ok(
    connection.errors.some((e) => /SIGNING_NO_PASSPHRASE/.test(String(e))),
    'connection refuses to start rather than send every frame unsigned'
  );
  await assert.rejects(connection.send({ name: 'HEARTBEAT', fields: {} }), (e) => e.code === 'CONNECTION_INVALID');
  await RED.close(connection);
});

test('one identity, two connections: signed on one, unsigned on the other', async () => {
  /** The whole point of moving signing to the link: a single GCS identity can
   *  talk signed to a secured fleet and unsigned to an open one. */
  const RED = new MockRED().loadNodes();
  makeIdentity(RED, { id: 'gcs' });
  const secured = makeConnection(RED, {
    localIdentity: 'gcs',
    signOutbound: true,
    credentials: { signingPassphrase: 'fleet-a' }
  }).connection;
  const open = makeConnection(RED, { localIdentity: 'gcs' }).connection;
  assert.ok(secured.getSigningPolicy() && secured.getSigningPolicy().signOutbound);
  assert.strictEqual(open.getSigningPolicy(), null);
  await RED.close(secured);
  await RED.close(open);
});
