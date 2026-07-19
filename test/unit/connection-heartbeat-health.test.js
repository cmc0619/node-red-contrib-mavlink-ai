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

/**
 * Minimal identity stand-in with the methods the connection calls.
 *
 * @param {string} id
 * @param {boolean} [healthDriven=true]
 * @returns {object} identity stub
 */
function identity(id, healthDriven = true) {
  return { id, describe: () => id, getHeartbeatFields: () => ({ type: 'MAV_TYPE_ONBOARD_CONTROLLER', autopilot: 'MAV_AUTOPILOT_INVALID', base_mode: 0, custom_mode: 0, system_status: 'MAV_STATE_ACTIVE', mavlink_version: 3 }), healthDriven };
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
  // heartbeatSpecs() must schedule this identity for setAdvertisedHealth to
  // accept its assertion (#225 review: IDENTITY_NOT_HEALTH_DRIVEN). Set the
  // flag directly rather than via config so no live setInterval starts —
  // startHeartbeats() already ran (with heartbeating off) during
  // construction; heartbeatSpecs() re-reads this property live on every call.
  conn.heartbeatEnabled = true;
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
  // Deliberately NOT scheduled/health-driven here: normalizeAssertion runs
  // before the eligibility check, so a malformed assertion must still fail
  // INVALID_HEALTH first regardless of whether this identity is scheduled.
  assert.throws(() => conn.setAdvertisedHealth(undefined, { health: 'nominal' }), (e) => e.code === 'INVALID_HEALTH');
});

test('setAdvertisedHealth rejects an identity that is not health-driven and heartbeat-scheduled', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === def.id ? def : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());

  // Case 1: healthDriven but never scheduled (heartbeatEnabled left off, and
  // this identity has no additional binding) — heartbeatSpecs() is empty, so
  // no tick will ever read the record.
  assert.throws(
    () => conn.setAdvertisedHealth(undefined, { health: 'degraded', ttl_s: 10 }),
    (e) => e.code === 'IDENTITY_NOT_HEALTH_DRIVEN',
    'not scheduled -> IDENTITY_NOT_HEALTH_DRIVEN'
  );
  assert.strictEqual(conn._advertisedHealth.has(def.id), false, 'a rejected assertion must not be stored');

  // Case 2: scheduled but healthDriven: false — the tick would ignore the
  // record even though a tick runs for this identity.
  conn.heartbeatEnabled = true;
  const notDriven = identity('id-static', false);
  conn.localIdentity = notDriven;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === notDriven.id ? notDriven : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());
  assert.throws(
    () => conn.setAdvertisedHealth(undefined, { health: 'degraded', ttl_s: 10 }),
    (e) => e.code === 'IDENTITY_NOT_HEALTH_DRIVEN',
    'scheduled but not healthDriven -> IDENTITY_NOT_HEALTH_DRIVEN'
  );
  assert.strictEqual(conn._advertisedHealth.has(notDriven.id), false, 'a rejected assertion must not be stored');
});

/**
 * The heartbeat tick's health-driven decision (#225), tested via the
 * `_heartbeatFieldsFor` seam rather than driving a live setInterval tick —
 * see the tick refactor in nodes/mavlink-ai-connection.js. Covers the three
 * required outcomes for a health-driven identity: no assertion -> STANDBY,
 * degraded -> CRITICAL, fatal -> no-send (null fields).
 */
test('a health-driven identity stamps the mapped system_status and stops on fatal', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.heartbeatEnabled = true;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === def.id ? def : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());

  // 1. no assertion -> MAV_STATE_STANDBY
  let fields = conn._heartbeatFieldsFor(def, Date.now());
  assert.strictEqual(fields.system_status, 'MAV_STATE_STANDBY');

  // 2. degraded assertion -> MAV_STATE_CRITICAL
  conn.setAdvertisedHealth(undefined, { health: 'degraded', ttl_s: 10 });
  fields = conn._heartbeatFieldsFor(def, Date.now());
  assert.strictEqual(fields.system_status, 'MAV_STATE_CRITICAL');

  // 3. fatal assertion -> no frame this tick
  conn.setAdvertisedHealth(undefined, { health: 'fatal' });
  fields = conn._heartbeatFieldsFor(def, Date.now());
  assert.strictEqual(fields, null);
});

test('a non-health-driven identity still yields the static MAV_STATE_ACTIVE (regression guard)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const gcs = identity('id-gcs', false);
  const fields = conn._heartbeatFieldsFor(gcs, Date.now());
  assert.strictEqual(fields.system_status, 'MAV_STATE_ACTIVE');
});

/**
 * Review finding (#225 review): a fatal assertion must not permanently wedge
 * a health-driven identity's heartbeat — a fresh non-fatal assertion after a
 * fatal one must resume sending with a mapped `system_status`. This is the
 * highlighted failure mode: `_heartbeatFieldsFor` is pure (no `node.status`
 * side effect) and must recompute cleanly from the latest stored record on
 * every call, not latch on the earlier `null`.
 */
