'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

const HEARTBEAT = {
  type: 'MAV_TYPE_QUADROTOR',
  autopilot: 'MAV_AUTOPILOT_ARDUPILOTMEGA',
  base_mode: 0,
  custom_mode: 0,
  system_status: 'MAV_STATE_ACTIVE'
};

/**
 * End-to-end MAVLink 2 signing over a real UDP loopback (issue #15): a
 * connection whose profile requires valid signatures accepts a correctly-signed
 * frame, and rejects both unsigned and wrongly-signed frames with a structured
 * `rejected` reason — the same diagnostics path the in-node errors output uses.
 */
test('connection verifies inbound signatures per the profile policy', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-profile', {
    id: 'p_sign',
    name: 'Signed',
    profileType: 'gcs',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    sourceSystemId: 255,
    sourceComponentId: 190,
    defaultTargetSystem: 1,
    defaultTargetComponent: 1,
    // Signing policy: verify inbound and require a valid signature.
    signOutbound: true,
    verifyInbound: true,
    requireSignature: true,
    signingLinkId: 1,
    credentials: { signingPassphrase: 'shared-link-secret' }
  });

  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_sign',
    name: 'Signed UDP',
    profile: 'p_sign',
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
  const goodSigner = new MavlinkCodec({
    bundle,
    version: 'v2',
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'shared-link-secret', linkId: 2, signOutbound: true }
  });
  const badSigner = new MavlinkCodec({
    bundle,
    version: 'v2',
    sysid: 1,
    compid: 1,
    signing: { passphrase: 'wrong-secret', linkId: 2, signOutbound: true }
  });
  const unsigned = new MavlinkCodec({ bundle, version: 'v2', sysid: 1, compid: 1 });

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
    () => sock.send(goodSigner.encode('HEARTBEAT', HEARTBEAT), port, '127.0.0.1'),
    'signed heartbeat accepted'
  );
  assert.strictEqual(msg.payload.name, 'HEARTBEAT');
  assert.strictEqual(msg.payload.sysid, 1);

  // A wrongly-signed HEARTBEAT is rejected with signature-invalid.
  const badReject = await until(
    (done) => conn.emitter.on('rejected', done),
    () => sock.send(badSigner.encode('HEARTBEAT', HEARTBEAT), port, '127.0.0.1'),
    'bad signature rejected'
  );
  assert.strictEqual(badReject.reason, 'signature-invalid');
  assert.strictEqual(badReject.sysid, 1);

  // An unsigned HEARTBEAT is rejected because the profile requires a signature.
  const unsignedReject = await until(
    (done) => conn.emitter.on('rejected', done),
    () => sock.send(unsigned.encode('HEARTBEAT', HEARTBEAT), port, '127.0.0.1'),
    'unsigned rejected'
  );
  assert.strictEqual(unsignedReject.reason, 'signature-required');
});
