'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { fakeIdentity } = require('../helpers/v3-config');

function setup(commandConfig) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  const node = RED.create(
    'mavlink-ai-command',
    Object.assign({ id: 'c1', profile: 'p1', delivery: 'build' }, commandConfig)
  );
  return { RED, node };
}

/**
 * A command node wired to a stub connection (#207 Send/Await delivery). The
 * stub's `subscribe`/`send` are no-ops by default; `stubAckOnConnection`
 * below wires them for the Send & await result workflow, and Send-mode tests
 * override `conn.send` directly to observe the fire-and-forget call.
 */
function setupWithConnection(commandConfig) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  RED.nodes.registerType('stub-connection', function StubConnection(config) {
    RED.nodes.createNode(this, config);
    this.name = 'conn';
    this.subscribe = () => 1;
    this.unsubscribe = () => true;
    this.resolveOutboundIdentity = () => fakeIdentity();
    this.send = () => Promise.resolve();
  });
  const conn = RED.create('stub-connection', { id: 'conn1' });
  const node = RED.create(
    'mavlink-ai-command',
    Object.assign({ id: 'c1', profile: 'p1', connection: 'conn1' }, commandConfig)
  );
  return { RED, conn, node };
}

/**
 * Wire a stub connection so the CommandSend workflow (Send & await result)
 * resolves with a COMMAND_ACK — same subscribe/deliver shape as the
 * 'await-ack workflow sends carry the node profile id' test below.
 *
 * @param {object} conn  a `setupWithConnection` stub connection
 * @returns {void}
 */
function stubAckOnConnection(conn) {
  let deliver = null;
  conn.subscribe = (filter, cb) => {
    deliver = cb;
    return 1;
  };
  conn.send = () => {
    queueMicrotask(() =>
      deliver({
        topic: 'mavlink/COMMAND_ACK',
        payload: { name: 'COMMAND_ACK', sysid: 1, compid: 1, fields: { command: 400, result: 0 } }
      })
    );
    return Promise.resolve();
  };
}

test('preset arm builds COMMAND_LONG with fixed param1', async () => {
  const { RED, node } = setup({ command: 'arm' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.name, 'COMMAND_LONG');
  assert.strictEqual(out.fields.command, 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.strictEqual(out.fields.param1, 1);
  assert.strictEqual(out.target_system, 1);
});

test('build-only output references the profile by config-node id, name for display', async () => {
  const { RED, node } = setup({ command: 'arm' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.vehicleProfile, 'p1');
  assert.strictEqual(out.vehicleProfileName, 'Copter');
});

test('preset param1 override is ignored (safety-critical)', async () => {
  const { RED, node } = setup({ command: 'arm' });
  const { collected } = await RED.inject(node, { payload: { param1: 0 } });
  // arm's param1 must stay 1 despite the incoming override.
  assert.strictEqual(collected[0][0].payload.fields.param1, 1);
});

test('raw MAV_CMD selection builds a COMMAND_LONG with that command', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_SET_SERVO' });
  const { collected } = await RED.inject(node, { payload: { param1: 5, param2: 1500 } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_SET_SERVO');
  assert.strictEqual(out.fields.param1, 5);
  assert.strictEqual(out.fields.param2, 1500);
});

test('raw MAV_CMD uses static config params (editor fields JSON)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_SET_SERVO', fields: '{"param1":9,"param2":1900}' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_SET_SERVO');
  assert.strictEqual(out.fields.param1, 9);
  assert.strictEqual(out.fields.param2, 1900);
});

test('stop_message_interval disables the stream (param2 = -1)', async () => {
  const { RED, node } = setup({ command: 'stop_message_interval' });
  const { collected } = await RED.inject(node, { payload: { message_id: 33 } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_SET_MESSAGE_INTERVAL');
  assert.strictEqual(out.fields.param1, 33);
  assert.strictEqual(out.fields.param2, -1);
});

test('unknown command yields a structured error', async () => {
  const { RED, node } = setup({ command: 'not_a_command' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'UNKNOWN_COMMAND');
});

function setupWithFirmware(commandConfig, profileExtra) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', Object.assign({
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  }, profileExtra));
  const node = RED.create(
    'mavlink-ai-command',
    Object.assign({ id: 'c1', profile: 'p1', delivery: 'build' }, commandConfig)
  );
  return { RED, node };
}

test('set_mode resolves a mode name via profile firmware/vehicle type (#20)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'set_mode' }, { firmware: 'ardupilot', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, { payload: { mode: 'GUIDED' } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_SET_MODE');
  assert.strictEqual(out.fields.param1, 1); // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
  assert.strictEqual(out.fields.param2, 4); // copter GUIDED
});

