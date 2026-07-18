'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * Status detail for the transport lifecycle events. describeListening used to
 * ignore the transport's own listening/connected info and echo the node
 * config back: an ephemeral bind (port 0) reported "port 0" instead of the
 * actually assigned port, and udp-out — send-only, signalled by
 * `{ sending: true }` — claimed to be "Listening".
 */

/**
 * Build a started connection node with the profile/identity scaffolding the
 * config expects. Lifecycle events are then driven synthetically on the
 * transport so the scenarios are deterministic.
 *
 * @param {MockRED} RED  the mock runtime
 * @param {object} config  transport-specific connection config
 * @returns {object} the connection node
 */
function connection(RED, config) {
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', Object.assign({
    id: 'c1', name: 'Conn', profile: 'p1', localIdentity: 'id1',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  }, config));
  RED.events.emit('flows:started');
  return conn;
}

test('an ephemeral bind reports the assigned port from the transport, not the configured 0', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED, { transport: 'udp-peer' });
  t.after(() => RED.close(conn));

  conn._transport.emit('listening', { address: '127.0.0.1', family: 'IPv4', port: 45678 });

  assert.strictEqual(conn.statusState, 'listening');
  assert.strictEqual(conn.statusDetail, 'Listening on 127.0.0.1:45678');
});

test('udp-out reports its send target instead of a "Listening" it never does', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED, { transport: 'udp-out', remoteHost: '10.1.2.3', remotePort: 14550 });
  t.after(() => RED.close(conn));

  conn._transport.emit('listening', { sending: true });

  assert.strictEqual(conn.statusDetail, 'Sending to 10.1.2.3:14550');
});
