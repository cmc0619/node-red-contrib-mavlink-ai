'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

/**
 * UDP peer learning trust boundary (#85): a udp-peer connection must only
 * commit a sender endpoint (fallback peer / per-sysid mapping) after the
 * packet has passed CRC, route acceptance, and any signature policy. A
 * malformed, route-rejected, or signature-rejected datagram must not teach
 * the transport where to send outbound traffic.
 */

const HEARTBEAT = { type: 'MAV_TYPE_GCS', autopilot: 'MAV_AUTOPILOT_INVALID', base_mode: 0, custom_mode: 0, system_status: 'MAV_STATE_ACTIVE' };

/** Retry-send until an event arrives (UDP loopback can drop datagrams). */
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

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('peer learning requires validated packets (#85)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p1', name: 'P', dialect: 'common', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1',
    transport: 'udp-peer', acceptedSysids: '1',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const bundle = loadDialect('common');
  const fromSys1 = new MavlinkCodec({ bundle, version: 'v2', sysid: 1, compid: 1 });
  const fromSys2 = new MavlinkCodec({ bundle, version: 'v2', sysid: 2, compid: 1 });
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });
  const transport = conn._transport;

  // 1. CRC-corrupt frame claiming sysid 1: seen by the transport, but the
  //    splitter drops it, so nothing may be learned.
  const corrupt = fromSys1.encode('HEARTBEAT', HEARTBEAT);
  corrupt[corrupt.length - 1] ^= 0xff; // break the CRC
  await until(
    (done) => transport.on('data', done),
    () => sock.send(corrupt, port, '127.0.0.1'),
    'corrupt datagram observed'
  );
  await tick();
  assert.strictEqual(transport.learnedPeer, null, 'CRC-invalid frame must not set the fallback peer');
  assert.strictEqual(transport.peersBySysid.size, 0, 'CRC-invalid frame must not teach a sysid endpoint');

  // 2. Valid frame from sysid 2, which the accept filter rejects: the packet
  //    decodes fine at the framing level but fails routing — still not learned.
  const rejected = await until(
    (done) => conn.emitter.on('rejected', done),
    () => sock.send(fromSys2.encode('HEARTBEAT', HEARTBEAT), port, '127.0.0.1'),
    'route rejection'
  );
  assert.strictEqual(rejected.sysid, 2);
  await tick();
  assert.strictEqual(transport.learnedPeer, null, 'route-rejected frame must not set the fallback peer');
  assert.strictEqual(transport.peersBySysid.has(2), false, 'route-rejected frame must not teach its sysid');

  // 3. Valid, accepted frame from sysid 1: NOW the sender becomes the fallback
  //    peer and owns its sysid mapping, so addressed sends reach it.
  await until(
    (done) => conn.subscribe({ messageNames: ['HEARTBEAT'], sysid: 1 }, done),
    () => sock.send(fromSys1.encode('HEARTBEAT', HEARTBEAT), port, '127.0.0.1'),
    'accepted packet'
  );
  assert.ok(transport.learnedPeer, 'accepted packet sets the fallback peer');
  assert.strictEqual(transport.learnedPeer.port, sock.address().port);
  assert.strictEqual(transport.peersBySysid.get(1).port, sock.address().port);

  // Target-specific sending keeps working against the confirmed mapping.
  await conn.send({ name: 'HEARTBEAT', fields: HEARTBEAT, target_system: 1 });
});

test('signature-rejected packets do not teach a peer mapping (#85)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p_sig', name: 'Sig', dialect: 'common', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1,
    verifyInbound: true, requireSignature: true,
    credentials: { signingPassphrase: 'the-shared-secret' }
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_sig', name: 'CSig', profile: 'p_sig',
    transport: 'udp-peer',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const bundle = loadDialect('common');
  const unsigned = new MavlinkCodec({ bundle, version: 'v2', sysid: 3, compid: 1 });
  const signed = new MavlinkCodec({
    bundle, version: 'v2', sysid: 3, compid: 1,
    signing: { passphrase: 'the-shared-secret', linkId: 1, signOutbound: true }
  });
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });
  const transport = conn._transport;

  // Unsigned frame under a require-signature policy: rejected, not learned.
  const rejected = await until(
    (done) => conn.emitter.on('rejected', done),
    () => sock.send(unsigned.encode('HEARTBEAT', HEARTBEAT), port, '127.0.0.1'),
    'signature rejection'
  );
  assert.strictEqual(rejected.reason, 'signature-required');
  await tick();
  assert.strictEqual(transport.learnedPeer, null, 'signature-rejected frame must not set the fallback peer');
  assert.strictEqual(transport.peersBySysid.size, 0);

  // A properly signed frame passes verification and is learned.
  await until(
    (done) => conn.subscribe({ messageNames: ['HEARTBEAT'], sysid: 3 }, done),
    () => sock.send(signed.encode('HEARTBEAT', HEARTBEAT), port, '127.0.0.1'),
    'signed packet accepted'
  );
  assert.ok(transport.learnedPeer, 'signed packet sets the fallback peer');
  assert.strictEqual(transport.peersBySysid.get(3).port, sock.address().port);
});