test('set_mode with an unknown mode name yields UNKNOWN_MODE (#20)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'set_mode' }, { firmware: 'ardupilot', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, { payload: { mode: 'WARP_SPEED' } });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'UNKNOWN_MODE');
});

test('set_mode numeric custom_mode still works without a firmware table (#20)', async () => {
  const { RED, node } = setup({ command: 'set_mode' });
  const { collected } = await RED.inject(node, { payload: { custom_mode: 4 } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.param2, 4);
});

/** PX4 reads DO_SET_MODE param2 as the bare main mode and param3 as the bare sub mode. */
test('set_mode on PX4 sends main mode in param2 and sub mode in param3 (#136)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'set_mode' }, { firmware: 'px4', vehicleFamily: 'copter' });
  const offboard = await RED.inject(node, { payload: { mode: 'OFFBOARD' } });
  assert.strictEqual(offboard.collected[0][0].payload.fields.param1, 1);
  assert.strictEqual(offboard.collected[0][0].payload.fields.param2, 6);
  assert.strictEqual(offboard.collected[0][0].payload.fields.param3, 0);
  const mission = await RED.inject(node, { payload: { mode: 'MISSION' } });
  assert.strictEqual(mission.collected[0][0].payload.fields.param2, 4);
  assert.strictEqual(mission.collected[0][0].payload.fields.param3, 4);
});

/** 393216 = (6 << 16): the packed OFFBOARD word a HEARTBEAT reports; must split to main 6. */
test('set_mode on PX4 splits a HEARTBEAT-packed numeric custom_mode (#136)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'set_mode' }, { firmware: 'px4', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, { payload: { custom_mode: 393216 } });
  assert.strictEqual(collected[0][0].payload.fields.param2, 6);
  assert.strictEqual(collected[0][0].payload.fields.param3, 0);
});

/** Packed AUTO.RTL = (4 << 16) | (5 << 24), as the raw editor's mode dropdown stores it. */
test('raw MAV_CMD_DO_SET_MODE on PX4 splits a packed param2 (#136)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'MAV_CMD_DO_SET_MODE' }, { firmware: 'px4', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, { payload: { param1: 1, param2: ((4 << 16) | (5 << 24)) >>> 0 } });
  assert.strictEqual(collected[0][0].payload.fields.param2, 4);
  assert.strictEqual(collected[0][0].payload.fields.param3, 5);
});

/**
 * A packed param2 carries the sub mode; a stale param3 from a prior dropdown
 * pick must not survive and flip AUTO.MISSION (sub 4) into AUTO.RTL (sub 5).
 */
test('raw MAV_CMD_DO_SET_MODE on PX4 overwrites a stale param3 from the packed sub (#136)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'MAV_CMD_DO_SET_MODE' }, { firmware: 'px4', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, {
    payload: { param1: 1, param2: ((4 << 16) | (4 << 24)) >>> 0, param3: 5 }
  });
  assert.strictEqual(collected[0][0].payload.fields.param2, 4);
  assert.strictEqual(collected[0][0].payload.fields.param3, 4);
});

/** AUTO_RTL is 27 — a bare ArduPilot custom_mode that must NOT be mistaken for packed. */
test('set_mode on ArduPilot keeps the whole custom_mode in param2 (#136)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'set_mode' }, { firmware: 'ardupilot', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, { payload: { mode: 'AUTO_RTL' } });
  assert.strictEqual(collected[0][0].payload.fields.param2, 27);
  assert.strictEqual(collected[0][0].payload.fields.param3, 0);
});

/**
 * PX4 takeoff param7 is AMSL (NaN = use MIS_TAKEOFF_ALT, so a fixed 10 would be
 * underground at most field sites) and param4 yaw NaN keeps the current heading.
 */
test('takeoff on PX4 defaults altitude and yaw to NaN (#143)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'takeoff' }, { firmware: 'px4', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_NAV_TAKEOFF');
  assert.ok(Number.isNaN(out.fields.param7));
  assert.ok(Number.isNaN(out.fields.param4));
});

