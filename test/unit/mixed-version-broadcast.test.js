'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { LinkState } = require('../../lib/protocol/link-state');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { UdpTransport } = require('../../lib/transport/udp-transport');
const { enc } = require('../helpers/v3-config');

/**
 * Mixed v1/v2 fleets: per-version broadcast encoding (#199).
 *
 * A broadcast/untargeted send used to be encoded ONCE (with the last-detected
 * wire version) and the identical buffer fanned to every learned peer — so on
 * a mixed fleet one version group always received frames it silently ignores
 * (a v1-only vehicle drops 0xFD frames). The connection now encodes one buffer
 * per detected version group and routes each to exactly that group's sysids;
 * a single-version fleet keeps the original one-encode path byte for byte.
 */

const HB = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('LinkState.mixedVersionGroups: null unless both versions are present', () => {
  const link = new LinkState();
  assert.strictEqual(link.mixedVersionGroups(), null, 'empty fleet');

  link.noteInboundMagic(0xfd, 3);
  link.noteInboundMagic(0xfd, 4);
  assert.strictEqual(link.mixedVersionGroups(), null, 'all-v2 fleet');

  link.noteInboundMagic(0xfe, 5);
  const groups = link.mixedVersionGroups();
  assert.deepStrictEqual(groups.v1.sort(), [5]);
  assert.deepStrictEqual(groups.v2.sort(), [3, 4]);

  /** A peer upgrading to v2 dissolves the mix. */
  link.noteInboundMagic(0xfd, 5);
  assert.strictEqual(link.mixedVersionGroups(), null, 'fleet converged on v2');
});

test('codec encode honors forceVersion over detected link state', () => {
  const codec = new MavlinkCodec({ bundle: loadDialect('common'), version: 'auto' });
  const link = new LinkState();
  /** Last inbound was v2; force v1 must still frame 0xFE, and vice versa. */
  link.noteInboundMagic(0xfd, 9);
  const v1 = codec.encode('HEARTBEAT', HB, { sysid: 255, compid: 190, link, forceVersion: 'v1' });
  assert.strictEqual(v1[0], 0xfe);
  link.noteInboundMagic(0xfe, 9);
  const v2 = codec.encode('HEARTBEAT', HB, { sysid: 255, compid: 190, link, forceVersion: 'v2' });
  assert.strictEqual(v2[0], 0xfd);
});

test('a broadcast on a mixed fleet enqueues one frame per version group with its sysids', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', dialect: 'common', mavlinkVersion: 'auto',
    defaultTargetSystem: 7, defaultTargetComponent: 3
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));
  const sent = [];
  conn._queue = {
    enqueue(buffer, priority, meta, opts) {
      sent.push({ buffer, meta, opts: opts || {} });
      return Promise.resolve();
    },
    clear() {}
  };

  /** Teach the link a v1 peer (sysid 3) and a v2 peer (sysid 4). */
  const v1peer = new MavlinkCodec({ bundle: loadDialect('common'), version: 'v1' });
  const v2peer = new MavlinkCodec({ bundle: loadDialect('common'), version: 'v2' });
  conn._transport.emit('data', enc(v1peer, 'HEARTBEAT', HB, { sysid: 3, compid: 1 }));
  conn._transport.emit('data', enc(v2peer, 'HEARTBEAT', HB, { sysid: 4, compid: 1 }));
  await delay(10);

  /** Untargeted HEARTBEAT: one frame per version group. */
  await conn.send({ name: 'HEARTBEAT', fields: HB }, { coalesceKey: 'heartbeat:id1' });
  assert.strictEqual(sent.length, 2, 'one enqueue per version group');
  const v1send = sent.find((s) => s.buffer[0] === 0xfe);
  const v2send = sent.find((s) => s.buffer[0] === 0xfd);
  assert.ok(v1send, 'a v1-framed buffer for the v1 group');
  assert.ok(v2send, 'a v2-framed buffer for the v2 group');
  assert.deepStrictEqual(v1send.meta.sysids, [3]);
  assert.deepStrictEqual(v2send.meta.sysids, [4]);
  /** Version-distinct coalesce keys: the groups must not cancel each other. */
  assert.notStrictEqual(v1send.opts.coalesceKey, v2send.opts.coalesceKey);
  assert.match(String(v1send.opts.coalesceKey), /heartbeat:id1/);

  /** A targeted send is untouched: single frame, targeted meta. */
  sent.length = 0;
  await conn.send({ name: 'COMMAND_LONG', target_system: 3, target_component: 1, fields: { command: 400, param1: 1 } });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].buffer[0], 0xfe, 'targeted send frames per addressed peer');
  assert.strictEqual(sent[0].meta.targetSystem, 3);
});

test('a broadcast on a single-version fleet keeps the one-encode path', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', dialect: 'common', mavlinkVersion: 'auto',
    defaultTargetSystem: 7, defaultTargetComponent: 3
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));
  const sent = [];
  conn._queue = {
    enqueue(buffer, priority, meta, opts) {
      sent.push({ buffer, meta, opts: opts || {} });
      return Promise.resolve();
    },
    clear() {}
  };

  const v2peer = new MavlinkCodec({ bundle: loadDialect('common'), version: 'v2' });
  conn._transport.emit('data', enc(v2peer, 'HEARTBEAT', HB, { sysid: 3, compid: 1 }));
  conn._transport.emit('data', enc(v2peer, 'HEARTBEAT', HB, { sysid: 4, compid: 1 }));
  await delay(10);

  await conn.send({ name: 'HEARTBEAT', fields: HB }, { coalesceKey: 'heartbeat:id1' });
  assert.strictEqual(sent.length, 1, 'single-version fleet: one buffer, fanned by the transport');
  assert.strictEqual(sent[0].buffer[0], 0xfd);
  assert.strictEqual(sent[0].meta.sysids, undefined, 'no version-group targeting');
  assert.strictEqual(sent[0].opts.coalesceKey, 'heartbeat:id1', 'coalesce key unsuffixed');
});

test('udp _targets resolves meta.sysids to exactly those endpoints, deduped, unknowns skipped', () => {
  const transport = new UdpTransport({ bindAddress: '127.0.0.1', bindPort: 0 });
  transport.peersBySysid.set(3, { address: '10.0.0.3', port: 14550 });
  transport.peersBySysid.set(4, { address: '10.0.0.4', port: 14550 });
  /** sysid 5 shares 3's endpoint (two components behind one bridge). */
  transport.peersBySysid.set(5, { address: '10.0.0.3', port: 14550 });
  transport.learnedPeer = { address: '10.0.0.99', port: 14550 };

  const targets = transport._targets({ sysids: [3, 5, 42] });
  assert.deepStrictEqual(targets, [{ address: '10.0.0.3', port: 14550 }], 'deduped, unknown 42 skipped, no learnedPeer fallback');

  /** No member of the group is known: empty (send() surfaces UDP_NO_PEER). */
  assert.deepStrictEqual(transport._targets({ sysids: [42] }), []);

  /** A fixed remote destination still overrides everything. */
  transport.remoteHost = '192.168.1.20';
  transport.remotePort = 14550;
  assert.deepStrictEqual(transport._targets({ sysids: [3] }), [{ address: '192.168.1.20', port: 14550 }]);
});
