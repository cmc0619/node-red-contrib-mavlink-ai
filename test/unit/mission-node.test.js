'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { fakeIdentity } = require('../helpers/v3-config');
const { LockManager } = require('../../lib/runtime/lock-manager');
const { PRIORITY } = require('../../lib/runtime/send-priority');

/**
 * Build a mission node backed by a real profile and a lightweight stub
 * connection. The stub is enough to exercise the node's pre-lock validation
 * (#74): the node reads `connection.profile` for defaults/dialect and errors
 * out before it would ever call acquireLock/subscribe/send.
 */
function setup() {
  const RED = new MockRED().loadNodes();
  const profile = RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });

  RED.nodes.registerType('stub-connection', function StubConnection(config) {
    RED.nodes.createNode(this, config);
    this.name = 'conn';
    this.profile = profile;
    /** #196 routing API (required by the contract): accept everything. */
    this.getRouteDecision = () => ({ accepted: true, profile: null });
    this.acquireLock = () => {
      throw new Error('acquireLock must not be reached for invalid targets');
    };
  });
  RED.create('stub-connection', { id: 'conn1' });

  const node = RED.create('mavlink-ai-mission', { id: 'm1', connection: 'conn1', action: 'download' });
  return { RED, node };
}

test('mission node rejects an out-of-range target_system before locking (#74)', async () => {
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'download', target_system: 999 } });
  const err = collected[0][2]; // output 3: errors
  assert.strictEqual(err.topic, 'mavlink/error');
  assert.strictEqual(err.payload.code, 'INVALID_FIELD');
  assert.strictEqual(err.payload.context.field, 'target_system');
});

test('mission node rejects an out-of-range target_component before locking (#74)', async () => {
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'clear', target_component: 300 } });
  const err = collected[0][2];
  assert.strictEqual(err.payload.code, 'INVALID_FIELD');
  assert.strictEqual(err.payload.context.field, 'target_component');
});

test('mission upload with missing items fails before locking, not an implicit clear (#236)', async () => {
  /** The stub connection throws if acquireLock is reached, so a MISSION_NO_ITEMS
   * error here proves the guard fired before the lock — a typo'd payload can't
   * upload MISSION_COUNT 0 and silently erase the on-vehicle mission. */
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'upload' } });
  const err = collected[0][2];
  assert.strictEqual(err.topic, 'mavlink/error');
  assert.strictEqual(err.payload.code, 'MISSION_NO_ITEMS');
});

test('mission upload with non-array items fails before locking (#236)', async () => {
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'upload', items: 'oops' } });
  assert.strictEqual(collected[0][2].payload.code, 'MISSION_ITEMS_NOT_ARRAY');
});

test('mission upload with an explicit empty array refuses to clear without allow_empty (#236)', async () => {
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'upload', items: [] } });
  assert.strictEqual(collected[0][2].payload.code, 'MISSION_EMPTY_UPLOAD');
});

test('a wrong-shaped allow_empty does not confirm a destructive empty upload (#236)', async () => {
  /** {} / [] are truthy through toBool's Boolean() fallback; they must NOT
   * reopen the empty-clear path — only an explicit boolean/string true does. */
  const { RED, node } = setup();
  for (const allow_empty of [{}, [], 1]) {
    const { collected } = await RED.inject(node, { payload: { action: 'upload', items: [], allow_empty } });
    assert.strictEqual(collected[0][2].payload.code, 'MISSION_EMPTY_UPLOAD', `allow_empty=${JSON.stringify(allow_empty)} is not a confirmation`);
  }
});

test('mission upload with a malformed item field fails before locking (#236)', async () => {
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'upload', items: [{ command: 16, param1: 'oops' }] } });
  assert.strictEqual(collected[0][2].payload.code, 'INVALID_FIELD');
  assert.strictEqual(collected[0][2].payload.context.field, 'param1');
});

test('mission upload with an unknown MAV_CMD name fails before locking (#236)', async () => {
  /** A typoed command resolves against the profile's dialect and fails here,
   * before MISSION_COUNT is sent — not mid-transfer in codec.encode. */
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, {
    payload: { action: 'upload', items: [{ command: 'MAV_CMD_NAV_WAYPONT', lat: 1, lon: 2 }] }
  });
  assert.strictEqual(collected[0][2].payload.code, 'INVALID_FIELD');
  assert.strictEqual(collected[0][2].payload.context.field, 'command');
});

// Workflow profile propagation (#81): the mission node resolves one effective
// profile — explicit override, or the target's routed profile — and uses it
// for defaults, the lock key, and the profile reference on every send.

/**
 * Build a minimal profile config-node stand-in with the given defaults.
 *
 * @param {string} id       config-node id
 * @param {string} name     display name
 * @param {object} defaults extra getDefaults() fields
 * @returns {object}
 */