/** The takeoff builder writes only param7 from altitude/param7, so alt/yaw aliases must be mapped explicitly. */
test('takeoff on PX4 maps explicit altitude and yaw aliases (#143)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'takeoff' }, { firmware: 'px4', vehicleFamily: 'copter' });
  const byAltitude = await RED.inject(node, { payload: { altitude: 500 } });
  assert.strictEqual(byAltitude.collected[0][0].payload.fields.param7, 500);
  const byAlias = await RED.inject(node, { payload: { alt: 500, yaw: 90 } });
  assert.strictEqual(byAlias.collected[0][0].payload.fields.param7, 500);
  assert.strictEqual(byAlias.collected[0][0].payload.fields.param4, 90);
});

test('takeoff keeps the relative-altitude default of 10 on ArduPilot (#143)', async () => {
  const { RED, node } = setupWithFirmware({ command: 'takeoff' }, { firmware: 'ardupilot', vehicleFamily: 'copter' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].payload.fields.param7, 10);
  assert.strictEqual(collected[0][0].payload.fields.param4, 0);
});

test('sendAs int builds COMMAND_INT with degE7 lat/lon (#17)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_REPOSITION', sendAs: 'int' });
  const { collected } = await RED.inject(node, {
    payload: { lat: 47.397742, lon: 8.545594, alt: 30, param1: -1 }
  });
  const out = collected[0][0].payload;
  assert.strictEqual(out.name, 'COMMAND_INT');
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_REPOSITION');
  assert.strictEqual(out.fields.x, 473977420);
  assert.strictEqual(out.fields.y, 85455940);
  assert.strictEqual(out.fields.z, 30);
  assert.strictEqual(out.fields.param1, -1);
  assert.strictEqual(out.fields.frame, 'MAV_FRAME_GLOBAL');
  assert.strictEqual(out.fields.confirmation, undefined); // COMMAND_INT has none
  assert.strictEqual(out.fields.param5, undefined);
});

test('msg.payload.command_int switches a single message to COMMAND_INT (#17)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_SET_ROI_LOCATION' });
  const { collected } = await RED.inject(node, {
    payload: { command_int: true, x: 473977420, y: 85455940, z: 10, frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT' }
  });
  const out = collected[0][0].payload;
  assert.strictEqual(out.name, 'COMMAND_INT');
  assert.strictEqual(out.fields.x, 473977420);
  assert.strictEqual(out.fields.frame, 'MAV_FRAME_GLOBAL_RELATIVE_ALT');
});

test('COMMAND_INT rejects non-numeric coordinates instead of sending 0,0 (#17)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_REPOSITION', sendAs: 'int' });
  const { collected } = await RED.inject(node, { payload: { lat: 'not-a-number', lon: 8.5 } });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'BAD_COORDINATES');
});

test('COMMAND_INT uses editor-saved param5/6/7 as lat/lon/alt (#17)', async () => {
  const { RED, node } = setup({
    command: 'MAV_CMD_DO_REPOSITION',
    sendAs: 'int',
    fields: '{"param5":47.397742,"param6":8.545594,"param7":30}'
  });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.name, 'COMMAND_INT');
  assert.strictEqual(out.fields.x, 473977420);
  assert.strictEqual(out.fields.y, 85455940);
  assert.strictEqual(out.fields.z, 30);
});

// --- New presets (#50, #52) -------------------------------------------------

