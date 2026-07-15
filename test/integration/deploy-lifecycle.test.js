'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const helper = require('node-red-node-test-helper');
const connectionNode = require('../../nodes/mavlink-ai-connection.js');
const profileNode = require('../../nodes/mavlink-ai-profile.js');
const identityNode = require('../../nodes/mavlink-ai-local-identity.js');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * Real Node-RED deploy lifecycle tests (#119).
 *
 * Unlike the MockRED unit tests, these drive the *actual* Node-RED runtime
 * deploy path via node-red-node-test-helper's `setFlows(flow, type)`: it runs
 * the real flow diff, config-node dependency propagation, stop ordering, and
 * async `close` handling for "nodes" / "flows" / "full" deploys.
 *
 * Two distinct dependency behaviors are exercised here, and each matters:
 *
 *  - The connection's DEFAULT profile (`config.profile`) is a config-node
 *    dependency Node-RED can see, so editing/deleting it *recreates* the
 *    connection. The acceptance criteria that matter are then observable
 *    externally: the UDP port is released and re-bindable, and a deactivated
 *    connection's sends reject.
 *  - ROUTED profiles (embedded in serialized `routeTable` JSON) and legacy
 *    name references are invisible to Node-RED, so the connection is left
 *    running and MUST reconcile them itself (#117, #118). Here the same
 *    connection instance survives the deploy and applies the change.
 *
 * UDP cleanup is proven by binding a second socket to the same port after a
 * removal/deactivation — not by inspecting internal state.
 */

const HOST = '127.0.0.1';

/** Reserve a currently-free UDP port so parallel CI runs don't collide. */
function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, HOST, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Whether `port` can be exclusively bound right now (no reuseAddr). */
function portBindable(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    s.once('error', () => resolve(false));
    s.bind(port, HOST, () => s.close(() => resolve(true)));
  });
}

