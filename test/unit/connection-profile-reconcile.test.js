'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { nextEvent } = require('../helpers/next-event');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * Routed profiles (referenced from the connection's routeTable) must reconcile
 * on every deploy, without stale codecs or CRC tables surviving a profile edit,
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
  const codec = new MavlinkCodec({ bundle: ardu });
  return enc(codec, 'ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }, { sysid, compid: 1 });
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
  const codec = new MavlinkCodec({ bundle: dev });
  return enc(codec, 'GNSS_INTEGRITY', {}, { sysid, compid: 1 });
}

/**
 * Create a mavlink-ai-vehicle config node with the common identity fields.
 *
 * @param {MockRED} RED  the mock runtime
 * @param {string} id  config-node id
 * @param {string} name  display name
 * @param {string} dialect  dialect name
 * @param {object} [extra]  extra config overrides
 * @returns {object} the profile node
 */
function profile(RED, id, name, dialect, extra = {}) {
  return RED.create('mavlink-ai-vehicle', {
    id,
    name,
    dialect,
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
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  return RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Routed', profile: 'p_def', localIdentity: 'id1',
    transport: 'udp', routingMode: 'routed', unmatchedPolicy: 'reject',
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
  const decoder1 = [...conn._decoders.values()][0];
  assert.ok(decoder1, 'decoder built lazily on first data');

  /**
   * Change route sysid 1 -> a development-dialect profile (recreated under the
   * same id). The effective routed set changes, so the decoder must be reset and
   * the merged CRC table rebuilt to include id 441.
   */
  profile(RED, 'pa', 'A', 'development');
  RED.events.emit('flows:started');
  assert.strictEqual(conn._decoders.size, 0, 'decoder reset when routed dialect set changed');

  /** Now id 441 from sysid 1 survives the splitter and decodes as GNSS_INTEGRITY. */
  const msg = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', gnssIntegrityFrom(1));
  const decoded = await msg;
  assert.strictEqual(decoded.payload.name, 'GNSS_INTEGRITY');
  assert.strictEqual(decoded.payload.profile, 'A');
  assert.notStrictEqual([...conn._decoders.values()][0], decoder1, 'a fresh decoder was built');
});

test('profile resolution uses config-node IDs and re-resolves recreated nodes (#118)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED, 'p_def', 'Def', 'minimal');
  profile(RED, 'p2', 'Alt', 'ardupilotmega');
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Conn', profile: 'p_def', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  const original = conn.resolveProfile('p2');
  assert.strictEqual(original, RED.nodes.getNode('p2'));

  /** A recreated config node with the same id is returned as the new object. */
  profile(RED, 'p2', 'Renamed', 'ardupilotmega');
  const current = RED.nodes.getNode('p2');
  assert.notStrictEqual(current, original);
  assert.strictEqual(conn.resolveProfile('p2'), current);

  RED.remove('p2');
  assert.throws(() => conn.resolveProfile('p2'), (err) => err.code === 'PROFILE_UNRESOLVED');
});

test('profile display names are not accepted as references', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED, 'p_def', 'Def', 'minimal');
  profile(RED, 'p2', 'Alt', 'ardupilotmega');
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'Conn', profile: 'p_def', localIdentity: 'id1',
    transport: 'udp', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  assert.throws(() => conn.resolveProfile('Alt'), (err) => err.code === 'PROFILE_UNRESOLVED');
});
