'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const { MavLinkPacketSignature } = require('node-mavlink');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

const HEARTBEAT = {
  type: 'MAV_TYPE_QUADROTOR',
  autopilot: 'MAV_AUTOPILOT_ARDUPILOTMEGA',
  base_mode: 0,
  custom_mode: 0,
  system_status: 'MAV_STATE_ACTIVE'
};

/**
 * End-to-end MAVLink 2 signing over a real UDP loopback (issue #15). Under the
 * v3 three-node model (#228) the signing *policy* (passphrase, verify, require,
 * signOutbound) lives on the connection's Local Identity, while the signing
 * *link id* lives on the Connection. The connection verifies inbound frames
 * against its default identity's policy: a correctly-signed frame is accepted,
 * and both unsigned and wrongly-signed frames are rejected with a structured
 * `rejected` reason. External signer peers are now plain dialect codecs whose
 * signing is supplied per-frame via `enc(..., { signing: { key, linkId } })`.
 */
test('connection verifies inbound signatures per the identity policy', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-vehicle', {
    id: 'p_sign',
    name: 'Signed',
    vehicleFamily: 'generic',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });

  // Signing policy now belongs to the Local Identity.
  RED.create('mavlink-ai-local-identity', {
    id: 'id_sign',
    name: 'Signer',
    role: 'custom',
    sourceSystemId: 255,
    sourceComponentId: 190,
    signOutbound: true,
    verifyInbound: true,
    requireSignature: true,
    credentials: { signingPassphrase: 'shared-link-secret' }
  });

  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_sign',
    name: 'Signed UDP',
    profile: 'p_sign',
    localIdentity: 'id_sign',
    // The signing link id is connection-owned in v3.
    signingLinkId: 1,
    transport: 'udp-peer',
    routingMode: 'single-profile',
    unmatchedPolicy: 'default',
    bindAddress: '127.0.0.1',
    bindPort: 0,
    reconnect: false,
    heartbeat: false
  });

  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const bundle = loadDialect('ardupilotmega');
  const goodKey = MavLinkPacketSignature.key('shared-link-secret');
  const badKey = MavLinkPacketSignature.key('wrong-secret');
  const goodSigner = new MavlinkCodec({ bundle, version: 'v2' });
  const badSigner = new MavlinkCodec({ bundle, version: 'v2' });
  const unsigned = new MavlinkCodec({ bundle, version: 'v2' });

  const sock = dgram.createSocket('udp4');
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });

  const until = (attach, sendOnce, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(retry);
        reject(new Error(`timeout: ${label}`));
      }, 5000);
      const done = (v) => {
        clearTimeout(timer);
        clearInterval(retry);
        resolve(v);
      };
      attach(done);
      sendOnce();
      const retry = setInterval(sendOnce, 200);
    });

  // A correctly-signed HEARTBEAT is accepted and dispatched.
  const msg = await until(
    (done) => conn.subscribe({ messageNames: ['HEARTBEAT'] }, done),
    () =>
      sock.send(
        enc(goodSigner, 'HEARTBEAT', HEARTBEAT, { sysid: 1, compid: 1, signing: { key: goodKey, linkId: 2 } }),
        port,
        '127.0.0.1'
      ),
    'signed heartbeat accepted'
  );
  assert.strictEqual(msg.payload.name, 'HEARTBEAT');
  assert.strictEqual(msg.payload.sysid, 1);

  // A wrongly-signed HEARTBEAT is rejected with signature-invalid.
  const badReject = await until(
    (done) => conn.emitter.on('rejected', done),
    () =>
      sock.send(
        enc(badSigner, 'HEARTBEAT', HEARTBEAT, { sysid: 1, compid: 1, signing: { key: badKey, linkId: 2 } }),
        port,
        '127.0.0.1'
      ),
    'bad signature rejected'
  );
  assert.strictEqual(badReject.reason, 'signature-invalid');
  assert.strictEqual(badReject.sysid, 1);

  // An unsigned HEARTBEAT is rejected because the identity requires a signature.
  const unsignedReject = await until(
    (done) => conn.emitter.on('rejected', done),
    () => sock.send(enc(unsigned, 'HEARTBEAT', HEARTBEAT, { sysid: 1, compid: 1 }), port, '127.0.0.1'),
    'unsigned rejected'
  );
  assert.strictEqual(unsignedReject.reason, 'signature-required');
});

/**
 * A routed connection still verifies inbound signatures, against its default
 * Local Identity's key (#228: a Vehicle Profile no longer owns a signing key —
 * signing is identity-scoped, and the connection verifies with its default
 * identity's policy). The matched route still governs the *dialect/label*: a
 * frame from a routed sysid signed with the connection's key is accepted and
 * carries the matched route's profile name, while the same sysid signing with
 * the wrong key is rejected as signature-invalid.
 */
