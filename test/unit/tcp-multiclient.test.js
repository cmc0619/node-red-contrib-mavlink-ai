'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * TCP is a byte stream, so a tcp-server connection that funnels every client's
 * bytes through one shared MAVLink splitter corrupts framing the moment two
 * clients' frames interleave across `data` events (client A's half-frame with
 * client B's bytes in between). The connection keys a decoder per client via the
 * transport's `clientId`, so each client's stream is reassembled independently
 * (#147).
 */

const common = loadDialect('common');

/**
 * A complete HEARTBEAT frame from `sysid`, used as a whole-frame unit that the
 * test then splits to simulate a partial TCP read.
 *
 * @param {number} sysid  source system id to frame from
 * @returns {Buffer} the encoded frame
 */
function heartbeatFrom(sysid) {
  const codec = new MavlinkCodec({ bundle: common, version: 'v2' });
  return enc(codec, 'HEARTBEAT', { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 }, { sysid, compid: 1 });
}

/**
 * Create a single-profile tcp-server connection bound to an ephemeral port.
 *
 * @param {MockRED} RED  the mock runtime
 * @returns {object} the connection node
 */
function tcpServerConnection(RED) {
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Server', profile: 'p1', localIdentity: 'id1',
    transport: 'tcp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  RED.events.emit('flows:started');
  return conn;
}

/** Poll `cond` until truthy or the timeout elapses (decode is asynchronous). */
async function waitFor(cond, timeoutMs = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('tcp-server decodes two clients whose partial frames interleave (#147)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = tcpServerConnection(RED);
  t.after(() => RED.close(conn));

  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));

  const a = heartbeatFrom(10);
  const b = heartbeatFrom(20);
  const aMid = Math.floor(a.length / 2);
  const bMid = Math.floor(b.length / 2);

  /**
   * Interleave the two clients' halves the way two TCP reads would arrive:
   * A-first ∥ B-first ∥ A-rest ∥ B-rest. A shared decoder would splice A's and
   * B's bytes into one corrupt frame; per-client decoders keep them apart.
   */
  conn._transport.emit('data', a.subarray(0, aMid), { address: '127.0.0.1', port: 5001, clientId: 1 });
  conn._transport.emit('data', b.subarray(0, bMid), { address: '127.0.0.1', port: 5002, clientId: 2 });
  conn._transport.emit('data', a.subarray(aMid), { address: '127.0.0.1', port: 5001, clientId: 1 });
  conn._transport.emit('data', b.subarray(bMid), { address: '127.0.0.1', port: 5002, clientId: 2 });

  await waitFor(() => received.length >= 2);
  const sysids = received.map((p) => p.sysid).sort((x, y) => x - y);
  assert.deepStrictEqual(sysids, [10, 20], 'both clients decoded cleanly');
  assert.ok(received.every((p) => p.name === 'HEARTBEAT'));

  /**
   * Per-message endpoint (#239): each decoded payload reports the client
   * socket that actually sent it — address, source port, and the per-client
   * clientId — not the server's listening endpoint.
   */
  const fromA = received.find((p) => p.sysid === 10);
  const fromB = received.find((p) => p.sysid === 20);
  assert.strictEqual(fromA.transport.remoteAddress, '127.0.0.1');
  assert.strictEqual(fromA.transport.remotePort, 5001);
  assert.strictEqual(fromA.transport.clientId, 1);
  assert.strictEqual(fromB.transport.remotePort, 5002);
  assert.strictEqual(fromB.transport.clientId, 2);
  t.diagnostic('two interleaved client streams decoded without cross-corruption');
});

test('a single shared stream corrupts the same interleaved frames (control) (#147)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = tcpServerConnection(RED);
  t.after(() => RED.close(conn));

  const received = [];
  conn.emitter.on('message', (m) => received.push(m.payload));

  const a = heartbeatFrom(10);
  const b = heartbeatFrom(20);
  const aMid = Math.floor(a.length / 2);
  const bMid = Math.floor(b.length / 2);

  /**
   * Same interleave, but delivered without a `clientId` so every chunk lands in
   * the one shared decoder — exactly the pre-fix behaviour. The spliced bytes
   * fail CRC, so the two frames cannot both survive.
   */
  conn._transport.emit('data', a.subarray(0, aMid));
  conn._transport.emit('data', b.subarray(0, bMid));
  conn._transport.emit('data', a.subarray(aMid));
  conn._transport.emit('data', b.subarray(bMid));

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(received.length < 2, `shared decoder cannot cleanly recover both frames (got ${received.length})`);
});
