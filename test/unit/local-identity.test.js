'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { makeIdentity, makeProfile, makeConnection } = require('../helpers/v3-config');

/**
 * Outbound Local Identity resolution and the multi-identity binding rules
 * (issue #228). A connection references exactly one required default identity;
 * additional identities transmit only through explicit, disabled-by-default
 * bindings. Every case that is missing, ambiguous, unattached, colliding, or
 * disabled must fail closed with an actionable code.
 *
 * A valid connection opens a real (ephemeral) UDP socket, so every test closes
 * its connection(s) via t.after so `node --test` doesn't hang on an open handle.
 */

// --- default identity -------------------------------------------------------
test('a message with no identity override uses the connection default (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  const { connection, identity } = makeConnection(RED, {}, {
    identityConfig: { sourceSystemId: 255, sourceComponentId: 190 }
  });
  t.after(() => RED.close(connection));
  const resolved = connection.resolveOutboundIdentity(undefined);
  assert.strictEqual(resolved, identity);
  assert.deepStrictEqual(resolved.getIdentity(), { sysid: 255, compid: 190 });
});

test('the default identity is always attached even with multi-identity disabled (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  const { connection, identity } = makeConnection(RED, {});
  t.after(() => RED.close(connection));
  // Requesting the default explicitly (by id) is fine without multi-identity.
  assert.strictEqual(connection.resolveOutboundIdentity(identity.id), identity);
});

// --- explicit override, multi-identity DISABLED -----------------------------
test('requesting a non-default identity with multi-identity disabled fails closed (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  makeIdentity(RED, { id: 'companion', name: 'Companion', role: 'companion' });
  const { connection } = makeConnection(RED, {}, { identityConfig: { id: 'gcs', name: 'GCS' } });
  t.after(() => RED.close(connection));
  assert.throws(
    () => connection.resolveOutboundIdentity('companion'),
    (e) => e.code === 'MULTI_IDENTITY_DISABLED'
  );
});

// --- explicit override, multi-identity ENABLED ------------------------------
test('an attached additional identity resolves when multi-identity is enabled (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  makeIdentity(RED, { id: 'gcs', name: 'GCS', sourceSystemId: 255, sourceComponentId: 190 });
  const companion = makeIdentity(RED, { id: 'companion', name: 'Companion', role: 'companion', sourceSystemId: 1, sourceComponentId: 191 });
  const { connection } = makeConnection(RED, {
    localIdentity: 'gcs',
    allowMultipleIdentities: true,
    additionalIdentities: JSON.stringify([{ identity: 'companion', allowOutbound: true }])
  });
  t.after(() => RED.close(connection));
  assert.strictEqual(connection.resolveOutboundIdentity('companion'), companion);
});

test('a non-attached identity fails closed even with multi-identity enabled (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  makeIdentity(RED, { id: 'gcs', name: 'GCS' });
  makeIdentity(RED, { id: 'stranger', name: 'Stranger', sourceSystemId: 7, sourceComponentId: 7 });
  const { connection } = makeConnection(RED, {
    localIdentity: 'gcs',
    allowMultipleIdentities: true,
    additionalIdentities: JSON.stringify([])
  });
  t.after(() => RED.close(connection));
  assert.throws(
    () => connection.resolveOutboundIdentity('stranger'),
    (e) => e.code === 'LOCAL_IDENTITY_NOT_ATTACHED'
  );
});

test('an attached identity with outbound disabled cannot transmit (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  makeIdentity(RED, { id: 'gcs', name: 'GCS' });
  makeIdentity(RED, { id: 'listener', name: 'Listener', sourceSystemId: 9, sourceComponentId: 9 });
  const { connection } = makeConnection(RED, {
    localIdentity: 'gcs',
    allowMultipleIdentities: true,
    additionalIdentities: JSON.stringify([{ identity: 'listener', allowOutbound: false }])
  });
  t.after(() => RED.close(connection));
  assert.throws(
    () => connection.resolveOutboundIdentity('listener'),
    (e) => e.code === 'LOCAL_IDENTITY_NOT_ATTACHED'
  );
});

// --- unresolved -------------------------------------------------------------
test('an unresolvable Local Identity reference fails with LOCAL_IDENTITY_UNRESOLVED (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, { allowMultipleIdentities: true });
  t.after(() => RED.close(connection));
  assert.throws(
    () => connection.resolveOutboundIdentity('no-such-identity'),
    (e) => e.code === 'LOCAL_IDENTITY_UNRESOLVED'
  );
});

// --- collision --------------------------------------------------------------
test('two attached identities sharing a source (sysid, compid) fail closed at deploy (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  makeIdentity(RED, { id: 'gcs', name: 'GCS', sourceSystemId: 1, sourceComponentId: 191 });
  makeIdentity(RED, { id: 'twin', name: 'Twin', sourceSystemId: 1, sourceComponentId: 191 });
  const { connection } = makeConnection(RED, {
    id: 'c-collide',
    localIdentity: 'gcs',
    allowMultipleIdentities: true,
    additionalIdentities: JSON.stringify([{ identity: 'twin', allowOutbound: true }])
  });
  t.after(() => RED.close(connection));
  // A collision fails the connection closed at construction (no socket opened).
  assert.ok(
    connection.errors.some((e) => /LOCAL_IDENTITY_COLLISION/.test(String(e))),
    `expected a collision error, got ${JSON.stringify(connection.errors)}`
  );
});

// --- vehicle profile never selects identity ---------------------------------
test('the Vehicle Profile never determines the outbound identity (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  makeProfile(RED, { id: 'p1', dialect: 'common', mavlinkVersion: 'v2' });
  makeIdentity(RED, { id: 'gcs', name: 'GCS', sourceSystemId: 250, sourceComponentId: 5 });
  const { connection } = makeConnection(RED, { id: 'c1', profile: 'p1', localIdentity: 'gcs' });
  t.after(() => RED.close(connection));
  const sent = [];
  connection._queue = { enqueue(buffer, priority, meta) { sent.push({ buffer, meta }); return Promise.resolve(); }, clear() {} };
  // Send with the vehicle profile named — the source identity must still be the
  // connection's default identity (250/5), never anything derived from the profile.
  await connection.send({
    name: 'HEARTBEAT',
    vehicleProfile: 'p1',
    fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 }
  });
  const frame = sent[0].buffer;
  // v2 frame header: [magic, len, incompat, compat, seq, sysid, compid, ...]
  assert.strictEqual(frame[5], 250, 'source sysid comes from the Local Identity');
  assert.strictEqual(frame[6], 5, 'source compid comes from the Local Identity');
});

// --- two connections reuse one identity -------------------------------------
test('two connections can reuse one Local Identity (#228)', async (t) => {
  const RED = new MockRED().loadNodes();
  const identity = makeIdentity(RED, { id: 'shared', name: 'Shared GCS' });
  const a = makeConnection(RED, { id: 'ca', localIdentity: 'shared', bindPort: 0 });
  const b = makeConnection(RED, { id: 'cb', localIdentity: 'shared', bindPort: 0 });
  t.after(() => Promise.all([RED.close(a.connection), RED.close(b.connection)]));
  assert.strictEqual(a.connection.getDefaultIdentity(), identity);
  assert.strictEqual(b.connection.getDefaultIdentity(), identity);
});
