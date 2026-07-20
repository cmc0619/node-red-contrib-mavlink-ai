'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { makeConnection, makeIdentity } = require('../helpers/v3-config');
const { badgeForState } = require('../../lib/util/status');

/**
 * The Disabled checkbox is a deploy-time kill switch — the config-node analog
 * of Node-RED's node enable/disable, which does not apply to config nodes. A
 * disabled connection parks in the same DEACTIVATED state a missing dependency
 * produces: no transport, no heartbeat, sends rejected, and a distinct grey
 * 'disabled' status (not an error).
 */

test('a disabled connection opens no transport and starts no heartbeat', (t) => {
  const RED = new MockRED().loadNodes();
  // heartbeat: true proves the disable wins even with heartbeats configured.
  const { connection } = makeConnection(RED, { disabled: true, heartbeat: true });
  t.after(() => RED.close(connection));
  RED.events.emit('flows:started');

  assert.strictEqual(connection.disabled, true);
  assert.strictEqual(connection._active, false);
  assert.ok(!connection._transport, 'no transport is created'); // never bound
  assert.strictEqual(connection._heartbeatTimers.size, 0, 'no heartbeat scheduled');
  assert.strictEqual(connection.statusState, 'disabled'); // grey, not error
});

test('a disabled connection rejects sends with a DISABLED error', async (t) => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, { disabled: true });
  t.after(() => RED.close(connection));

  await assert.rejects(
    () => connection.send({ name: 'HEARTBEAT', fields: {} }),
    (err) => err.code === 'DISABLED' && /disabled/i.test(err.message)
  );
});

test('a flows:started reconcile does not revive a disabled connection', (t) => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, { disabled: true });
  t.after(() => RED.close(connection));

  // A redeploy reconcile must leave a disabled connection parked, never
  // reactivate it or re-badge it as a dependency error.
  RED.events.emit('flows:started');
  RED.events.emit('flows:started');

  assert.strictEqual(connection._active, false);
  assert.ok(!connection._transport);
  assert.strictEqual(connection.statusState, 'disabled');
});

test('an enabled connection is unaffected (control)', (t) => {
  const RED = new MockRED().loadNodes();
  const { connection } = makeConnection(RED, { disabled: false });
  t.after(() => RED.close(connection));

  assert.strictEqual(connection.disabled, false);
  assert.strictEqual(connection._active, true);
  assert.ok(connection._transport, 'transport is created when enabled');
});

test('disabled wins over a missing profile — grey, not a red NO_PROFILE, no error log', (t) => {
  const RED = new MockRED().loadNodes();
  const identity = makeIdentity(RED);
  // Disabled AND no Vehicle Profile: the disable must win — the operator turned
  // it off, so it should not nag NO_PROFILE (grey badge, DISABLED rejection, and
  // no fatal()/node.error() noise).
  const connection = RED.create('mavlink-ai-connection', {
    id: 'c-dis', name: 'Conn', profile: '', localIdentity: identity.id,
    disabled: true, transport: 'udp', bindAddress: '127.0.0.1', bindPort: 0,
    reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(connection));

  assert.strictEqual(connection.statusState, 'disabled');
  assert.strictEqual(connection._inactiveError.code, 'DISABLED');
  assert.strictEqual(connection.errors.length, 0, 'no NO_PROFILE error is logged');
});

test('disabled wins over an invalid transport config — grey, not a red error, no error log', (t) => {
  const RED = new MockRED().loadNodes();
  // Disabled AND a broken transport (TCP with neither a remote pair nor a bind
  // port — no role at all): the go-live gate never runs, so the transport-config
  // validation must not trip registerNoop and log TRANSPORT_CONFIG_INVALID — the
  // node parks grey.
  const { connection } = makeConnection(RED, {
    disabled: true, transport: 'tcp',
    bindPort: '', remoteHost: '', remotePort: ''
  });
  t.after(() => RED.close(connection));

  assert.strictEqual(connection.statusState, 'disabled');
  assert.strictEqual(connection._inactiveError.code, 'DISABLED');
  assert.strictEqual(connection.errors.length, 0, 'no TRANSPORT_CONFIG_INVALID error is logged');
});

test('disabled wins over invalid additionalIdentities — grey, not a red error, no error log', (t) => {
  const RED = new MockRED().loadNodes();
  // Disabled AND malformed additionalIdentities JSON: the go-live gate never
  // runs, so parseIdentityBindings' throw must not trip registerNoop and log
  // ADDITIONAL_IDENTITIES_INVALID — the node parks grey.
  const { connection } = makeConnection(RED, {
    disabled: true, additionalIdentities: '{ not valid json'
  });
  t.after(() => RED.close(connection));

  assert.strictEqual(connection.statusState, 'disabled');
  assert.strictEqual(connection._inactiveError.code, 'DISABLED');
  assert.strictEqual(connection.errors.length, 0, 'no ADDITIONAL_IDENTITIES_INVALID error is logged');
});

test('badgeForState maps disabled to a grey badge', () => {
  const badge = badgeForState('disabled', 'disabled');
  assert.strictEqual(badge.fill, 'grey');
  assert.strictEqual(badge.text, 'disabled');
});
