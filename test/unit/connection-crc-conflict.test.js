'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { MockRED } = require('../helpers/mock-red');

/**
 * Routed dialect CRC-extra conflict detection (#86). A routed connection
 * merges every profile dialect's CRC table into one splitter table; two
 * profiles defining the same message id with different CRC extras cannot
 * share a splitter, and the connection must fail that configuration loudly
 * instead of silently keeping the first value.
 */

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'dialects');

function setup(routeProfiles) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p_default',
    name: 'Default',
    dialect: 'common',
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p_custom',
    name: 'Custom',
    dialect: 'custom',
    customDialectPath: path.join(FIXTURES, 'custom_addon.xml'),
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p_conflict',
    name: 'Conflict',
    dialect: 'custom',
    customDialectPath: path.join(FIXTURES, 'custom_vehicle_conflict.xml'),
  });
  // Another profile on the same dialect as the default: identical duplicate
  // CRC definitions, which must stay valid.
  RED.create('mavlink-ai-vehicle', {
    id: 'p_common2',
    name: 'Common2',
    dialect: 'common',
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1',
    name: 'Routed',
    profile: 'p_default',
    localIdentity: 'id1',
    transport: 'udp',
    routingMode: 'routed',
    unmatchedPolicy: 'default',
    routeTable: JSON.stringify(routeProfiles.map((profile, i) => ({ sysid: i + 1, compid: '*', profile }))),
    bindAddress: '127.0.0.1',
    bindPort: 0,
    reconnect: false,
    heartbeat: false
  });
  return { RED, conn };
}

test('identical duplicate CRC definitions across profiles are accepted (#86)', async (t) => {
  const { RED, conn } = setup(['p_common2', 'p_custom']);
  t.after(() => RED.close(conn));
  RED.events.emit('flows:started');
  assert.notStrictEqual(conn.statusState, 'error', `status: ${conn.statusState} ${conn.statusDetail}`);
  assert.strictEqual(conn.errors.length, 0, JSON.stringify(conn.errors));
});

test('conflicting CRC extras for one message id fail the configuration (#86)', async (t) => {
  const { RED, conn } = setup(['p_custom', 'p_conflict']);
  t.after(() => RED.close(conn));
  RED.events.emit('flows:started');
  assert.strictEqual(conn.statusState, 'error');
  const logged = conn.errors.map(String).join('\n');
  assert.match(logged, /ROUTE_TABLE_INVALID/);
  assert.match(logged, /message id 9100/);
  assert.match(logged, /Custom/);
  assert.match(logged, /Conflict/);
  assert.match(logged, /CRC extra/);
});

test('inbound data on a conflicted connection is refused, error emitted once (#86)', async (t) => {
  const { RED, conn } = setup(['p_custom', 'p_conflict']);
  t.after(() => RED.close(conn));
  const emitted = [];
  conn.emitter.on('error', (e) => emitted.push(e));
  const received = [];
  conn.subscribe({}, (m) => received.push(m));

  // Push raw bytes at the transport layer: the decoder is built lazily on
  // first data, which is where the merged table conflict must fail closed.
  conn._transport.emit('data', Buffer.from([0xfd, 0x00, 0x00]));
  conn._transport.emit('data', Buffer.from([0xfd, 0x00, 0x00]));

  const conflictErrors = emitted.filter((e) => e.code === 'DIALECT_CRC_CONFLICT');
  assert.strictEqual(conflictErrors.length, 1, 'conflict surfaced exactly once, not per datagram');
  assert.match(conflictErrors[0].message, /message id 9100/);
  assert.strictEqual(conn.statusState, 'error');
  assert.strictEqual(received.length, 0, 'no packets were distributed');
});