test('goto preset defaults to COMMAND_INT with degE7 lat/lon (#50)', async () => {
  const { RED, node } = setup({ command: 'goto' });
  const { collected } = await RED.inject(node, { payload: { lat: 39.1, lon: -75.1, alt: 40 } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.name, 'COMMAND_INT');
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_REPOSITION');
  assert.strictEqual(out.fields.x, 391000000);
  assert.strictEqual(out.fields.y, -751000000);
  assert.strictEqual(out.fields.z, 40);
  assert.strictEqual(out.fields.param1, -1); // default vehicle speed
  assert.strictEqual(out.fields.param2, 1); // change-mode flag
});

test('change_speed preset maps friendly speed types (#50)', async () => {
  const { RED, node } = setup({ command: 'change_speed' });
  const { collected } = await RED.inject(node, { payload: { speed_type: 'groundspeed', speed: 12 } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_DO_CHANGE_SPEED');
  assert.strictEqual(out.fields.param1, 1);
  assert.strictEqual(out.fields.param2, 12);
  assert.strictEqual(out.fields.param3, -1); // no throttle change
});

test('condition_yaw preset maps angle/rate/direction/relative (#50)', async () => {
  const { RED, node } = setup({ command: 'condition_yaw' });
  const { collected } = await RED.inject(node, {
    payload: { angle: 90, rate: 20, direction: 'counter-clockwise', relative: true }
  });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.command, 'MAV_CMD_CONDITION_YAW');
  assert.strictEqual(out.fields.param1, 90);
  assert.strictEqual(out.fields.param2, 20);
  assert.strictEqual(out.fields.param3, -1);
  assert.strictEqual(out.fields.param4, 1);
});

test('spin preset defaults to a relative 360 but the angle is configurable (#52)', async () => {
  const { RED, node } = setup({ command: 'spin' });
  const full = await RED.inject(node, { payload: {} });
  assert.strictEqual(full.collected[0][0].payload.fields.command, 'MAV_CMD_CONDITION_YAW');
  assert.strictEqual(full.collected[0][0].payload.fields.param1, 360);
  assert.strictEqual(full.collected[0][0].payload.fields.param3, 1); // clockwise
  assert.strictEqual(full.collected[0][0].payload.fields.param4, 1); // relative
  const half = await RED.inject(node, { payload: { angle: 180, direction: 'ccw' } });
  assert.strictEqual(half.collected[0][0].payload.fields.param1, 180);
  assert.strictEqual(half.collected[0][0].payload.fields.param3, -1);
});

test('mission presets: start with range, pause/resume param1 is protected (#50)', async () => {
  const { RED, node } = setup({ command: 'mission_start' });
  const start = await RED.inject(node, { payload: { first_item: 2, last_item: 5 } });
  assert.strictEqual(start.collected[0][0].payload.fields.command, 'MAV_CMD_MISSION_START');
  assert.strictEqual(start.collected[0][0].payload.fields.param1, 2);
  assert.strictEqual(start.collected[0][0].payload.fields.param2, 5);

  const { RED: RED2, node: pause } = setup({ command: 'pause_mission' });
  // An incoming param1 override must not silently flip pause into resume.
  const paused = await RED2.inject(pause, { payload: { param1: 1 } });
  assert.strictEqual(paused.collected[0][0].payload.fields.command, 'MAV_CMD_DO_PAUSE_CONTINUE');
  assert.strictEqual(paused.collected[0][0].payload.fields.param1, 0);

  const { RED: RED3, node: resume } = setup({ command: 'resume_mission' });
  const resumed = await RED3.inject(resume, { payload: {} });
  assert.strictEqual(resumed.collected[0][0].payload.fields.param1, 1);
});


// --- Editor preset fields (#49) ----------------------------------------------

test('presetFields feed the builder statically; msg.payload overrides them (#49)', async () => {
  const { RED, node } = setup({ command: 'takeoff', presetFields: '{"altitude":25}' });
  const fromEditor = await RED.inject(node, { payload: {} });
  assert.strictEqual(fromEditor.collected[0][0].payload.fields.param7, 25);
  const fromMsg = await RED.inject(node, { payload: { altitude: 60 } });
  assert.strictEqual(fromMsg.collected[0][0].payload.fields.param7, 60);
});

test('set_mode presetFields mode resolves via profile firmware (#49)', async () => {
  const { RED, node } = setupWithFirmware(
    { command: 'set_mode', presetFields: '{"mode":"GUIDED"}' },
    { firmware: 'ardupilot', vehicleFamily: 'copter' }
  );
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.param1, 1); // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
  assert.strictEqual(out.fields.param2, 4); // ArduCopter GUIDED
});

test('set_mode presetFields mode resolves per-vehicle (plane differs from copter) (#49)', async () => {
  const { RED, node } = setupWithFirmware(
    { command: 'set_mode', presetFields: '{"mode":"GUIDED"}' },
    { firmware: 'ardupilot', vehicleFamily: 'plane' }
  );
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].payload.fields.param2, 15); // ArduPlane GUIDED
});

