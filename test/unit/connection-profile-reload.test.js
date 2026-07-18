'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { nextEvent } = require('../helpers/next-event');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * Editing a profile's dialect and redeploying must update an already-running
 * connection, without restarting the transport.
 *
 * Node-RED recreates an edited profile config node but leaves an unchanged
 * connection node running. Before the fix the connection kept its stale profile
 * object, codec, per-profile codec cache, router default profile, and decoder —
 * all built from the pre-edit dialect — so a profile switched from `common` to
 * `development` still rejected message 441 (GNSS_INTEGRITY, defined only by the
 * development dialect) with "Unable to decode message id 441 with dialect
 * 'common'" until Node-RED was restarted. The connection now rebuilds all
 * profile-dependent state on flows:started.
 */

const GNSS_INTEGRITY_MSGID = 441;

/**
 * A GNSS_INTEGRITY (message id 441) frame from sysid 1. The message exists only
 * in the development dialect, so `common` cannot decode it but `development` can.
 *
 * @returns {Buffer} the encoded frame
 */
function gnssIntegrityFrame() {
  const dev = loadDialect('development');
  const codec = new MavlinkCodec({ bundle: dev, version: 'v2' });
  return enc(codec, 'GNSS_INTEGRITY', {}, { sysid: 1, compid: 1 });
}

test('editing a profile dialect updates a running connection on redeploy (message 441)', async (t) => {
  const RED = new MockRED().loadNodes();

  /** Start on `common`. */
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  const frame = gnssIntegrityFrame();

  /**
   * With the common profile, message 441 cannot be decoded: expect a structured
   * decode error naming the common dialect.
   */
  const errPromise = nextEvent(conn.emitter, 'decodeError');
  conn._transport.emit('data', frame);
  const decodeError = await errPromise;
  assert.strictEqual(decodeError.payload.code, 'DECODE_FAILED');
  assert.strictEqual(decodeError.payload.context.msgid, GNSS_INTEGRITY_MSGID);
  assert.strictEqual(decodeError.payload.context.dialect, 'common');

  /**
   * Change the profile's dialect to `development` and redeploy. Node-RED
   * recreates the profile config node under the same id; the connection node is
   * left running (its own config is unchanged).
   */
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'development', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');

  /** The connection must now hold the new profile without a transport restart. */
  assert.strictEqual(conn.profile.dialect, 'development');
  assert.strictEqual(conn.profile, RED.nodes.getNode('p1'));

  /**
   * The same message 441 now decodes as GNSS_INTEGRITY via the development
   * dialect — no Node-RED restart required.
   */
  const msgPromise = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', gnssIntegrityFrame());
  const message = await msgPromise;
  assert.strictEqual(message.payload.name, 'GNSS_INTEGRITY');
  assert.strictEqual(message.payload.id, GNSS_INTEGRITY_MSGID);
  assert.strictEqual(message.payload.profile, 'Vehicle');
});

test('an edited default profile that is now invalid fails the connection closed and releases the transport (#116)', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  const transport = conn._transport;

  /**
   * Redeploy the profile under the same id with an unloadable dialect. A required
   * default profile that becomes invalid must NOT keep running on the stale
   * dialect (#116): the connection fails closed and releases the socket.
   */
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'nonexistent-dialect', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  assert.strictEqual(RED.nodes.getNode('p1').isValid(), false);
  RED.events.emit('flows:started');
  await conn._deactivating;

  /**
   * The connection is inactive, the decoder is gone, and the transport has been
   * stopped and released.
   */
  assert.strictEqual(conn._active, false);
  assert.strictEqual(conn._transport, null, 'transport was released');
  assert.strictEqual(conn._decoders.size, 0, 'decoders were destroyed');
  assert.strictEqual(transport.socket, null, 'UDP socket was closed');
  assert.strictEqual(conn.statusState, 'error');
  const logged = conn.errors.map(String).join('\n');
  assert.match(logged, /PROFILE_INVALID/);
  assert.match(logged, /deactivated and transport released/);

  /** New sends reject with the structured deactivation error, not a generic miss. */
  await assert.rejects(
    conn.send({ name: 'HEARTBEAT', fields: {} }),
    (err) => err.code === 'PROFILE_INVALID'
  );
});

