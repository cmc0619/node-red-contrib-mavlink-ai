'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * Per-profile protocol debug (Vehicle Profile > Advanced > Debug). When a
 * matched (inbound) or outbound Vehicle Profile has `debugProtocol` enabled, the
 * connection logs a one-line summary of each message decoded as / sent under it;
 * when disabled it logs nothing on the traffic path.
 */

const HB = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(debugProtocol) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'DbgVeh', dialect: 'common', mavlinkVersion: 'auto',
    defaultTargetSystem: 3, defaultTargetComponent: 1, debugProtocol
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp-peer',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  /**
   * Stub the queue but honor the onWrite hook so a "successful write" fires the
   * debug trace, exactly as the real OutboundQueue does on an actual transport write.
   */
  conn._queue = {
    enqueue(buffer, priority, meta, opts) {
      if (opts && typeof opts.onWrite === 'function') {
        opts.onWrite();
      }
      return Promise.resolve();
    },
    clear() {}
  };
  const logs = [];
  conn.log = (m) => logs.push(String(m));
  return { RED, conn, logs };
}

test('a debug-enabled profile logs inbound and outbound protocol traffic', async (t) => {
  const { RED, conn, logs } = setup(true);
  t.after(() => RED.close(conn));

  await conn.send({ name: 'COMMAND_LONG', target_system: 3, target_component: 1, fields: { command: 400, param1: 1 } });
  await conn.send({ name: 'HEARTBEAT', fields: HB });
  const peer = new MavlinkCodec({ bundle: loadDialect('common'), version: 'v2' });
  conn._transport.emit('data', enc(peer, 'HEARTBEAT', HB, { sysid: 3, compid: 1 }));
  await delay(10);

  const sent = logs.find((l) => /send COMMAND_LONG to sysid=3 compid=1/.test(l));
  const recv = logs.find((l) => /recv HEARTBEAT from sysid=3 compid=1/.test(l));
  const bcast = logs.find((l) => /send HEARTBEAT \(broadcast\)/.test(l));
  assert.ok(sent, `expected an addressed outbound debug line, got: ${JSON.stringify(logs)}`);
  assert.ok(recv, `expected an inbound debug line, got: ${JSON.stringify(logs)}`);
  assert.ok(bcast, `an unaddressed send must log as broadcast, not a default target: ${JSON.stringify(logs)}`);
  assert.match(sent, /\[DbgVeh\]/);
});

test('a failed outbound enqueue logs no phantom send', async (t) => {
  const { RED, conn, logs } = setup(true);
  t.after(() => RED.close(conn));
  conn._queue = { enqueue() { return Promise.reject(new Error('QUEUE_FULL')); }, clear() {} };

  await conn
    .send({ name: 'COMMAND_LONG', target_system: 3, target_component: 1, fields: { command: 400, param1: 1 } })
    .catch(() => {});
  await delay(10);

  assert.deepStrictEqual(logs.filter((l) => / send /.test(l)), []);
});

test('a debug-disabled profile logs no protocol traffic', async (t) => {
  const { RED, conn, logs } = setup(false);
  t.after(() => RED.close(conn));

  await conn.send({ name: 'COMMAND_LONG', target_system: 3, target_component: 1, fields: { command: 400, param1: 1 } });
  const peer = new MavlinkCodec({ bundle: loadDialect('common'), version: 'v2' });
  conn._transport.emit('data', enc(peer, 'HEARTBEAT', HB, { sysid: 3, compid: 1 }));
  await delay(10);

  assert.deepStrictEqual(logs.filter((l) => / recv | send /.test(l)), []);
});
