'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * End-to-end #199 acceptance: on one udp connection serving a mixed fleet —
 * a v1-only vehicle and a v2 vehicle on separate endpoints — a broadcast is
 * encoded per version group and each peer receives ONLY frames of its own
 * wire version. Before the fix a single buffer (framed as whichever version
 * spoke last) was fanned to both, so one group always got frames it silently
 * ignores.
 */

const HEARTBEAT = { type: 'MAV_TYPE_QUADROTOR', autopilot: 'MAV_AUTOPILOT_ARDUPILOTMEGA', base_mode: 0, custom_mode: 0, system_status: 'MAV_STATE_ACTIVE' };

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** Poll until cond() is true or time out. */
const waitFor = async (cond, label, timeoutMs = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout: ${label}`);
    }
    await tick(25);
  }
};

test('a broadcast reaches each mixed-fleet peer in its own wire version (#199)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', dialect: 'common', mavlinkVersion: 'auto',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const bundle = loadDialect('common');
  const v1codec = new MavlinkCodec({ bundle, version: 'v1' });
  const v2codec = new MavlinkCodec({ bundle, version: 'v2' });

  /** Two peers on separate sockets so each sysid learns its own endpoint. */
  const v1sock = dgram.createSocket('udp4');
  const v2sock = dgram.createSocket('udp4');
  await new Promise((r) => v1sock.bind(0, '127.0.0.1', r));
  await new Promise((r) => v2sock.bind(0, '127.0.0.1', r));
  const v1got = [];
  const v2got = [];
  v1sock.on('message', (m) => v1got.push(m));
  v2sock.on('message', (m) => v2got.push(m));
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => v1sock.close(r));
    await new Promise((r) => v2sock.close(r));
  });

  /** Teach the connection both peers (endpoint + wire version), with UDP-loss retry. */
  const teach = () => {
    v1sock.send(enc(v1codec, 'HEARTBEAT', HEARTBEAT, { sysid: 3, compid: 1 }), port, '127.0.0.1');
    v2sock.send(enc(v2codec, 'HEARTBEAT', HEARTBEAT, { sysid: 4, compid: 1 }), port, '127.0.0.1');
  };
  teach();
  const learning = setInterval(teach, 200);
  try {
    await waitFor(
      () => conn._transport.peersBySysid.has(3) && conn._transport.peersBySysid.has(4),
      'both peers learned'
    );
  } finally {
    clearInterval(learning);
  }

  /** Broadcast through the real queue and transport, with UDP-loss retry. */
  const broadcast = () => conn.send({ name: 'HEARTBEAT', fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 } });
  await broadcast();
  const rebroadcast = setInterval(broadcast, 200);
  try {
    await waitFor(() => v1got.length > 0 && v2got.length > 0, 'both peers received the broadcast');
  } finally {
    clearInterval(rebroadcast);
  }

  assert.ok(v1got.every((m) => m[0] === 0xfe), 'the v1 peer must receive only v1 (0xFE) frames');
  assert.ok(v2got.every((m) => m[0] === 0xfd), 'the v2 peer must receive only v2 (0xFD) frames');
});
