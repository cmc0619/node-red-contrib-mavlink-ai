'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildMetadata } = require('../../lib/dialects/message-metadata');

test('builds message + field + enum metadata for a dialect', () => {
  const md = buildMetadata('ardupilotmega');
  assert.ok(md.valid);
  assert.ok(md.messages.HEARTBEAT);
  assert.strictEqual(md.messages.COMMAND_LONG.id, 76);
  const cmd = md.messages.COMMAND_LONG.fields.find((f) => f.name === 'command');
  assert.ok(cmd);
  assert.strictEqual(cmd.type, 'uint16_t');
});

test('recovers per-field enum association from .d.ts', () => {
  const md = buildMetadata('ardupilotmega');
  const enumOf = (msg, field) => md.messages[msg].fields.find((f) => f.name === field).enum;
  assert.strictEqual(enumOf('COMMAND_LONG', 'command'), 'MAV_CMD');
  assert.strictEqual(enumOf('HEARTBEAT', 'type'), 'MAV_TYPE');
  assert.strictEqual(enumOf('HEARTBEAT', 'autopilot'), 'MAV_AUTOPILOT');
  assert.strictEqual(enumOf('MISSION_ITEM_INT', 'frame'), 'MAV_FRAME');
  // Non-enum numeric field has no enum.
  assert.strictEqual(enumOf('COMMAND_LONG', 'param1'), null);
});

test('enum tables carry readable full names and values', () => {
  const md = buildMetadata('ardupilotmega');
  assert.ok(Array.isArray(md.enums.MAV_CMD));
  const arm = md.enums.MAV_CMD.find((e) => e.name === 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.ok(arm);
  assert.strictEqual(arm.value, 400);
  const quad = md.enums.MAV_TYPE.find((e) => e.name === 'MAV_TYPE_QUADROTOR');
  assert.strictEqual(quad.value, 2);
});

test('exposes command-specific param labels (MAV_CMD -> named params)', () => {
  const md = buildMetadata('ardupilotmega');
  const wp = md.commands.MAV_CMD_NAV_WAYPOINT;
  assert.ok(wp, 'NAV_WAYPOINT command metadata present');
  assert.deepStrictEqual(
    wp.params.map((p) => p.index + ':' + p.name),
    ['1:hold', '2:acceptRadius', '3:passRadius', '4:yaw', '5:latitude', '6:longitude', '7:altitude']
  );
  assert.strictEqual(wp.params[0].units, 's');
  assert.match(wp.params[0].description, /Hold time/);
});

test('resolves real param indices for commands with gaps', () => {
  const md = buildMetadata('ardupilotmega');
  // NAV_TAKEOFF: pitch=param1, yaw=param4 (params 2/3 unused) — must not be
  // renumbered sequentially.
  const takeoff = md.commands.MAV_CMD_NAV_TAKEOFF;
  const yaw = takeoff.params.find((p) => p.name === 'yaw');
  assert.strictEqual(yaw.index, 4);
  assert.strictEqual(takeoff.params[0].name, 'pitch');
  assert.strictEqual(takeoff.params[0].index, 1);
});

test('invalid dialect yields an invalid metadata object (no throw)', () => {
  const md = buildMetadata('nope-not-a-dialect');
  assert.strictEqual(md.valid, false);
  assert.deepStrictEqual(md.messages, {});
});
