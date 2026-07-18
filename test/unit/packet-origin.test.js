'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * Per-message endpoint context (#239, DESIGN.md §14.1/§17.1). Each transport
 * read's source endpoint travels with the packets that read completed:
 * decoded payloads report the actual sender in `transport.remoteAddress`/
 * `remotePort` (not the connection-wide configured/fallback remote), rejected
 * diagnostics carry the same context, and a udp-peer commits exactly the
 * validated packet's own endpoint — never a mutable latest-claimant lookup.
 */

const common = loadDialect('common');
const HEARTBEAT = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };

/**
 * A complete HEARTBEAT frame from `sysid`.
 *
 * @param {number} sysid  source system id to frame from
 * @returns {Buffer} the encoded frame
 */
function heartbeatFrom(sysid) {
  const codec = new MavlinkCodec({ bundle: common, version: 'v2' });
  return enc(codec, 'HEARTBEAT', HEARTBEAT, { sysid, compid: 1 });
}

/**
 * Create a udp-peer connection bound to an ephemeral port. Inbound traffic is
 * driven synthetically via `conn._transport.emit('data', buffer, rinfo)` so
 * endpoint scenarios are deterministic (no real datagram races).
 *
 * @param {MockRED} RED  the mock runtime
 * @param {object} [config]  extra connection config
 * @returns {object} the connection node
 */
function udpPeerConnection(RED, config) {
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', Object.assign({
    id: 'c1', name: 'Peer', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', bindAddress: '127.0.0.1', bindPort: 0,
    reconnect: false, heartbeat: false
  }, config));
  RED.events.emit('flows:started');
  return conn;
}

test('decoded payloads carry each datagram\'s own endpoint, and confirmPeer commits it (#239)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = udpPeerConnection(RED);
  t.after(() => RED.close(conn));

  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));

  /** Two senders claim the same sysid from different endpoints. */
  conn._transport.emit('data', heartbeatFrom(7), { address: '10.0.0.1', port: 111 });
  conn._transport.emit('data', heartbeatFrom(7), { address: '10.0.0.2', port: 222 });

  assert.strictEqual(received.length, 2, 'both packets decoded');
  assert.strictEqual(received[0].transport.remoteAddress, '10.0.0.1');
  assert.strictEqual(received[0].transport.remotePort, 111);
  assert.strictEqual(received[1].transport.remoteAddress, '10.0.0.2');
  assert.strictEqual(received[1].transport.remotePort, 222);

  /**
   * The committed peer for sysid 7 is the endpoint of the packet validated
   * last — each validated packet commits its OWN datagram source, so the
   * mapping always names an endpoint that produced a validated packet.
   */
  assert.deepStrictEqual(conn._transport.peersBySysid.get(7), { address: '10.0.0.2', port: 222 });
});

test('frames concatenated in one datagram all carry that datagram\'s endpoint (#239)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = udpPeerConnection(RED);
  t.after(() => RED.close(conn));

  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));

  conn._transport.emit(
    'data',
    Buffer.concat([heartbeatFrom(7), heartbeatFrom(8)]),
    { address: '10.0.0.3', port: 333 }
  );

  assert.strictEqual(received.length, 2, 'both concatenated frames decoded');
  for (const payload of received) {
    assert.strictEqual(payload.transport.remoteAddress, '10.0.0.3');
    assert.strictEqual(payload.transport.remotePort, 333);
  }
  assert.deepStrictEqual(conn._transport.peersBySysid.get(7), { address: '10.0.0.3', port: 333 });
  assert.deepStrictEqual(conn._transport.peersBySysid.get(8), { address: '10.0.0.3', port: 333 });
});