function profileStub(id, name, defaults) {
  return {
    id,
    name,
    isValid: () => true,
    getDialect: () => null,
    getDefaults: () => Object.assign({ defaultTargetSystem: 1, defaultTargetComponent: 1 }, defaults)
  };
}

/**
 * Build a mission node on a stub connection that records sends and lock names,
 * optionally resolving one extra profile by id.
 *
 * @param {object} [opts]
 * @param {object} [opts.profile]  extra profile resolvable via resolveProfile
 * @param {object} [opts.config]   extra mission node config
 * @returns {{RED: MockRED, conn: object, node: object, defaultProfile: object}}
 */
function setupWithSends({ profile, config } = {}) {
  const RED = new MockRED().loadNodes();
  const defaultProfile = profileStub('p1', 'Default', {});
  const conn = {
    id: 'conn1',
    name: 'Conn',
    profile: defaultProfile,
    sent: [],
    sentOptions: [],
    lockNames: [],
    resolveProfile: (ref) => (profile && ref === profile.id ? profile : { name: ref }),
    resolveOutboundIdentity: () => fakeIdentity(),
    /** #196 routing API (required by the contract): accept everything. */
    getRouteDecision: () => ({ accepted: true, profile: null }),
    acquireLock(name) {
      conn.lockNames.push(name);
      return { release: () => {} };
    },
    send(m, options) {
      conn.sent.push(m);
      conn.sentOptions.push(options);
      return Promise.resolve();
    }
  };
  RED._nodes.set('conn1', conn);
  const node = RED.create(
    'mavlink-ai-mission',
    Object.assign({ id: 'm2', connection: 'conn1', action: 'clear' }, config)
  );
  return { RED, conn, node, defaultProfile };
}

test('mission node explicit profile drives defaults, lock key, and sends', async () => {
  const fence = profileStub('p2', 'Fence GCS', { defaultTargetSystem: 9 });
  const { RED, conn, node } = setupWithSends({ profile: fence, config: { profile: 'p2', missionType: 'fence' } });
  await RED.inject(node, { payload: { action: 'clear' } });
  const sent = conn.sent[0];
  assert.strictEqual(sent.name, 'MISSION_CLEAR_ALL');
  assert.strictEqual(sent.vehicleProfile, 'p2');
  assert.strictEqual(sent.fields.target_system, 9);
  /** mission_type 1 = fence, resolved from the node's Mission Type field. */
  assert.strictEqual(sent.fields.mission_type, 1);
  assert.match(conn.lockNames[0], /:p2:/);
});

test('mission node rejects an unresolvable profile with PROFILE_UNRESOLVED', async () => {
  const { RED, conn, node } = setupWithSends({});
  const { collected } = await RED.inject(node, { payload: { action: 'clear', vehicleProfile: 'missing' } });
  const err = collected[0][2];
  assert.strictEqual(err.topic, 'mavlink/error');
  assert.strictEqual(err.payload.code, 'PROFILE_UNRESOLVED');
  assert.strictEqual(conn.sent.length, 0);
});

test('mission node route-resolves the target profile when no override is set', async () => {
  const routed = profileStub('p_routed', 'Routed Rally', {});
  const { RED, conn, node } = setupWithSends({ config: { missionType: 'rally' } });
  conn.getRouteDecision = ({ sysid }) => ({ accepted: true, profile: sysid === 2 ? routed : conn.profile });
  await RED.inject(node, { payload: { action: 'clear', target_system: 2 } });
  const sent = conn.sent[0];
  assert.strictEqual(sent.vehicleProfile, 'p_routed');
  assert.strictEqual(sent.fields.target_system, 2);
  /** mission_type 2 = rally, from the node's Mission Type — the profile no longer carries it. */
  assert.strictEqual(sent.fields.mission_type, 2);
  assert.match(conn.lockNames[0], /:p_routed:/);
});

test('a numeric payload.mission_type 0 overrides a node configured for another list', async () => {
  /**
   * Presence-based defaulting: the numeric MAV_MISSION_TYPE 0 (= mission) is a
   * valid override and must not be dropped as falsy — a `||` default would send
   * the node's configured type instead (Codex review). Node is set to fence (1);
   * an explicit 0 must reach the wire as mission (0), not fence.
   */
  const { RED, conn, node } = setupWithSends({ config: { missionType: 'fence' } });
  await RED.inject(node, { payload: { action: 'clear', mission_type: 0 } });
  assert.strictEqual(conn.sent[0].fields.mission_type, 0);
});