test('routed connection verifies signed frames against the default identity key', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-vehicle', {
    id: 'p_default',
    name: 'Default',
    vehicleFamily: 'generic',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p_routed',
    name: 'Routed',
    vehicleFamily: 'copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 2,
    defaultTargetComponent: 1
  });

  RED.create('mavlink-ai-local-identity', {
    id: 'id_def',
    name: 'GCS',
    role: 'custom',
    sourceSystemId: 255,
    sourceComponentId: 190,
    verifyInbound: true,
    requireSignature: true,
    credentials: { signingPassphrase: 'link-key' }
  });

  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_routed_sign',
    name: 'Routed Signed UDP',
    profile: 'p_default',
    localIdentity: 'id_def',
    transport: 'udp-peer',
    routingMode: 'routed',
    unmatchedPolicy: 'default',
    routeTable: JSON.stringify([{ sysid: 2, compid: '*', profile: 'p_routed' }]),
    bindAddress: '127.0.0.1',
    bindPort: 0,
    reconnect: false,
    heartbeat: false
  });

  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const bundle = loadDialect('ardupilotmega');
  const goodKey = MavLinkPacketSignature.key('link-key');
  const wrongKey = MavLinkPacketSignature.key('other-key');
  // sysid 2 signs with the connection's identity key -> accepted, labeled 'Routed'.
  const routedSigner = new MavlinkCodec({ bundle, version: 'v2' });
  // sysid 2 signing with a different key -> rejected as signature-invalid.
  const wrongKeySigner = new MavlinkCodec({ bundle, version: 'v2' });

  const sock = dgram.createSocket('udp4');
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });

  const until = (attach, sendOnce, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(retry);
        reject(new Error(`timeout: ${label}`));
      }, 5000);
      const done = (v) => {
        clearTimeout(timer);
        clearInterval(retry);
        resolve(v);
      };
      attach(done);
      sendOnce();
      const retry = setInterval(sendOnce, 200);
    });

  // Signed with the identity key -> accepted, and labeled with the matched
  // route's profile (proving routing decode still applies the matched profile).
  const msg = await until(
    (done) => conn.subscribe({ messageNames: ['HEARTBEAT'], sysid: 2 }, done),
    () =>
      sock.send(
        enc(routedSigner, 'HEARTBEAT', HEARTBEAT, { sysid: 2, compid: 1, signing: { key: goodKey, linkId: 1 } }),
        port,
        '127.0.0.1'
      ),
    'routed signed heartbeat accepted'
  );
  assert.strictEqual(msg.payload.sysid, 2);
  assert.strictEqual(msg.payload.profile, 'Routed');

  // Signed with the wrong key -> rejected.
  const reject = await until(
    (done) => conn.emitter.on('rejected', done),
    () =>
      sock.send(
        enc(wrongKeySigner, 'HEARTBEAT', HEARTBEAT, { sysid: 2, compid: 1, signing: { key: wrongKey, linkId: 1 } }),
        port,
        '127.0.0.1'
      ),
    'wrong-key from routed sysid rejected'
  );
  assert.strictEqual(reject.sysid, 2);
  assert.strictEqual(reject.reason, 'signature-invalid');
});

/**
 * Anti-replay end-to-end (#100): a connection that verifies signatures accepts a
 * signed frame once, then rejects a byte-for-byte replay of the *same* frame
 * with `signature-replayed` — the monotonic-timestamp rule the signing spec
 * requires, surfaced on the same structured rejection path as other diagnostics.
 * (v3: signing policy on the identity, signing link id on the connection.)
 */
test('connection rejects a replayed signed frame', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-vehicle', {
    id: 'p_replay',
    name: 'Replay',
    vehicleFamily: 'generic',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });

  RED.create('mavlink-ai-local-identity', {
    id: 'id_replay',
    name: 'GCS',
    role: 'custom',
    sourceSystemId: 255,
    sourceComponentId: 190,
    verifyInbound: true,
    requireSignature: true,
    credentials: { signingPassphrase: 'replay-secret' }
  });

  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_replay',
    name: 'Replay UDP',
    profile: 'p_replay',
    localIdentity: 'id_replay',
    signingLinkId: 1,
    transport: 'udp-peer',
    routingMode: 'single-profile',
    unmatchedPolicy: 'default',
    bindAddress: '127.0.0.1',
    bindPort: 0,
    reconnect: false,
    heartbeat: false
  });

  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const bundle = loadDialect('ardupilotmega');
  const key = MavLinkPacketSignature.key('replay-secret');
  const signer = new MavlinkCodec({ bundle, version: 'v2' });
  /** One frame, captured so the exact bytes (and timestamp) can be replayed. */
  const frame = enc(signer, 'HEARTBEAT', HEARTBEAT, { sysid: 1, compid: 1, signing: { key, linkId: 2 } });

  const sock = dgram.createSocket('udp4');
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });

  const until = (attach, sendOnce, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(retry);
        reject(new Error(`timeout: ${label}`));
      }, 5000);
      const done = (v) => {
        clearTimeout(timer);
        clearInterval(retry);
        resolve(v);
      };
      attach(done);
      sendOnce();
      const retry = setInterval(sendOnce, 200);
    });

  const msg = await until(
    (done) => conn.subscribe({ messageNames: ['HEARTBEAT'] }, done),
    () => sock.send(frame, port, '127.0.0.1'),
    'first signed frame accepted'
  );
  assert.strictEqual(msg.payload.name, 'HEARTBEAT');

  const reject = await until(
    (done) => conn.emitter.on('rejected', done),
    () => sock.send(frame, port, '127.0.0.1'),
    'replayed frame rejected'
  );
  assert.strictEqual(reject.reason, 'signature-replayed');
  assert.strictEqual(reject.sysid, 1);
});