/** Poll until `port` becomes bindable (or throw after `timeoutMs`). */
async function waitBindable(port, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portBindable(port)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`port ${port} never became bindable`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Assert `port` is currently bound (a fresh exclusive bind fails). */
async function assertBound(port) {
  assert.strictEqual(await portBindable(port), false, `expected port ${port} to be bound`);
}

const profileConfig = (id, name, dialect, extra = {}) => ({
  id,
  type: 'mavlink-ai-profile',
  name,
  vehicleFamily: 'generic',
  dialect,
  mavlinkVersion: 'v2',
  defaultTargetSystem: 1,
  defaultTargetComponent: 1,
  ...extra
});

/** A Local Identity config node — required for a connection to open (#228). */
const identityConfig = (id = 'id1', extra = {}) => ({
  id,
  type: 'mavlink-ai-local-identity',
  name: 'GCS',
  role: 'custom',
  sourceSystemId: 255,
  sourceComponentId: 190,
  ...extra
});

const connectionConfig = (id, profile, port, extra = {}) => ({
  id,
  type: 'mavlink-ai-connection',
  name: 'UDP',
  profile,
  localIdentity: 'id1',
  transport: 'udp-peer',
  routingMode: 'single-profile',
  bindAddress: HOST,
  bindPort: port,
  reconnect: false,
  heartbeat: false,
  ...extra
});

const routedConnectionConfig = (port, routes) =>
  connectionConfig('c1', 'p_def', port, {
    routingMode: 'routed',
    unmatchedPolicy: 'reject',
    routeTable: JSON.stringify(routes)
  });

/** A GNSS_INTEGRITY (id 441) frame — decodable only by the development dialect. */
function gnssIntegrityFrame(sysid = 1) {
  const codec = new MavlinkCodec({ bundle: loadDialect('development'), version: 'v2' });
  return enc(codec, 'GNSS_INTEGRITY', {}, { sysid, compid: 1 });
}

/** An ATTITUDE (id 30) frame — decodable by ardupilotmega/common, not minimal. */
function attitudeFrame(sysid = 1) {
  const codec = new MavlinkCodec({ bundle: loadDialect('ardupilotmega'), version: 'v2' });
  return enc(codec, 'ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }, { sysid, compid: 1 });
}

/**
 * Subscribe, then repeatedly send a datagram to the connection's port until the
 * expected decode event arrives (UDP loopback can drop a lone datagram).
 */
function decodeUntil(node, port, frameFn, subscribe, event, timeoutMs = 5000) {
  const sock = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for '${event}'`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(retry);
      sock.close();
    };
    subscribe(node, (payload) => {
      cleanup();
      resolve(payload);
    });
    const sendOnce = () => sock.send(frameFn(), port, HOST);
    sendOnce();
    const retry = setInterval(sendOnce, 150);
  });
}

/** Point the helper at the real Node-RED runtime before any hook runs. */
helper.init(require.resolve('node-red'));

describe('Node-RED deploy lifecycle (#119)', () => {
  before(() => helper.startServer());
  after(() => helper.stopServer());
  afterEach(() => helper.unload());

  it('binds the UDP port on deploy and releases it when the connection is removed', async () => {
    const port = await freeUdpPort();
    const flow = [identityConfig(), profileConfig('p1', 'Vehicle', 'common'), connectionConfig('c1', 'p1', port)];
    await helper.load([connectionNode, profileNode, identityNode], flow);
    const c1 = helper.getNode('c1');
    assert.ok(c1 && c1._active, 'connection is active');
    await assertBound(port);

    /**
     * Remove the connection node via a real deploy; its close handler must stop
     * the transport and free the port before the deploy completes.
     */
    await helper.setFlows([identityConfig(), profileConfig('p1', 'Vehicle', 'common')], 'nodes');
    await waitBindable(port);
  });

  it('applies a profile dialect edit so the connection decodes the new dialect on the same port', async () => {
    const port = await freeUdpPort();
    const flow = [identityConfig(), profileConfig('p1', 'Vehicle', 'common'), connectionConfig('c1', 'p1', port)];
    await helper.load([connectionNode, profileNode, identityNode], flow);
    const c1 = helper.getNode('c1');

    /** On `common`, message 441 cannot be decoded -> structured decode error. */
    const decodeError = await decodeUntil(
      c1,
      port,
      gnssIntegrityFrame,
      (n, cb) => n.emitter.on('decodeError', (e) => cb(e)),
      'decodeError'
    );
    assert.strictEqual(decodeError.payload.context.dialect, 'common');

    /**
     * Edit the profile's dialect to `development` and redeploy (modified nodes).
     * The connection binds the same UDP port and now speaks the new dialect.
     */
    await helper.setFlows(
      [identityConfig(), profileConfig('p1', 'Vehicle', 'development'), connectionConfig('c1', 'p1', port)],
      'nodes'
    );
    const c1b = helper.getNode('c1');
    assert.strictEqual(c1b.profile.dialect, 'development');
    await assertBound(port);

    /** Message 441 now decodes as GNSS_INTEGRITY via the new dialect. */
    const message = await decodeUntil(
      c1b,
      port,
      gnssIntegrityFrame,
      (n, cb) => n.subscribe({ messageNames: ['GNSS_INTEGRITY'] }, cb),
      'message'
    );
    assert.strictEqual(message.payload.name, 'GNSS_INTEGRITY');
  });

  it('fails closed and frees the port when the default profile is deleted', async () => {
    const port = await freeUdpPort();
    const flow = [identityConfig(), profileConfig('p1', 'Vehicle', 'common'), connectionConfig('c1', 'p1', port)];
    await helper.load([connectionNode, profileNode, identityNode], flow);
    await assertBound(port);

    /**
     * Delete the profile (the Local Identity stays, isolating the missing-profile
     * case). The connection must not keep decoding/commanding with a missing
     * required profile, and its UDP port must be released (#116).
     */
    await helper.setFlows([identityConfig(), connectionConfig('c1', 'p1', port)], 'nodes');
    const c1 = helper.getNode('c1');
    assert.ok(c1, 'connection node still present');
    assert.strictEqual(c1._active, false, 'connection is not active without its profile');
    await waitBindable(port);

    /** A send now rejects with a clear structured fail-closed error. */
    await assert.rejects(
      c1.send({ name: 'HEARTBEAT', fields: {} }),
      (err) => err.code === 'NO_PROFILE' || err.code === 'CONNECTION_INVALID'
    );
  });

  it('rebinds the same port across repeated connection recreation without EADDRINUSE', async () => {
    const port = await freeUdpPort();
    const profileFlow = [identityConfig(), profileConfig('p1', 'Vehicle', 'common')];
    await helper.load([connectionNode, profileNode, identityNode], profileFlow);

    for (let i = 0; i < 4; i += 1) {
      /** Add the connection on the fixed port. */
      await helper.setFlows([...profileFlow, connectionConfig('c1', 'p1', port)], 'nodes');
      const c1 = helper.getNode('c1');
      assert.ok(c1 && c1._active, `iteration ${i}: connection active`);
      await assertBound(port);
      /** Remove it again; the port must be free before the next iteration binds. */
      await helper.setFlows(profileFlow, 'nodes');
      await waitBindable(port);
    }
  });

  it('reconciles a routed profile edited inside the route table without recreating the connection (#117)', async () => {
    const port = await freeUdpPort();
    const routes = [
      { sysid: 1, compid: '*', profile: 'pa' },
      { sysid: 2, compid: '*', profile: 'pb' }
    ];
    const flow = [
      identityConfig(),
      profileConfig('p_def', 'Def', 'minimal'),
      profileConfig('pa', 'A', 'ardupilotmega'),
      profileConfig('pb', 'B', 'ardupilotmega'),
      routedConnectionConfig(port, routes)
    ];
    await helper.load([connectionNode, profileNode, identityNode], flow);
    const c1 = helper.getNode('c1');

    /** sysid 1 -> 'pa' (ardupilotmega): ATTITUDE decodes. */
    const decoded = await decodeUntil(
      c1,
      port,
      () => attitudeFrame(1),
      (n, cb) => n.subscribe({ messageNames: ['ATTITUDE'] }, cb),
      'message'
    );
    assert.strictEqual(decoded.payload.profile, 'A');

    /**
     * Edit routed profile 'pa' to minimal (a 'nodes' deploy: the connection's own
     * config is unchanged, so Node-RED leaves it running — only the reconcile can
     * apply the change). ATTITUDE then fails to decode against minimal.
     */
    await helper.setFlows(
      [
        identityConfig(),
        profileConfig('p_def', 'Def', 'minimal'),
        profileConfig('pa', 'A', 'minimal'),
        profileConfig('pb', 'B', 'ardupilotmega'),
        routedConnectionConfig(port, routes)
      ],
      'nodes'
    );
    const c1b = helper.getNode('c1');
    assert.strictEqual(c1b, c1, 'connection instance survived the routed-profile edit');
    const err = await decodeUntil(
      c1b,
      port,
      () => attitudeFrame(1),
      (n, cb) => n.emitter.on('decodeError', (e) => cb(e)),
      'decodeError'
    );
    assert.strictEqual(err.payload.context.dialect, 'minimal');
    assert.strictEqual(err.payload.context.profile, 'A');
  });

  it('stops resolving a renamed legacy name-referenced routed profile (#118)', async () => {
    const port = await freeUdpPort();
    /** The route references the profile by NAME (legacy form), not by id. */
    const routes = [{ sysid: 1, compid: '*', profile: 'Ardu' }];
    const flow = [
      identityConfig(),
      profileConfig('p_def', 'Def', 'minimal'),
      profileConfig('pa', 'Ardu', 'ardupilotmega'),
      routedConnectionConfig(port, routes)
    ];
    await helper.load([connectionNode, profileNode, identityNode], flow);
    const c1 = helper.getNode('c1');
    assert.strictEqual(c1.resolveProfile('Ardu'), helper.getNode('pa'));

    /**
     * Rename the profile (same id, new name) via a 'nodes' deploy. The connection
     * survives; the old name must stop resolving and the new name must resolve.
     */
    await helper.setFlows(
      [
        identityConfig(),
        profileConfig('p_def', 'Def', 'minimal'),
        profileConfig('pa', 'Renamed', 'ardupilotmega'),
        routedConnectionConfig(port, routes)
      ],
      'nodes'
    );
    const c1b = helper.getNode('c1');
    assert.strictEqual(c1b, c1, 'connection instance survived the rename');
    assert.throws(() => c1b.resolveProfile('Ardu'), (err) => err.code === 'PROFILE_UNRESOLVED');
    assert.strictEqual(c1b.resolveProfile('Renamed'), helper.getNode('pa'));
  });

  it('cancels a reconnecting transport timer when the connection is removed (#119)', async () => {
    /**
     * A tcp-client to a closed port enters reconnect backoff; removing the node
     * must cancel the reconnect timer via the async close path. Nothing is
     * listening on TCP at `deadPort`.
     */
    const deadPort = await freeUdpPort();
    const flow = [
      identityConfig(),
      profileConfig('p1', 'Vehicle', 'common'),
      {
        id: 'c1',
        type: 'mavlink-ai-connection',
        name: 'TCP',
        profile: 'p1',
        localIdentity: 'id1',
        transport: 'tcp-client',
        routingMode: 'single-profile',
        remoteHost: HOST,
        remotePort: deadPort,
        reconnect: true,
        heartbeat: false
      }
    ];
    await helper.load([connectionNode, profileNode, identityNode], flow);
    const c1 = helper.getNode('c1');
    const transport = c1._transport;
    assert.ok(transport, 'transport created');

    /** Wait until it is actively in reconnect backoff (a timer is pending). */
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 4000;
      const check = () => {
        if (transport._reconnectTimer) {
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error('never entered reconnect backoff'));
        } else {
          setTimeout(check, 25);
        }
      };
      check();
    });

    /** Remove the connection; the close path must clear the reconnect timer. */
    await helper.setFlows([profileConfig('p1', 'Vehicle', 'common')], 'nodes');
    assert.strictEqual(transport._reconnectTimer, null, 'reconnect timer cancelled on close');
    assert.strictEqual(transport._closing, true, 'transport marked closing');
  });
});
