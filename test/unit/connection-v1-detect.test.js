'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * MAVLink v1 auto-detection through the connection path (#138, #152). The dead
 * bug: onPacket read the peer's wire version from packet.header.magic, which
 * node-mavlink's v1 parser never sets (it stays 0), so a v1-only vehicle was
 * never detected as v1 and every outbound frame stayed v2 (0xFD) — which the
 * vehicle silently ignores. onPacket now reads the actual first frame byte.
 *
 * This drives a real parsed v1 frame through the connection (not a literal
 * 0xFE into noteInboundMagic, which is exactly where the bug hid), then asserts
 * a send to that peer is framed as v1.
 */

const HB = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
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
  const sent = [];
  conn._queue = {
    enqueue(buffer, priority, meta) {
      sent.push({ buffer, meta });
      return Promise.resolve();
    },
    clear() {}
  };
  return { RED, conn, sent };
}

test('a real inbound v1 frame flips outbound framing to that peer to v1 (#138, #152)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));

  const peer = new MavlinkCodec({ bundle: loadDialect('common'), version: 'v1' });
  const v1hb = enc(peer, 'HEARTBEAT', HB, { sysid: 3, compid: 1 });
  assert.strictEqual(v1hb[0], 0xfe);

  /** Before any inbound: an "auto" connection frames outbound as v2. */
  await conn.send({ name: 'COMMAND_LONG', target_system: 3, target_component: 1, fields: { command: 400, param1: 1 } });
  assert.strictEqual(sent[0].buffer[0], 0xfd, 'v2 until the peer is heard from');

  /** Drive the real v1 frame through the connection's decoder + onPacket. */
  conn._transport.emit('data', v1hb);
  await delay(10);

  await conn.send({ name: 'COMMAND_LONG', target_system: 3, target_component: 1, fields: { command: 400, param1: 1 } });
  assert.strictEqual(sent[1].buffer[0], 0xfe, 'outbound to the v1 peer must now be framed as v1');
});
