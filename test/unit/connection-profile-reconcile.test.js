'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { nextEvent } = require('../helpers/next-event');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

/**
 * Routed profiles (referenced from the connection's routeTable) and legacy
 * name-based references must reconcile on every deploy, without stale codecs,
 * stale CRC tables, or stale name-cache objects surviving a profile edit,
 * deletion, or recreation (#117, #118).
 *
 * Routed profiles are embedded in serialized routeTable JSON, so Node-RED never
 * sees them as config-node dependencies and never restarts the connection when
 * one changes — the connection must reconcile them itself on flows:started.
 */

const ardu = loadDialect('ardupilotmega');
const dev = loadDialect('development');

/**
 * An ATTITUDE (id 30, ardupilotmega/common) frame from `sysid`. The `minimal`
 * dialect has no ATTITUDE definition, so a system routed to a minimal profile
 * cannot decode it and raises a structured decode error — that difference is how
 * these tests prove which dialect a route actually used.
 *
 * @param {number} sysid  source system id to frame from
 * @returns {Buffer} the encoded frame
 */
function attitudeFrom(sysid) {
  const codec = new MavlinkCodec({ bundle: ardu, version: 'v2', sysid, compid: 1 });
  return codec.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 });
}

/**
 * A GNSS_INTEGRITY (id 441) frame from `sysid`. This message exists only in the
 * development dialect, so its CRC extra is absent from the merged splitter table
 * until a development profile is part of the effective routed set — it proves the
 * merged CRC table updated.
 *
 * @param {number} sysid  source system id to frame from
 * @returns {Buffer} the encoded frame
 */
function gnssIntegrityFrom(sysid) {
  const codec = new MavlinkCodec({ bundle: dev, version: 'v2', sysid, compid: 1 });
  return codec.encode('GNSS_INTEGRITY', {});
}

/**
 * Create a mavlink-ai-profile config node with the common identity fields.
 *
 * @param {MockRED} RED  the mock runtime
 * @param {string} id  config-node id
 * @param {string} name  display name
 * @param {string} dialect  dialect name
 * @param {object} [extra]  extra config overrides
 * @returns {object} the profile node
 */
function profile(RED, id, name, dialect, extra = {}) {
  return RED.create('mavlink-ai-profile', {
    id,
    name,
    profileType: 'gcs',
    dialect,
    mavlinkVersion: 'v2',
    sourceSystemId: 255,
    sourceComponentId: 190,
    defaultTargetSystem: 1,
    defaultTargetComponent: 1,
    ...extra
  });
}

/**
 * Build a routed connection whose default is `minimal` and whose route table
 * sends sysid 1 -> 'pa' and sysid 2 -> 'pb'. Both routed profiles start as
 * ardupilotmega so ATTITUDE (id 30) decodes and the merged CRC table knows id
 * 30 regardless of which route later changes dialect.
 *
 * @param {MockRED} RED  the mock runtime
 * @returns {object} the connection node
 */
function routedConnection(RED) {
  profile(RED, 'p_def', 'Def', 'minimal');
  profile(RED, 'pa', 'A', 'ardupilotmega');
  profile(RED, 'pb', 'B', 'ardupilotmega');
  return RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Routed', profile: 'p_def',
    transport: 'udp-peer', routingMode: 'routed', unmatchedPolicy: 'reject',
    routeTable: JSON.stringify([
      { sysid: 1, compid: '*', profile: 'pa' },
      { sysid: 2, compid: '*', profile: 'pb' }
    ]),
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
}

test('editing a routed profile dialect under the same id takes effect on deploy (#117)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = routedConnection(RED);
  t.after(() => RED.close(conn));

  /** sysid 1 routes to 'pa' (ardupilotmega): ATTITUDE decodes. */
  const first = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', attitudeFrom(1));
  assert.strictEqual((await first).payload.name, 'ATTITUDE');
  assert.strictEqual((await first).payload.profile, 'A');

  /**
   * Edit 'pa' to the minimal dialect (recreated object under the same id) and
   * redeploy. The connection is left running; it must drop the cached
   * ardupilotmega codec for 'pa' and decode with the new minimal dialect, which
   * has no ATTITUDE — so the same frame now raises a structured decode error.
   */
  profile(RED, 'pa', 'A', 'minimal');
  RED.events.emit('flows:started');

  const err = nextEvent(conn.emitter, 'decodeError');
  conn._transport.emit('data', attitudeFrom(1));
  const decodeError = await err;
  assert.strictEqual(decodeError.payload.context.dialect, 'minimal');
  assert.strictEqual(decodeError.payload.context.profile, 'A');
});

test('deleting a routed profile rejects its packets instead of using a stale codec (#117)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = routedConnection(RED);
  t.after(() => RED.close(conn));

  /** Prime the per-profile codec cache for 'pa' by decoding a packet. */
  const first = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', attitudeFrom(1));
  await first;
  assert.ok(conn._codecByProfile.has('pa'), 'codec cached for routed profile');

  /** Delete 'pa' and redeploy. Its route now resolves to nothing. */
  RED.remove('pa');
  RED.events.emit('flows:started');
  assert.ok(!conn._codecByProfile.has('pa'), 'stale codec evicted for deleted routed profile');

  /**
   * A packet for sysid 1 is rejected (route profile unresolved), never decoded
   * with the deleted profile's old codec or the default dialect.
   */
  const messages = [];
  conn.subscribe({}, (m) => messages.push(m));
  const rejected = nextEvent(conn.emitter, 'rejected');
  conn._transport.emit('data', attitudeFrom(1));
  assert.strictEqual((await rejected).reason, 'profile-unresolved');
  assert.strictEqual(messages.length, 0);

  /** The other route (sysid 2 -> 'pb') still works. */
  const still = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', attitudeFrom(2));
  assert.strictEqual((await still).payload.profile, 'B');
});