test('the best-effort clear stamps the NORMAL band explicitly (#241)', async () => {
  /**
   * The wait_ack-false clear bypasses MissionWorkflow._send, so it must carry
   * its own priority — every producer assigns a band per §21.1 (Codex review).
   */
  const { RED, conn, node } = setupWithSends({});
  await RED.inject(node, { payload: { action: 'clear' } });
  assert.strictEqual(conn.sent[0].name, 'MISSION_CLEAR_ALL');
  assert.strictEqual(conn.sentOptions[0].priority, PRIORITY.NORMAL);
});

test('the mission lock is released exactly once when the success-path send throws (#150)', async () => {
  const RED = new MockRED().loadNodes();
  const locks = new LockManager();
  let releaseCount = 0;
  const defaultProfile = profileStub('p1', 'Default', {});
  const conn = {
    id: 'conn1',
    name: 'Conn',
    profile: defaultProfile,
    sent: [],
    resolveProfile: (ref) => (ref === 'p1' ? defaultProfile : { name: ref }),
    resolveOutboundIdentity: () => fakeIdentity(),
    /** #196 routing API (required by the contract): accept everything. */
    getRouteDecision: () => ({ accepted: true, profile: null }),
    acquireLock(key) {
      const handle = locks.acquire(key, 'm2');
      return {
        release: () => {
          releaseCount += 1;
          handle.release();
        }
      };
    },
    send(m) {
      conn.sent.push(m);
      return Promise.resolve();
    }
  };
  RED._nodes.set('conn1', conn);
  const node = RED.create('mavlink-ai-mission', { id: 'm2', connection: 'conn1', action: 'clear' });

  /**
   * The success-path output throws (a downstream node error). Before the fix
   * the success branch had already released the lock, so the catch released it
   * a second time — the finally now makes release exactly-once.
   */
  let sendCalls = 0;
  await new Promise((resolve) => {
    const throwingSend = () => {
      sendCalls += 1;
      if (sendCalls === 1) {
        throw new Error('downstream boom');
      }
    };
    node._ee.emit('input', { payload: { action: 'clear' } }, throwingSend, resolve);
  });

  assert.strictEqual(releaseCount, 1, 'lock released exactly once despite the throwing send');
  assert.strictEqual(locks.isHeld('mission:conn1:p1:0'), false, 'the lock is free afterwards');
});

test('mission node rejects a broadcast target_system before locking/sending (#197)', async () => {
  const { RED, conn, node } = setupWithSends();
  const { collected } = await RED.inject(node, { payload: { action: 'clear', target_system: 0 } });
  const err = collected[0][2];
  assert.strictEqual(err.topic, 'mavlink/error');
  assert.strictEqual(err.payload.code, 'BROADCAST_NO_ACK');
  assert.strictEqual(conn.sent.length, 0, 'no mission message was sent to the broadcast target');
});

test('mission node reports an unresolved Local Identity on its error output', async () => {
  const { RED, conn, node } = setupWithSends();
  conn.resolveOutboundIdentity = () => {
    throw Object.assign(new Error('Requested Local Identity does not exist.'), { code: 'LOCAL_IDENTITY_UNRESOLVED' });
  };

  const { collected, err } = await RED.inject(node, { payload: { action: 'clear', localIdentity: 'missing' } });
  assert.strictEqual(err, undefined, 'the structured error output must not also call done(err)');
  assert.strictEqual(collected.length, 1);
  assert.strictEqual(collected[0][2].topic, 'mavlink/error');
  assert.strictEqual(collected[0][2].payload.code, 'LOCAL_IDENTITY_UNRESOLVED');
  assert.strictEqual(conn.sent.length, 0, 'no mission message is sent when identity resolution fails');
});

test('mission workflow to a route-rejected target fails fast, zero bytes on the wire (#196)', async () => {
  /**
   * Routed connection, unmatched policy 'reject': inbound packets from sysid 5
   * are dropped before decode, so a mission workflow addressed at it can never
   * see a reply. It must fail with ROUTE_REJECTED before sending anything —
   * not run the full retry schedule into MISSION_TIMEOUT.
   */
  const { RED, conn, node } = setupWithSends({ config: { action: 'download' } });
  conn.getRouteDecision = ({ sysid }) =>
    sysid === 5
      ? { accepted: false, profile: null, reason: 'unmatched-reject' }
      : { accepted: true, profile: conn.profile };
  const { collected } = await RED.inject(node, { payload: { action: 'download', target_system: 5 } });
  const err = collected[0][2];
  assert.strictEqual(err.topic, 'mavlink/error');
  assert.strictEqual(err.payload.code, 'ROUTE_REJECTED');
  assert.strictEqual(conn.sent.length, 0, 'no mission message may reach a route-rejected target');
  assert.strictEqual(conn.lockNames.length, 0, 'the workflow lock is never taken for a doomed workflow');
});
