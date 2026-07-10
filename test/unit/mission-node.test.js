'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * Build a mission node backed by a real profile and a lightweight stub
 * connection. The stub is enough to exercise the node's pre-lock validation
 * (#74): the node reads `connection.profile` for defaults/dialect and errors
 * out before it would ever call acquireLock/subscribe/send.
 */
function setup() {
  const RED = new MockRED().loadNodes();
  const profile = RED.create('mavlink-ai-profile', {
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
    lockNames: [],
    resolveProfile: (ref) => (profile && ref === profile.id ? profile : { name: ref }),
    acquireLock(name) {
      conn.lockNames.push(name);
      return { release: () => {} };
    },
    send(m) {
      conn.sent.push(m);
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
  const fence = profileStub('p2', 'Fence GCS', { defaultTargetSystem: 9, defaultMissionType: 'fence' });
  const { RED, conn, node } = setupWithSends({ profile: fence, config: { profile: 'p2' } });
  await RED.inject(node, { payload: { action: 'clear' } });
  const sent = conn.sent[0];
  assert.strictEqual(sent.name, 'MISSION_CLEAR_ALL');
  assert.strictEqual(sent.profile, 'p2');
  assert.strictEqual(sent.fields.target_system, 9);
  assert.strictEqual(sent.fields.mission_type, 1); // fence, from the override's defaults
  assert.match(conn.lockNames[0], /:p2:/);
});

test('mission node rejects an unresolvable profile with UNKNOWN_PROFILE', async () => {
  const { RED, conn, node } = setupWithSends({});
  const { collected } = await RED.inject(node, { payload: { action: 'clear', profile: 'missing' } });
  const err = collected[0][2];
  assert.strictEqual(err.topic, 'mavlink/error');
  assert.strictEqual(err.payload.code, 'UNKNOWN_PROFILE');
  assert.strictEqual(conn.sent.length, 0);
});

test('mission node route-resolves the target profile when no override is set', async () => {
  const routed = profileStub('p_routed', 'Routed Rally', { defaultMissionType: 'rally' });
  const { RED, conn, node } = setupWithSends({});
  conn.getProfileForPacket = ({ sysid }) => (sysid === 2 ? routed : conn.profile);
  await RED.inject(node, { payload: { action: 'clear', target_system: 2 } });
  const sent = conn.sent[0];
  assert.strictEqual(sent.profile, 'p_routed');
  assert.strictEqual(sent.fields.target_system, 2);
  assert.strictEqual(sent.fields.mission_type, 2); // rally, from the routed profile's defaults
  assert.match(conn.lockNames[0], /:p_routed:/);
});