test('a non-fatal assertion after fatal recovers the heartbeat (no permanent stop)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.heartbeatEnabled = true;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === def.id ? def : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());

  conn.setAdvertisedHealth(undefined, { health: 'fatal' });
  assert.strictEqual(conn._heartbeatFieldsFor(def, Date.now()), null);

  conn.setAdvertisedHealth(undefined, { health: 'nominal', ttl_s: 10 });
  const fields = conn._heartbeatFieldsFor(def, Date.now());
  assert.notStrictEqual(fields, null);
  assert.strictEqual(fields.system_status, 'MAV_STATE_ACTIVE');
});

/**
 * Expiry through the tick seam (#225 review): a non-fatal assertion whose
 * `ttl_s` has elapsed by the tick's `now` must fall back to
 * `MAV_STATE_CRITICAL` — an expired lease must never keep reporting the
 * asserted (possibly stale) state as if it were still current.
 */
test('an expired non-fatal assertion reports MAV_STATE_CRITICAL', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.heartbeatEnabled = true;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === def.id ? def : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());

  conn.setAdvertisedHealth(undefined, { health: 'nominal', ttl_s: 1 });
  const past = Date.now() + 5000;
  const fields = conn._heartbeatFieldsFor(def, past);
  assert.strictEqual(fields.system_status, 'MAV_STATE_CRITICAL');
});

/**
 * Edge-triggered warn (#225 review): the tick surfaces the fatal-stop and its
 * recovery via `node.warn` — not `node.status(...)`, since this config node
 * has no canvas badge — exactly once per transition, never once per tick.
 * Driven directly at the `node._handleHeartbeatHealthEdge(identity, fields)`
 * seam the tick calls with its `_heartbeatFieldsFor` result, avoiding a flaky
 * dependency on the live `setInterval` tick.
 */
test('_handleHeartbeatHealthEdge warns once entering fatal and once on recovery, not per tick', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');

  // Three consecutive fatal ticks -> exactly one "asserted FATAL" warning.
  conn._handleHeartbeatHealthEdge(def, null);
  conn._handleHeartbeatHealthEdge(def, null);
  conn._handleHeartbeatHealthEdge(def, null);
  assert.strictEqual(conn.warnings.length, 1);
  assert.match(conn.warnings[0], /FATAL health/);

  // Three consecutive recovered ticks -> exactly one "recovered" warning.
  const recoveredFields = { system_status: 'MAV_STATE_ACTIVE' };
  conn._handleHeartbeatHealthEdge(def, recoveredFields);
  conn._handleHeartbeatHealthEdge(def, recoveredFields);
  conn._handleHeartbeatHealthEdge(def, recoveredFields);
  assert.strictEqual(conn.warnings.length, 2);
  assert.match(conn.warnings[1], /recovered/);

  // A second fatal transition re-warns (the edge fires again on re-entry).
  conn._handleHeartbeatHealthEdge(def, null);
  assert.strictEqual(conn.warnings.length, 3);
  assert.match(conn.warnings[2], /FATAL health/);
});

/**
 * Queued-heartbeat eviction on fatal (#225 review): the tick's `send()` call
 * (and the enqueue-time coalesce-drop inside it) is skipped entirely once
 * `_heartbeatFieldsFor` returns null for a fatal identity — so a heartbeat
 * from a *prior*, pre-fatal tick that is still sitting in the outbound queue
 * (e.g. backlogged behind a stalled transport) would otherwise survive fatal
 * and still be flushed. `node._heartbeatTick` must explicitly drop it via
 * `node._queue.dropCoalesced('heartbeat:<identity.id>')` before returning.
 * Driven at the `node._heartbeatTick(identity)` seam (mirroring
 * `_heartbeatFieldsFor` / `_handleHeartbeatHealthEdge` above) rather than a
 * live `setInterval`, and spying on `dropCoalesced` rather than exercising a
 * real `send()` keeps this deterministic and avoids a real transport write.
 */
test('a fatal tick evicts any already-queued heartbeat for that identity (#225 review)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = connection(RED);
  t.after(() => RED.close(conn));
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.heartbeatEnabled = true;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === def.id ? def : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());

  const dropCalls = [];
  conn._queue.dropCoalesced = (key) => {
    dropCalls.push(key);
    return 0;
  };

  conn.setAdvertisedHealth(undefined, { health: 'fatal' });
  conn._heartbeatTick(def);

  assert.deepStrictEqual(
    dropCalls,
    [`heartbeat:${def.id}`],
    'a fatal tick must evict any queued heartbeat carrying this identity\'s coalesce key'
  );
});