test('set_message_interval accepts human-friendly rate_hz (#49)', async () => {
  const { RED, node } = setup({ command: 'set_message_interval', presetFields: '{"message_id":30,"rate_hz":5}' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.param1, 30);
  assert.strictEqual(out.fields.param2, 200000); // 5 Hz -> 200000 us
  // Explicit interval_us wins over rate_hz.
  const explicit = await RED.inject(node, { payload: { interval_us: 50000 } });
  assert.strictEqual(explicit.collected[0][0].payload.fields.param2, 50000);
});

test('arm force via presetFields sets the force magic value (#49)', async () => {
  const { RED, node } = setup({ command: 'arm', presetFields: '{"force":true}' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].payload.fields.param2, 21196);
});

// --- #55: workflow-level validation ----------------------------------------

test('command rejects an out-of-range target_system (#55)', async () => {
  const { RED, node } = setup({ command: 'arm' });
  const { collected } = await RED.inject(node, { payload: { target_system: 999 } });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'INVALID_FIELD');
  assert.strictEqual(collected[0][1].payload.context.field, 'target_system');
});

test('command rejects an out-of-range latitude before sending (#55)', async () => {
  const { RED, node } = setup({ command: 'goto' }); // COMMAND_INT position preset
  const { collected } = await RED.inject(node, { payload: { lat: 200, lon: 8.5, alt: 30 } });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'INVALID_FIELD');
  assert.strictEqual(collected[0][1].payload.context.field, 'lat');
});

test('COMMAND_INT editor-saved param5/param6 degrees are range-validated (#55 review)', async () => {
  // A raw MAV_CMD sent as COMMAND_INT with out-of-range editor param5 (lat) must
  // be rejected, not silently scaled to degE7 and sent.
  const { RED, node } = setup({
    command: 'MAV_CMD_DO_REPOSITION',
    sendAs: 'int',
    fields: '{"param5":200,"param6":8.5}'
  });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'INVALID_FIELD');
  assert.strictEqual(collected[0][1].payload.context.field, 'lat');
});

test('reboot requires explicit runtime confirmation (#49)', async () => {
  // No confirmation anywhere (imported/legacy flow shape): structured error,
  // never a silent reboot.
  const { RED, node } = setup({ command: 'reboot' });
  const blocked = await RED.inject(node, { payload: {} });
  assert.strictEqual(blocked.collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(blocked.collected[0][1].payload.code, 'REBOOT_NOT_CONFIRMED');

  // Editor checkbox confirmation.
  const { RED: RED2, node: confirmed } = setup({ command: 'reboot', presetFields: '{"confirm":true}' });
  const ok = await RED2.inject(confirmed, { payload: {} });
  assert.strictEqual(ok.collected[0][0].payload.fields.command, 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN');
  assert.strictEqual(ok.collected[0][0].payload.fields.param1, 1);

  // Runtime confirmation via msg.payload.
  const { RED: RED3, node: runtime } = setup({ command: 'reboot' });
  const okMsg = await RED3.inject(runtime, { payload: { confirm: true } });
  assert.strictEqual(okMsg.collected[0][0].payload.fields.command, 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN');
});

test('COMMAND_INT coerces numeric-string coordinates into real numbers (#53 review)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_REPOSITION', sendAs: 'int' });
  const { collected } = await RED.inject(node, {
    payload: { lat: '47.397742', lon: '8.545594', alt: '30' }
  });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.x, 473977420);
  assert.strictEqual(out.fields.y, 85455940);
  assert.strictEqual(out.fields.z, 30);
  assert.strictEqual(typeof out.fields.z, 'number');
  // Raw wire values as strings coerce too.
  const raw = await RED.inject(node, { payload: { x: '473977420', y: '85455940', z: '10' } });
  assert.strictEqual(raw.collected[0][0].payload.fields.x, 473977420);
  assert.strictEqual(typeof raw.collected[0][0].payload.fields.x, 'number');
});

// --- Preset required inputs (#87) --------------------------------------------

