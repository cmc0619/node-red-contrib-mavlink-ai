'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * setAdvertisedHealth (#225). A minimal `{ id: 'c1' }` config never reaches
 * setAdvertisedHealth's definition — an invalid/missing transport config
 * trips the deploy-time TRANSPORT_CONFIG_INVALID no-op path (see
 * connection-transport-validation.test.js) before the local-identity helpers
 * are installed. So, mirroring the profile/identity/transport scaffolding
 * from connection-status-detail.test.js, these tests build a fully-active
 * connection (real UDP transport, ephemeral bind, no reconnect/heartbeat)
 * and then stub `resolveLocalIdentity`/`localIdentity` as the task brief's
 * tests do, to drive `setAdvertisedHealth` deterministically without
 * depending on identity-binding config.
 */

/** Minimal identity stand-in with the methods the connection calls. */
function identity(id) {
  return { id, describe: () => id, getHeartbeatFields: () => ({ type: 'MAV_TYPE_ONBOARD_CONTROLLER', autopilot: 'MAV_AUTOPILOT_INVALID', base_mode: 0, custom_mode: 0, system_status: 'MAV_STATE_ACTIVE', mavlink_version: 3 }), healthDriven: true };
}

/**
 * Build a fully-active connection node with the profile/identity/transport
 * scaffolding the config requires to construct past deploy-time validation.
 *
 * @param {MockRED} RED  the mock runtime
 * @returns {object} the connection node
 */
function connection(RED) {
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Conn', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  RED.events.emit('flows:started');
  return conn;
}

test('setAdvertisedHealth stores a normalized record for the default identity', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === def.id ? def : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());
  const rec = conn.setAdvertisedHealth(undefined, { health: 'degraded', ttl_s: 10, note: 'watchdog' });
  assert.strictEqual(rec.state, 'degraded');
  assert.strictEqual(conn._advertisedHealth.get('id-default').state, 'degraded');
});

test('setAdvertisedHealth rejects an unknown identity ref', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  conn.localIdentity = identity('id-default');
  conn.resolveLocalIdentity = () => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; };
  assert.throws(() => conn.setAdvertisedHealth('ghost', { health: 'nominal', ttl_s: 5 }), (e) => e.code === 'UNKNOWN_IDENTITY');
});

test('setAdvertisedHealth propagates the INVALID_HEALTH validation error', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.resolveLocalIdentity = () => def;
  assert.throws(() => conn.setAdvertisedHealth(undefined, { health: 'nominal' }), (e) => e.code === 'INVALID_HEALTH');
});