test('rejected diagnostics carry the sender endpoint; a read without one yields no context (#239)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = udpPeerConnection(RED, { acceptedSysids: '7' });
  t.after(() => RED.close(conn));

  const rejections = [];
  conn.emitter.on('rejected', (info) => rejections.push(info));
  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));

  /** A route-rejected frame reports which endpoint sent it... */
  conn._transport.emit('data', heartbeatFrom(9), { address: '10.0.0.9', port: 999 });
  assert.strictEqual(rejections.length, 1);
  assert.strictEqual(rejections[0].sysid, 9);
  assert.strictEqual(rejections[0].remoteAddress, '10.0.0.9');
  assert.strictEqual(rejections[0].remotePort, 999);
  /** ...and it never became a routable peer. */
  assert.strictEqual(conn._transport.peersBySysid.size, 0);

  /**
   * A read with no source info (serial delivers none) decodes fine with the
   * connection-wide descriptor and commits nothing: without a validated
   * endpoint there is nothing trustworthy to commit.
   */
  conn._transport.emit('data', heartbeatFrom(7));
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].transport.remoteAddress, undefined);
  assert.strictEqual(conn._transport.peersBySysid.size, 0);
});

test('one UDP peer\'s buffered phantom bytes never reattribute frames to another peer (#153, #262 review)', async (t) => {
  /**
   * Peer A's datagram carries a phantom header (false magic claiming a
   * 255-byte payload) followed by a complete valid frame — the phantom's
   * declared window is unsatisfied, so those bytes stay buffered. If UDP
   * shared one framing stream, peer B's next datagram would complete the
   * window and the resync would emit A's recovered frame during B's read —
   * with B's origin, teaching confirmPeer A's sysid at B's endpoint. Framing
   * is keyed per source endpoint instead: B's datagram decodes independently,
   * and A's frame is recovered only by A's own next datagram, with A's origin.
   */
  const RED = new MockRED().loadNodes();
  const conn = udpPeerConnection(RED);
  t.after(() => RED.close(conn));

  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));

  const phantom = Buffer.from([0xfd, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);
  const endpointA = { address: '10.0.0.1', port: 111 };
  const endpointB = { address: '10.0.0.2', port: 222 };

  conn._transport.emit('data', Buffer.concat([phantom, heartbeatFrom(7)]), endpointA);
  assert.strictEqual(received.length, 0, "A's frame sits behind the unfilled phantom window");

  /** 300 bytes from B would complete A's phantom window in a shared stream. */
  conn._transport.emit('data', Buffer.concat(Array.from({ length: 15 }, () => heartbeatFrom(8))), endpointB);
  const fromB = received.filter((p) => p.sysid === 8);
  assert.strictEqual(fromB.length, 15, "B's own frames decode fine");
  assert.strictEqual(received.some((p) => p.sysid === 7), false, "A's frame was NOT released by B's bytes");
  assert.strictEqual(conn._transport.peersBySysid.has(7), false, "A's sysid was not committed anywhere yet");

  /** A's own next datagram completes its window; the recovered frame is A's. */
  conn._transport.emit('data', Buffer.concat(Array.from({ length: 15 }, () => heartbeatFrom(7))), endpointA);
  const fromA = received.filter((p) => p.sysid === 7);
  assert.ok(fromA.length >= 1, "A's frames recover once A's own bytes complete the window");
  assert.ok(fromA.every((p) => p.transport.remoteAddress === '10.0.0.1'), "every sysid-7 frame carries A's endpoint");
  assert.deepStrictEqual(conn._transport.peersBySysid.get(7), { address: '10.0.0.1', port: 111 });
  assert.deepStrictEqual(conn._transport.peersBySysid.get(8), { address: '10.0.0.2', port: 222 });
});

test('a reconnect drops per-endpoint framing state, not just the shared stream (#262 review)', async (t) => {
  /**
   * A UDP socket rebind invalidates every stream: a per-endpoint decoder that
   * had a partial or phantom frame buffered when the socket errored must not
   * survive into the new session, or the endpoint's first post-recovery
   * datagrams are appended mid-frame and garbled.
   */
  const RED = new MockRED().loadNodes();
  const conn = udpPeerConnection(RED);
  t.after(() => RED.close(conn));

  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));

  const frame = heartbeatFrom(7);
  const endpointA = { address: '10.0.0.1', port: 111 };
  conn._transport.emit('data', frame.subarray(0, 10), endpointA);
  assert.ok(conn._decoders.size >= 1, 'the endpoint has framing state buffered');

  conn._transport.emit('reconnecting');
  assert.strictEqual(conn._decoders.size, 0, 'every stream decoder is dropped on reconnect');

  /** A fresh, complete frame from the same endpoint decodes cleanly. */
  conn._transport.emit('data', frame, endpointA);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].sysid, 7);
  assert.strictEqual(received[0].transport.remoteAddress, '10.0.0.1');
});