test('recreating a routed profile under the same id builds a fresh codec (#117)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = routedConnection(RED);
  t.after(() => RED.close(conn));

  const first = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', attitudeFrom(1));
  await first;

  /** Recreate 'pa' as a *new object* with a different dialect under the same id. */
  const before = conn._codecByProfile.get('pa');
  profile(RED, 'pa', 'A', 'minimal');
  RED.events.emit('flows:started');

  /** The next packet builds a codec bound to the new object, not the cached one. */
  const err = nextEvent(conn.emitter, 'decodeError');
  conn._transport.emit('data', attitudeFrom(1));
  await err;
  const after = conn._codecByProfile.get('pa');
  assert.ok(after, 'codec rebuilt for recreated profile');
  assert.notStrictEqual(after.codec, before.codec, 'a fresh codec was built');
  assert.strictEqual(after.profile, RED.nodes.getNode('pa'), 'codec bound to the current object');
});

test('the merged CRC table and decoder reset when a routed dialect set changes (#117)', async (t) => {
  const RED = new MockRED().loadNodes();
  const conn = routedConnection(RED);
  t.after(() => RED.close(conn));

  /**
   * Before: the effective dialects are minimal + ardupilotmega, which have no
   * GNSS_INTEGRITY (id 441). The splitter's merged CRC table lacks 441, so a 441
   * frame for sysid 1 is dropped in the splitter — no message, no decode error.
   * Feed an ATTITUDE frame first to force the lazy decoder build.
   */
  conn._transport.emit('data', attitudeFrom(1));
  const decoder1 = conn._decoder;
  assert.ok(decoder1, 'decoder built lazily on first data');

  /**
   * Change route sysid 1 -> a development-dialect profile (recreated under the
   * same id). The effective routed set changes, so the decoder must be reset and
   * the merged CRC table rebuilt to include id 441.
   */
  profile(RED, 'pa', 'A', 'development');
  RED.events.emit('flows:started');
  assert.strictEqual(conn._decoder, null, 'decoder reset when routed dialect set changed');

  /** Now id 441 from sysid 1 survives the splitter and decodes as GNSS_INTEGRITY. */
  const msg = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', gnssIntegrityFrom(1));
  const decoded = await msg;
  assert.strictEqual(decoded.payload.name, 'GNSS_INTEGRITY');
  assert.strictEqual(decoded.payload.profile, 'A');
  assert.notStrictEqual(conn._decoder, decoder1, 'a fresh decoder was built');
});

test('a deleted profile stops resolving by legacy name after deploy (#118)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED, 'p_def', 'Def', 'minimal');
  profile(RED, 'p2', 'Alt', 'ardupilotmega');
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Conn', profile: 'p_def',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  /** Resolve once to populate the name cache with the resolved id. */
  assert.strictEqual(conn.resolveProfile('Alt'), RED.nodes.getNode('p2'));

  /**
   * Delete the profile. Even without a redeploy, the cache re-resolves the id
   * through getNode() and finds it gone, so the stale object is never returned.
   */
  RED.remove('p2');
  assert.throws(() => conn.resolveProfile('Alt'), (err) => err.code === 'PROFILE_UNRESOLVED');
});

test('renaming a profile invalidates the old name and resolves the new one (#118)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED, 'p_def', 'Def', 'minimal');
  profile(RED, 'p2', 'Alt', 'ardupilotmega');
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Conn', profile: 'p_def',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  assert.strictEqual(conn.resolveProfile('Alt'), RED.nodes.getNode('p2'));

  /**
   * Rename: recreate p2 with a new display name under the same id. The cached id
   * for 'Alt' now points at a node whose name no longer matches, so the old name
   * stops resolving and the new name resolves.
   */
  profile(RED, 'p2', 'Renamed', 'ardupilotmega');
  assert.throws(() => conn.resolveProfile('Alt'), (err) => err.code === 'PROFILE_UNRESOLVED');
  assert.strictEqual(conn.resolveProfile('Renamed'), RED.nodes.getNode('p2'));
});

test('recreating a profile under the same id returns the current object, never the previous (#118)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED, 'p_def', 'Def', 'minimal');
  profile(RED, 'p2', 'Alt', 'ardupilotmega');
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Conn', profile: 'p_def',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  const original = conn.resolveProfile('Alt');
  assert.strictEqual(original, RED.nodes.getNode('p2'));

  /** Recreate p2 as a new object under the same id and name. */
  profile(RED, 'p2', 'Alt', 'ardupilotmega');
  const current = RED.nodes.getNode('p2');
  assert.notStrictEqual(current, original, 'a new object was created');
  assert.strictEqual(conn.resolveProfile('Alt'), current, 'resolves the current object');
});

test('a name that becomes ambiguous fails PROFILE_AMBIGUOUS even after a cached unique result (#118)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED, 'p_def', 'Def', 'minimal');
  profile(RED, 'p2', 'Alt', 'ardupilotmega');
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Conn', profile: 'p_def',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  /** Cache a unique result for 'Alt'. */
  assert.strictEqual(conn.resolveProfile('Alt'), RED.nodes.getNode('p2'));

  /**
   * A second profile now shares the name 'Alt'. The deploy clears the name cache
   * so the next resolution re-scans and reports the ambiguity rather than serving
   * the stale unique result.
   */
  profile(RED, 'p3', 'Alt', 'minimal');
  RED.events.emit('flows:started');
  assert.throws(() => conn.resolveProfile('Alt'), (err) => err.code === 'PROFILE_AMBIGUOUS');
});