test('goto without coordinates errors instead of repositioning to 0,0 (#87)', async () => {
  const { RED, node } = setup({ command: 'goto' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'MISSING_REQUIRED_FIELD');
  assert.strictEqual(collected[0][1].payload.context.field, 'lat');
});

test('goto with one-sided lat/lon errors and names the missing field (#87)', async () => {
  const { RED, node } = setup({ command: 'goto' });
  const onlyLat = await RED.inject(node, { payload: { lat: 39.1 } });
  assert.strictEqual(onlyLat.collected[0][1].payload.code, 'MISSING_REQUIRED_FIELD');
  assert.strictEqual(onlyLat.collected[0][1].payload.context.field, 'lon');
  const onlyLon = await RED.inject(node, { payload: { lon: -75.1 } });
  assert.strictEqual(onlyLon.collected[0][1].payload.code, 'MISSING_REQUIRED_FIELD');
  assert.strictEqual(onlyLon.collected[0][1].payload.context.field, 'lat');
});

test('goto accepts explicit zero coordinates (#87)', async () => {
  // 0/0 chosen on purpose is legitimate; only *omitted* coordinates fail.
  const { RED, node } = setup({ command: 'goto' });
  const { collected } = await RED.inject(node, { payload: { lat: 0, lon: 0 } });
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].payload.fields.x, 0);
  assert.strictEqual(collected[0][0].payload.fields.y, 0);
});

test('goto accepts raw wire x/y but requires both (#87)', async () => {
  const { RED, node } = setup({ command: 'goto' });
  const ok = await RED.inject(node, { payload: { x: 391000000, y: -751000000 } });
  assert.strictEqual(ok.collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(ok.collected[0][0].payload.fields.x, 391000000);
  const oneSided = await RED.inject(node, { payload: { x: 391000000 } });
  assert.strictEqual(oneSided.collected[0][1].payload.code, 'MISSING_REQUIRED_FIELD');
  assert.strictEqual(oneSided.collected[0][1].payload.context.field, 'y');
});

test('goto editor preset lat/lon still satisfies the requirement (#87)', async () => {
  const { RED, node } = setup({ command: 'goto', presetFields: '{"lat":39.1,"lon":-75.1}' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].payload.fields.x, 391000000);
});

test('message selector presets require message_id (#87)', async () => {
  for (const command of ['request_message', 'set_message_interval', 'stop_message_interval']) {
    const { RED, node } = setup({ command });
    const missing = await RED.inject(node, { payload: {} });
    assert.strictEqual(missing.collected[0][1].topic, 'mavlink/error', `${command} without message_id must error`);
    assert.strictEqual(missing.collected[0][1].payload.code, 'MISSING_REQUIRED_FIELD');
    assert.strictEqual(missing.collected[0][1].payload.context.field, 'message_id');
    // Explicit 0 (HEARTBEAT) is a legitimate selection.
    const zero = await RED.inject(node, { payload: { message_id: 0 } });
    assert.strictEqual(zero.collected[0][0].topic, 'mavlink/send');
    assert.strictEqual(zero.collected[0][0].payload.fields.param1, 0);
  }
});

test('non-numeric required preset input errors (#87)', async () => {
  const { RED, node } = setup({ command: 'goto' });
  const { collected } = await RED.inject(node, { payload: { lat: 'north', lon: -75.1 } });
  assert.strictEqual(collected[0][1].payload.code, 'MISSING_REQUIRED_FIELD');
  assert.strictEqual(collected[0][1].payload.context.field, 'lat');
});

test('raw MAV_CMD mode stays permissive with no params (#87)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_DO_SET_MODE' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].payload.fields.param1, 0);
});

// --- Profile propagation (#81) ------------------------------------------------

test('await-ack workflow sends carry the node profile id', async () => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  const sent = [];
  RED.nodes.registerType('stub-connection', function StubConnection(config) {
    RED.nodes.createNode(this, config);
    this.name = 'conn';
    let deliver = null;
    this.subscribe = (filter, cb) => {
      deliver = cb;
      return 1;
    };
    this.unsubscribe = () => true;
    this.resolveOutboundIdentity = () => fakeIdentity();
    this.send = (m) => {
      sent.push(m);
      queueMicrotask(() =>
        deliver({
          topic: 'mavlink/COMMAND_ACK',
          payload: { name: 'COMMAND_ACK', sysid: 1, compid: 1, fields: { command: 400, result: 0 } }
        })
      );
      return Promise.resolve();
    };
  });
  RED.create('stub-connection', { id: 'conn1' });
  const node = RED.create('mavlink-ai-command', {
    id: 'c2',
    profile: 'p1',
    connection: 'conn1',
    command: 'arm',
    delivery: 'await'
  });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].topic, 'command/ack');
  assert.strictEqual(sent[0].name, 'COMMAND_LONG');
  assert.strictEqual(sent[0].vehicleProfile, 'p1');
});