test('decoded payloads and rejected diagnostics carry the connection identity (#240)', async (t) => {
  /**
   * A Profile can be shared by several Connections and separate links reuse
   * common wire identities, so the payload carries the canonical Connection
   * config-node id (and display name) for flows and Filter state to key on.
   */
  const RED = new MockRED().loadNodes();
  const conn = udpPeerConnection(RED, { acceptedSysids: '7' });
  t.after(() => RED.close(conn));

  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));
  const rejections = [];
  conn.emitter.on('rejected', (info) => rejections.push(info));

  conn._transport.emit('data', heartbeatFrom(7), { address: '10.0.0.1', port: 111 });
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].connection, 'Peer');
  assert.strictEqual(received[0].connection_id, 'c1');

  conn._transport.emit('data', heartbeatFrom(9), { address: '10.0.0.9', port: 999 });
  assert.strictEqual(rejections.length, 1);
  assert.strictEqual(rejections[0].connection_id, 'c1');
});

test('a partial broadcast failure surfaces as a throttled connection warning (#148)', async (t) => {
  /**
   * The transport's sendPartialFailure event (#148) existed "so an operator
   * can observe" a degraded broadcast peer, but nothing forwarded it — the
   * signal died unobserved. The connection now warns, throttled to changes in
   * the failing endpoint set (broadcasts fire at heartbeat rate).
   */
  const RED = new MockRED().loadNodes();
  const conn = udpPeerConnection(RED);
  t.after(() => RED.close(conn));

  const failure = (port) => ({
    failed: 1,
    total: 2,
    reasons: [{ message: 'send failed', context: { address: '10.0.0.9', port } }]
  });
  conn._transport.emit('sendPartialFailure', failure(14550));
  conn._transport.emit('sendPartialFailure', failure(14550));
  assert.strictEqual(conn.warnings.length, 1, 'the same failing set warns once, not per send');
  assert.match(String(conn.warnings[0]), /1\/2 peers unreachable/);
  assert.match(String(conn.warnings[0]), /10\.0\.0\.9:14550/);

  /** A different failing endpoint set warns again. */
  conn._transport.emit('sendPartialFailure', failure(14551));
  assert.strictEqual(conn.warnings.length, 2);
});

test('the decoder attributes packets to the read that completed the frame (#239)', () => {
  const codec = new MavlinkCodec({ bundle: common, version: 'v2' });
  const f1 = heartbeatFrom(1);
  const f2 = heartbeatFrom(2);

  const got = [];
  const decoder = codec.createDecoder((packet, origin) => got.push({ sysid: packet.header.sysid, origin }));

  /** Delivery is synchronous within write(), carrying that write's origin. */
  decoder.write(f1, 'A');
  assert.deepStrictEqual(got, [{ sysid: 1, origin: 'A' }], 'delivered inside write(), with its origin');

  /** Frames concatenated in one read share that read's origin. */
  decoder.write(Buffer.concat([f1, f2]), 'B');
  assert.deepStrictEqual(got.slice(1), [
    { sysid: 1, origin: 'B' },
    { sysid: 2, origin: 'B' }
  ]);

  /** A frame split across reads is attributed to the read that completes it. */
  decoder.write(f2.subarray(0, 6), 'C');
  assert.strictEqual(got.length, 3, 'half a frame delivers nothing');
  decoder.write(f2.subarray(6), 'D');
  assert.deepStrictEqual(got[3], { sysid: 2, origin: 'D' });

  decoder.destroy();
});