test('deleting the default profile deactivates the connection and releases the transport (#116)', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  const transport = conn._transport;

  /**
   * Delete the profile config node (Node-RED removes it from the registry) and
   * redeploy. The connection node itself is unchanged, so it is left running — it
   * must notice the missing required profile and fail closed (#116).
   */
  RED.remove('p1');
  assert.strictEqual(RED.nodes.getNode('p1'), null);
  RED.events.emit('flows:started');
  await conn._deactivating;

  assert.strictEqual(conn._active, false);
  assert.strictEqual(conn._transport, null, 'transport was released');
  assert.strictEqual(transport.socket, null, 'UDP socket was closed');
  const logged = conn.errors.map(String).join('\n');
  assert.match(logged, /NO_PROFILE/);

  await assert.rejects(
    conn.send({ name: 'HEARTBEAT', fields: {} }),
    (err) => err.code === 'NO_PROFILE'
  );
});

test('restoring a valid default profile reactivates a deactivated connection (#116)', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  /** Delete the profile -> deactivate. */
  RED.remove('p1');
  RED.events.emit('flows:started');
  await conn._deactivating;
  assert.strictEqual(conn._active, false);

  /** Re-create the profile under the same id on a later deploy -> reactivate. */
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'development', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');
  /**
   * Reactivation restarts the transport after any pending teardown resolves;
   * await the connection's own activation signal rather than guessing at ticks.
   */
  await conn._activating;

  assert.strictEqual(conn._active, true);
  assert.strictEqual(conn.profile, RED.nodes.getNode('p1'));
  assert.strictEqual(conn.profile.dialect, 'development');
  assert.ok(conn._transport, 'transport was restarted');

  /**
   * The reactivated connection decodes with the restored dialect: message 441 is
   * defined only by `development`, so it now decodes instead of erroring.
   */
  const msgPromise = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', gnssIntegrityFrame());
  const message = await msgPromise;
  assert.strictEqual(message.payload.name, 'GNSS_INTEGRITY');
});

test('a connection CONSTRUCTED with a missing profile activates once the profile appears (#238)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  /**
   * The profile never existed at construction: before #238 this took the no-op
   * path, which never installed the flows:started reconcile — the connection
   * stayed permanently dead after the profile was created, until a manual
   * redeploy of the connection itself.
   */
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  assert.strictEqual(conn._active, false);
  assert.strictEqual(conn._transport, null, 'no transport while inactive');
  assert.match(conn.errors.map(String).join('\n'), /NO_PROFILE/);
  await assert.rejects(conn.send({ name: 'HEARTBEAT', fields: {} }), (e) => e.code === 'NO_PROFILE');

  /** The missing dependency is created on a later deploy -> reactivate in place. */
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');
  await conn._activating;

  assert.strictEqual(conn._active, true);
  assert.strictEqual(conn.profile, RED.nodes.getNode('p1'));
  assert.ok(conn._transport, 'transport started on activation');
  assert.strictEqual(conn._inactiveError, null, 'inactive reason cleared');
});

test('a connection CONSTRUCTED with a missing identity activates once the identity appears (#238)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  assert.strictEqual(conn._active, false);
  await assert.rejects(conn.send({ name: 'HEARTBEAT', fields: {} }), (e) => e.code === 'LOCAL_IDENTITY_REQUIRED');

  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  RED.events.emit('flows:started');
  await conn._activating;

  assert.strictEqual(conn._active, true);
  assert.strictEqual(conn.localIdentity, RED.nodes.getNode('id1'));
  assert.ok(conn._transport, 'transport started on activation');
  assert.strictEqual(conn._inactiveError, null, 'inactive reason cleared');
});

test('rebuilding the profile preserves the codec learned per-peer wire version (#69)', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'common', mavlinkVersion: 'auto',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  /**
   * The connection has learned that sysid 7 speaks MAVLink v1 (0xFE magic), so an
   * `auto` send to it is framed v1. Per-peer wire-version detection now lives on
   * the connection-owned LinkState (#192, #228), not on the dialect codec.
   */
  const oldCodec = conn._codec;
  const link = conn._link;
  link.noteInboundMagic(0xfe, 7);
  assert.strictEqual(link.effectiveVersion('auto', 7), 'v1');

  /** Edit the profile (still `auto`) and redeploy without a transport restart. */
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Vehicle', dialect: 'development', mavlinkVersion: 'auto',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');

  /**
   * The codec was rebuilt for the new dialect, but the LinkState deliberately
   * survives the profile edit (#192): it is the same instance and still holds
   * the learned per-peer version, so an immediate send to the v1-only peer is
   * still framed v1 — not reset to v2 until another inbound frame arrives.
   */
  assert.notStrictEqual(conn._codec, oldCodec, 'codec was rebuilt');
  assert.strictEqual(conn._link, link, 'LinkState survives the profile rebuild');
  assert.strictEqual(conn._link.effectiveVersion('auto', 7), 'v1');
});
