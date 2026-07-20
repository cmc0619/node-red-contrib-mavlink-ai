'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * Vehicle capability cache + probe on the connection (#233): the connection
 * passively caches AUTOPILOT_VERSION.capabilities per wire identity and asks
 * a vehicle to report at most once per identity per deploy, fire-and-forget.
 */

function setup() {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', dialect: 'common', 
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1',
    transport: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0,
    reconnect: false, heartbeat: false
  });
  RED.events.emit('flows:started');
  return { RED, conn };
}

/** Dispatch a decoded AUTOPILOT_VERSION envelope through the registry. */
function reportCapabilities(conn, sysid, compid, capabilities) {
  conn.subscriptions.dispatch({
    topic: 'mavlink/AUTOPILOT_VERSION',
    payload: { name: 'AUTOPILOT_VERSION', id: 148, sysid, compid, fields: { capabilities } }
  });
}

test('AUTOPILOT_VERSION traffic populates the per-identity capability cache (#233)', async (t) => {
  const { RED, conn } = setup();
  t.after(() => RED.close(conn));

  assert.strictEqual(conn.getVehicleCapabilities(1, 1), undefined, 'unknown until reported');
  reportCapabilities(conn, 1, 1, 0x10n);
  reportCapabilities(conn, 2, 1, 0x20000n);
  assert.strictEqual(conn.getVehicleCapabilities(1, 1), 0x10n);
  assert.strictEqual(conn.getVehicleCapabilities(2, 1), 0x20000n);
  assert.strictEqual(conn.getVehicleCapabilities(3, 1), undefined, 'identities never mix');

  /** A newer report replaces the cached bits (e.g. firmware update mid-run). */
  reportCapabilities(conn, 1, 1, 0x20000n);
  assert.strictEqual(conn.getVehicleCapabilities(1, 1), 0x20000n);
});

test('requestVehicleCapabilities probes once per identity, fire-and-forget (#233)', async (t) => {
  const { RED, conn } = setup();
  t.after(() => RED.close(conn));

  const sent = [];
  conn.send = (message) => {
    sent.push(message);
    return Promise.resolve();
  };

  conn.requestVehicleCapabilities({ targetSystem: 1, targetComponent: 1, vehicleProfile: 'p1' });
  conn.requestVehicleCapabilities({ targetSystem: 1, targetComponent: 1, vehicleProfile: 'p1' });
  conn.requestVehicleCapabilities({ targetSystem: 2, targetComponent: 1 });

  assert.strictEqual(sent.length, 2, 'one probe per wire identity');
  assert.strictEqual(sent[0].name, 'COMMAND_LONG');
  assert.strictEqual(sent[0].fields.command, 'MAV_CMD_REQUEST_MESSAGE');
  assert.strictEqual(sent[0].fields.param1, 148, 'requests AUTOPILOT_VERSION');
  assert.strictEqual(sent[0].fields.target_system, 1);
  assert.strictEqual(sent[1].fields.target_system, 2);

  /** An identity that already reported is never probed at all. */
  reportCapabilities(conn, 3, 1, 0x10n);
  conn.requestVehicleCapabilities({ targetSystem: 3, targetComponent: 1 });
  assert.strictEqual(sent.length, 2, 'no probe for a known vehicle');

  /**
   * A rejecting send must not throw — and must NOT count as probed (#294
   * review): a startup UDP_NO_PEER blip would otherwise disable capability
   * detection for that vehicle until redeploy. The next op retries.
   */
  conn.send = () => Promise.reject(new Error('link down'));
  conn.requestVehicleCapabilities({ targetSystem: 4, targetComponent: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  conn.send = (message) => {
    sent.push(message);
    return Promise.resolve();
  };
  conn.requestVehicleCapabilities({ targetSystem: 4, targetComponent: 1 });
  assert.strictEqual(sent.length, 3, 'the failed probe was forgotten and retried');
  conn.requestVehicleCapabilities({ targetSystem: 4, targetComponent: 1 });
  assert.strictEqual(sent.length, 3, 'the delivered probe is not repeated');
});

test('component 0 resolves system-wide: autopilot first, then any component (#294 review)', async (t) => {
  const { RED, conn } = setup();
  t.after(() => RED.close(conn));

  /** Reports are cached under the responder's REAL component id. */
  reportCapabilities(conn, 1, 5, 0x20000n);
  assert.strictEqual(conn.getVehicleCapabilities(1, 0), 0x20000n, 'any component of the system matches');
  reportCapabilities(conn, 1, 1, 0x10n);
  assert.strictEqual(conn.getVehicleCapabilities(1, 0), 0x10n, 'the autopilot (compid 1) is preferred');
  assert.strictEqual(conn.getVehicleCapabilities(2, 0), undefined, 'other systems never match');

  /** A system-wide probe is skipped once ANY component of it reported. */
  const sent = [];
  conn.send = (message) => {
    sent.push(message);
    return Promise.resolve();
  };
  conn.requestVehicleCapabilities({ targetSystem: 1, targetComponent: 0 });
  assert.strictEqual(sent.length, 0, 'no probe for a system that already reported');
});
