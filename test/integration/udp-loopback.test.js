'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

/**
 * Resolve a single EventEmitter event, or reject quickly with a useful error
 * instead of letting a broken integration path hang the whole test run.
 *
 * @param {EventEmitter} emitter
 * @param {string} event
 * @param {number} [ms]
 * @returns {Promise<*>}
 */
function onceWithTimeout(emitter, event, ms = 1000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for '${event}' after ${ms}ms.`));
    }, ms);

    function cleanup() {
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
    }

    function onEvent(value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }

    emitter.once(event, onEvent);
  });
}

/**
 * Add a hard ceiling around any promise used by integration tests.
 *
 * @param {Promise<*>} promise
 * @param {string} label
 * @param {number} [ms]
 * @returns {Promise<*>}
 */
function withTimeout(promise, label, ms = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Subscribe to a connection message and reject if it never arrives.
 *
 * @param {object} connection
 * @param {object} filter
 * @param {function(): void} trigger
 * @param {number} [ms]
 * @returns {Promise<object>}
 */
function waitForConnectionMessage(connection, filter, trigger, ms = 1000) {
  return new Promise((resolve, reject) => {
    let subId;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for connection message after ${ms}ms.`));
    }, ms);

    function cleanup() {
      clearTimeout(timer);
      if (subId !== undefined) {
        connection.unsubscribe(subId);
      }
    }

    subId = connection.subscribe(filter, (message) => {
      cleanup();
      resolve(message);
    });

    try {
      trigger();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * A tiny simulated MAVLink vehicle (sysid 1) over UDP. It decodes inbound
 * packets and can answer the mission download protocol, letting us exercise the
 * full connection runtime (transport -> decode -> route -> subscribe -> send)
 * against a recorded-style harness without needing real SITL.
 */
class SimVehicle extends EventEmitter {
  constructor() {
    super();
    this.bundle = loadDialect('ardupilotmega');
    this.codec = new MavlinkCodec({ bundle: this.bundle, version: 'v2', sysid: 1, compid: 1 });
    this.socket = dgram.createSocket('udp4');
    this.lastFrom = null;
    this.missionItems = null;
    this.decoder = this.codec.createDecoder((packet) => this._onPacket(packet));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.on('message', (buf, rinfo) => {
        this.lastFrom = rinfo;
        this.decoder.write(buf);
      });
      this.socket.bind(0, '127.0.0.1', () => resolve(this.socket.address().port));
    });
  }

  _send(name, fields) {
    if (!this.lastFrom) {
      return;
    }
    const buf = this.codec.encode(name, fields);
    this.socket.send(buf, this.lastFrom.port, this.lastFrom.address);
  }

  sendTo(port, address, name, fields) {
    const buf = this.codec.encode(name, fields);
    this.socket.send(buf, port, address);
  }

  enableMissionServer(items) {
    this.missionItems = items;
  }

  _onPacket(packet) {
    const msg = this.codec.decode(packet);
    this.emit(msg.name, msg);

    if (!this.missionItems) {
      return;
    }
    const f = msg.fields;
    if (msg.name === 'MISSION_REQUEST_LIST') {
      this._send('MISSION_COUNT', {
        count: this.missionItems.length,
        target_system: 255,
        target_component: 190,
        mission_type: f.mission_type
      });
    } else if (msg.name === 'MISSION_REQUEST_INT' || msg.name === 'MISSION_REQUEST') {
      const item = this.missionItems[f.seq];
      this._send('MISSION_ITEM_INT', Object.assign({ target_system: 255, target_component: 190 }, item));
    }
  }

  stop() {
    this.decoder.destroy();
    return new Promise((resolve) => this.socket.close(resolve));
  }
}

function makeProfile(RED) {
  return RED.create('mavlink-ai-profile', {
    id: 'p1',
    name: 'Copter',
    profileType: 'gcs',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    sourceSystemId: 255,
    sourceComponentId: 190,
    defaultTargetSystem: 1,
    defaultTargetComponent: 1,
    preferredMissionItemType: 'MISSION_ITEM_INT',
    defaultMissionType: 'mission'
  });
}

