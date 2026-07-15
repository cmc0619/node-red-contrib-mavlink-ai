'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

/**
 * A connection stand-in whose subscribe() captures the callback, so a test can
 * deliver the single shared decoded message the real connection fans out to
 * every subscriber (§20).
 *
 * @param {MockRED} RED
 * @param {string} id
 * @returns {{conn: object, deliver: function(object): void}}
 */
function capturingConnection(RED, id) {
  const emitter = new EventEmitter();
  let captured = null;
  const conn = {
    id,
    name: 'stub',
    emitter,
    statusState: 'connected',
    subscribe: (filter, cb) => {
      captured = cb;
      return 1;
    },
    unsubscribe: () => true
  };
  RED._nodes.set(id, conn);
  return { conn, deliver: (message) => captured(message) };
}

test('mavlink-ai-in forwards a clone, isolating the shared decoded payload (#141)', () => {
  const RED = new MockRED().loadNodes();
  const { conn, deliver } = capturingConnection(RED, 'c1');
  const node = RED.create('mavlink-ai-in', { id: 'in1', connection: 'c1' });

  const shared = { topic: 'mavlink/ATTITUDE', payload: { name: 'ATTITUDE', fields: { roll: 1 } } };
  deliver(shared);

  const forwarded = node.sent[0];
  assert.notStrictEqual(forwarded, shared, 'must not forward the shared message object');
  assert.notStrictEqual(forwarded.payload, shared.payload, 'must not forward the shared payload');
  assert.deepStrictEqual(forwarded.payload, shared.payload, 'clone must be an equal copy');

  forwarded.payload.fields.roll = 999;
  assert.strictEqual(shared.payload.fields.roll, 1, 'mutating the forwarded copy must not touch the shared payload');
  assert.strictEqual(conn.emitter.listenerCount('status'), 1);
});

test('mavlink-ai-in close still signals done when the connection dereference throws (#140)', async () => {
  const RED = new MockRED().loadNodes();
  const { conn } = capturingConnection(RED, 'c1');
  conn.unsubscribe = () => {
    throw new Error('connection already torn down');
  };
  const node = RED.create('mavlink-ai-in', { id: 'in1', connection: 'c1' });

  /** RED.close resolves only if the close handler calls done() despite the throw. */
  await RED.close(node);
  assert.ok(node.errors.length >= 1, 'the swallowed teardown error is logged');
});

test('mavlink-ai-out close still signals done when the connection dereference throws (#140)', async () => {
  const RED = new MockRED().loadNodes();
  const { conn } = capturingConnection(RED, 'c1');
  conn.emitter.removeListener = () => {
    throw new Error('connection already torn down');
  };
  const node = RED.create('mavlink-ai-out', { id: 'out1', connection: 'c1' });

  await RED.close(node);
  assert.ok(node.errors.length >= 1);
});

test('connection close completes (done) even when decoder teardown throws (#140)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p1', name: 'Vehicle', profileType: 'gcs', dialect: 'common', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  RED.events.emit('flows:started');

  /** The decoder is built lazily on first inbound datagram, so feed one HEARTBEAT. */
  const hb = new MavlinkCodec({ bundle: loadDialect('common'), version: 'v2', sysid: 1, compid: 1 })
    .encode('HEARTBEAT', { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 });
  conn._transport.emit('data', hb);

  /** Force the synchronous teardown to throw; close must still release the transport and finish. */
  const decoder = [...conn._decoders.values()][0];
  assert.ok(decoder, 'decoder exists before close');
  decoder.destroy = () => {
    throw new Error('decoder destroy blew up');
  };

  /** This await hangs the test (timeout) if done() is never called. */
  await RED.close(conn);
  assert.strictEqual(conn._transport, null, 'transport released despite the teardown throw');
  assert.ok(conn.errors.length >= 1, 'the swallowed teardown error is logged');
  t.diagnostic('connection closed cleanly after a throwing decoder.destroy');
});