/**
 * The command node's connection is only needed for Send/Await delivery;
 * Build only hands mavlink/send to a downstream Out node. So a missing
 * connection is badged only in those modes (#164, #207).
 */
test('command node badges a missing connection only when delivery needs one (#164)', () => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });

  /** Build only, no connection → profile valid, no error badge. */
  const emitOnly = RED.create('mavlink-ai-command', { id: 'c3', profile: 'p1', command: 'arm', delivery: 'build' });
  assert.deepStrictEqual(emitOnly.statusHistory.at(-1), {});

  /** Send & await result, no connection → "missing connection". */
  const needsConn = RED.create('mavlink-ai-command', { id: 'c4', profile: 'p1', command: 'arm', delivery: 'await' });
  assert.deepStrictEqual(needsConn.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'missing connection' });
});

/**
 * Both Codex and Greptile flagged the same gap (#308): before this, a node
 * saved without a `delivery` value only failed at the first input, so it
 * looked healthy right after deploy. resolveDeliveryMode is now also called
 * at construct time, folded into the same node._configError path malformed
 * static JSON already uses, so the red badge appears immediately.
 */
test('command node badges a construct-time DELIVERY_UNSET before any input (#308)', () => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const node = RED.create('mavlink-ai-command', { id: 'c5', profile: 'p1', command: 'arm' }); // no delivery
  assert.ok(node._configError, 'node._configError set at construct time');
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });
});

// --- Delivery modes (#207) ---------------------------------------------------

test('command Build only emits mavlink/send on port 0, nothing on error', async (t) => {
  const { RED, node } = setup({ delivery: 'build', command: 'arm' });
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, {});
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].payload.name, 'COMMAND_LONG');
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('command Send via connection emits command/sent on port 0 (observable fire-and-forget)', async (t) => {
  const { RED, conn, node } = setupWithConnection({ delivery: 'send', command: 'arm' });
  t.after(() => RED.close(node));
  const sends = [];
  conn.send = (env, opts) => { sends.push({ env, opts }); return Promise.resolve(); };
  const { collected } = await RED.inject(node, {});
  assert.strictEqual(sends.length, 1, 'sent directly');
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'command/sent');
  assert.strictEqual(out.payload.sent, true);
});

/**
 * A live redeploy can null/replace node.connection while a Send delivery is
 * awaiting connection.send() — the AWAIT path and the payload/move nodes
 * already capture the connection before the await for this reason (#238);
 * the command node's SEND branch is now the same (#308). Without the
 * capture, a SEND_FAILED error raised after such a swap would name the
 * wrong (or missing) connection instead of the one the message actually
 * went out on.
 */
test('command Send via connection reports the connection actually used, even if node.connection is swapped mid-flight (#238/#308)', async (t) => {
  const { RED, conn, node } = setupWithConnection({ delivery: 'send', command: 'arm' });
  t.after(() => RED.close(node));
  let rejectSend;
  conn.send = () => new Promise((_resolve, reject) => {
    rejectSend = reject;
  });
  const injected = RED.inject(node, {});
  // Let the input handler run synchronously up to its `await connection.send(...)`,
  // where it has already captured node.connection, before swapping it out.
  await new Promise((r) => setTimeout(r, 0));
  node.connection = { name: 'swapped-in-by-redeploy' };
  rejectSend(new Error('boom'));
  const { collected } = await injected;
  const err = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(err.payload.code, 'SEND_FAILED');
  assert.strictEqual(err.payload.connection, 'conn', 'names the connection actually sent on, not the swapped-in one');
});

test('command with no delivery set fails closed on the error port', async (t) => {
  const { RED, node } = setup({ command: 'arm', delivery: undefined }); // no delivery
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, {});
  const err = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(err.payload.code, 'DELIVERY_UNSET');
});

test('command Send & await result emits command/ack on port 0', async (t) => {
  const { RED, conn, node } = setupWithConnection({ delivery: 'await', command: 'arm' });
  t.after(() => RED.close(node));
  stubAckOnConnection(conn); // resolves the CommandSend workflow with a COMMAND_ACK
  const { collected } = await RED.inject(node, {});
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'command/ack');
});