function makeConnection(RED) {
  return RED.create('mavlink-ai-connection', {
    id: 'c1',
    name: 'Copter UDP',
    profile: 'p1',
    transport: 'udp-peer',
    routingMode: 'single-profile',
    bindAddress: '127.0.0.1',
    bindPort: 0,
    reconnect: false,
    heartbeat: false
  });
}

test('udp loopback: decode HEARTBEAT, send COMMAND_LONG, download mission', { timeout: 5000 }, async (t) => {
  const RED = new MockRED().loadNodes();
  makeProfile(RED);
  const conn = makeConnection(RED);

  // Wait until the connection's UDP socket is bound, then learn its port.
  const addr = await onceWithTimeout(conn._transport, 'listening', 1000);
  const connPort = addr.port;

  const vehicle = new SimVehicle();
  const vehiclePort = await withTimeout(vehicle.start(), 'vehicle UDP bind', 1000);
  t.after(async () => {
    await RED.close(conn);
    await vehicle.stop();
  });

  // 1) Vehicle heartbeat -> connection decodes and the connection learns the peer.
  const heartbeat = await waitForConnectionMessage(
    conn,
    { messageNames: ['HEARTBEAT'] },
    () => {
      vehicle.sendTo(connPort, '127.0.0.1', 'HEARTBEAT', {
        type: 'MAV_TYPE_QUADROTOR',
        autopilot: 'MAV_AUTOPILOT_ARDUPILOTMEGA',
        base_mode: 81,
        custom_mode: 0,
        system_status: 'MAV_STATE_ACTIVE'
      });
    },
    1000
  );
  assert.strictEqual(heartbeat.payload.name, 'HEARTBEAT');
  assert.strictEqual(heartbeat.payload.sysid, 1);
  assert.strictEqual(heartbeat.payload.profile, 'Copter');
  assert.strictEqual(heartbeat.payload.fields.type, 2);

  // 2) Connection sends a COMMAND_LONG (arm); vehicle receives and decodes it.
  const armReceived = onceWithTimeout(vehicle, 'COMMAND_LONG', 1000);
  await conn.send({ name: 'COMMAND_LONG', fields: { command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 1 } });
  const arm = await armReceived;
  assert.strictEqual(arm.fields.command, 400);
  assert.strictEqual(arm.fields.target_system, 1);
  assert.strictEqual(arm.fields.param1, 1);

  // 3) Mission download: two waypoints served by the simulated vehicle.
  vehicle.enableMissionServer([
    { seq: 0, command: 'MAV_CMD_NAV_WAYPOINT', frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT', current: 1, autocontinue: 1, x: 399999999, y: -749999999, z: 50, param1: 0, param2: 0, param3: 0, param4: 0, mission_type: 0 },
    { seq: 1, command: 'MAV_CMD_NAV_WAYPOINT', frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT', current: 0, autocontinue: 1, x: 400000000, y: -750000000, z: 60, param1: 0, param2: 0, param3: 0, param4: 0, mission_type: 0 }
  ]);

  const mission = RED.create('mavlink-ai-mission', {
    id: 'm1',
    connection: 'c1',
    action: 'download',
    timeoutMs: 250,
    maxRetries: 2
  });

  const { collected } = await withTimeout(RED.inject(mission, { payload: {} }), 'mission download', 2500);
  const completed = collected.map((arr) => arr[0]).filter(Boolean).pop();
  assert.ok(completed, 'expected a completed mission output');
  assert.strictEqual(completed.topic, 'mission/downloaded');
  assert.strictEqual(completed.payload.count, 2);
  assert.strictEqual(completed.payload.items.length, 2);
  assert.strictEqual(completed.payload.items[0].seq, 0);
  assert.strictEqual(completed.payload.items[1].z, 60);
});
