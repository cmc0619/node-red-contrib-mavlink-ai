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

test('flags bitmask-enum fields so editors render additive entry', () => {
  const md = buildMetadata('ardupilotmega');
  const fieldOf = (msg, field) => md.messages[msg].fields.find((f) => f.name === field);
  // Real bitmasks: flags are OR-combined, not mutually exclusive.
  assert.strictEqual(fieldOf('ATTITUDE_TARGET', 'type_mask').bitmask, true);
  assert.strictEqual(fieldOf('SET_POSITION_TARGET_LOCAL_NED', 'type_mask').bitmask, true);
  assert.strictEqual(fieldOf('HEARTBEAT', 'base_mode').bitmask, true); // MAV_MODE_FLAG
  // Ordinary exclusive enums stay single-select.
  assert.strictEqual(fieldOf('HEARTBEAT', 'type').bitmask, false); // MAV_TYPE
  assert.strictEqual(fieldOf('MISSION_ITEM_INT', 'frame').bitmask, false); // MAV_FRAME
  // CAMERA_MODE is {0,1,2}: two accidental power-of-two members must not
  // flip an exclusive mode enum into a checklist (three-flag floor).
  assert.strictEqual(fieldOf('CAMERA_SETTINGS', 'mode_id').bitmask, false);
  // A one-flag bitmask (HIL_ACTUATOR_CONTROLS_FLAGS = {LOCKSTEP: 1}) is
  // rescued by its *_FLAGS naming (Codex review).
  assert.strictEqual(fieldOf('HIL_ACTUATOR_CONTROLS', 'flags').bitmask, true);
  // Non-enum fields carry the flag unset.
  assert.strictEqual(fieldOf('COMMAND_LONG', 'param1').bitmask, false);
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

test('messages and fields carry visible descriptions from the .d.ts JSDoc (#45)', () => {
  const md = buildMetadata('ardupilotmega');
  const fov = md.messages.CAMERA_FOV_STATUS;
  assert.match(fov.description, /field of view of a camera/i);
  const timeBootMs = fov.fields.find((f) => f.name === 'time_boot_ms');
  assert.match(timeBootMs.description, /Timestamp \(time since system boot\)/);
  // The JSDoc's literal "Units: ms" line must not be duplicated into the
  // description — units already ride in their own metadata field.
  assert.ok(!/Units:/.test(timeBootMs.description));
  assert.strictEqual(timeBootMs.units, 'ms');
});

test('enum members carry descriptions, merged across the include chain (#45)', () => {
  const md = buildMetadata('ardupilotmega');
  // Defined in common:
  const arm = md.enums.MAV_CMD.find((e) => e.name === 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.match(arm.description, /Arms \/ Disarms a component/);
  // Defined only in the ardupilotmega extension of the same enum:
  const resume = md.enums.MAV_CMD.find((e) => e.name === 'MAV_CMD_DO_SET_RESUME_REPEAT_DIST');
  assert.match(resume.description, /distance to be repeated/i);
  const active = md.enums.MAV_STATE.find((e) => e.name === 'MAV_STATE_ACTIVE');
  assert.match(active.description, /active/i);
});

test('commands carry a command-level description (#45)', () => {
  const md = buildMetadata('ardupilotmega');
  assert.match(md.commands.MAV_CMD_NAV_LOITER_TIME.description, /Loiter at the specified/i);
  // Param descriptions keep working as before.
  assert.match(md.commands.MAV_CMD_NAV_LOITER_TIME.params[0].description, /Loiter time/);
});

test('invalid dialect yields an invalid metadata object (no throw)', () => {
  const md = buildMetadata('nope-not-a-dialect');
  assert.strictEqual(md.valid, false);
  assert.deepStrictEqual(md.messages, {});
  // Invalid metadata keeps the same shape as valid so callers can rely on it.
  assert.deepStrictEqual(md.enums, {});
  assert.deepStrictEqual(md.commands, {});
});
