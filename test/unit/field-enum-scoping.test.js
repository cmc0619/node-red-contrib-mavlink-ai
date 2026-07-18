'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { getMessageClass } = require('../../lib/dialects/dialect-loader');
const { normalizeFields } = require('../../lib/protocol/message-normalizer');
const { screamingToCamel, fieldEnumFor } = require('../../lib/dialects/field-enums');
const { CommandSend } = require('../../lib/command/command-workflow');

/**
 * Field-scoped enum resolution (#153). The XML declares which enum backs each
 * field; historically the compiled dialects dropped that association, so any
 * member of any enum resolved for any numeric field — `HEARTBEAT.type:
 * 'MAV_STATE_ACTIVE'` silently encoded MavState 4 as a MavType. Bundled
 * dialects now recover the association from the package's shipped
 * declarations; custom XML dialects carry it straight off the `enum=`
 * attribute. Fields with no declared enum keep global resolution (a
 * COMMAND_LONG param legitimately receives mode/flag members).
 */

const common = loadDialect('common');

test('bundled dialects recover the field-enum association from shipped declarations (#153)', () => {
  assert.strictEqual(screamingToCamel('MAV_TYPE'), 'MavType');
  assert.strictEqual(screamingToCamel('CUSTOM_COLOR'), 'CustomColor');

  const heartbeat = getMessageClass(common, 'HEARTBEAT');
  const typeField = heartbeat.FIELDS.find((f) => f.source === 'type');
  const modeField = heartbeat.FIELDS.find((f) => f.source === 'custom_mode');
  assert.strictEqual(fieldEnumFor(common, heartbeat, typeField), 'MavType');
  assert.strictEqual(fieldEnumFor(common, heartbeat, modeField), undefined, 'custom_mode is a plain uint32');

  const cmd = getMessageClass(common, 'COMMAND_LONG');
  const cmdField = cmd.FIELDS.find((f) => f.source === 'command');
  assert.strictEqual(fieldEnumFor(common, cmd, cmdField), 'MavCmd');
});

test('a member of an unrelated enum no longer encodes on an enum-backed field (#153)', () => {
  const clazz = getMessageClass(common, 'HEARTBEAT');
  assert.throws(
    () => normalizeFields(common, clazz, { type: 'MAV_STATE_ACTIVE' }),
    (err) => {
      assert.strictEqual(err.code, 'UNRESOLVED_FIELD_VALUE');
      assert.strictEqual(err.context.field, 'type');
      assert.strictEqual(err.context.enum, 'MAV_TYPE', 'the error names the expected enum');
      assert.match(err.message, /MAV_TYPE/);
      return true;
    }
  );
});

test('the declared enum still accepts qualified, bare, and numeric forms (#153)', () => {
  const clazz = getMessageClass(common, 'HEARTBEAT');
  assert.strictEqual(normalizeFields(common, clazz, { type: 'MAV_TYPE_QUADROTOR' }).type, 2);
  assert.strictEqual(normalizeFields(common, clazz, { type: 'QUADROTOR' }).type, 2);
  assert.strictEqual(normalizeFields(common, clazz, { type: '2' }).type, 2);
  assert.strictEqual(normalizeFields(common, clazz, { type: 13 }).type, 13, 'numbers pass through unvalidated');

  const cmd = getMessageClass(common, 'COMMAND_LONG');
  assert.strictEqual(
    normalizeFields(common, cmd, { command: 'MAV_CMD_COMPONENT_ARM_DISARM' }).command,
    400,
    'command scopes to MavCmd'
  );
});

test('fields with no declared enum keep global resolution (#153)', () => {
  /**
   * COMMAND_LONG's generic float params carry values from whatever enum the
   * specific command defines — the XML cannot declare one, so mode/flag
   * members must keep resolving globally there.
   */
  const cmd = getMessageClass(common, 'COMMAND_LONG');
  const out = normalizeFields(common, cmd, { command: 400, param1: 'MAV_MODE_FLAG_SAFETY_ARMED' });
  assert.strictEqual(out.param1, 128);
});

test('custom XML dialects scope through the enum= attribute (#153)', () => {
  const bundle = loadDialect('custom', {
    customDialectPath: path.join(__dirname, '..', 'fixtures', 'dialects', 'custom_enum.xml')
  });
  assert.ok(bundle.valid, 'fixture compiles');
  const lamp = getMessageClass(bundle, 'CUSTOM_LAMP');
  const colorField = lamp.FIELDS.find((f) => f.source === 'color');
  assert.strictEqual(fieldEnumFor(bundle, lamp, colorField), 'CustomColor');

  assert.strictEqual(normalizeFields(bundle, lamp, { color: 'CUSTOM_COLOR_WHITE' }).color, 7);
  assert.throws(
    () => normalizeFields(bundle, lamp, { color: 'CUSTOM_COLOR_MAGENTA' }),
    (err) => err.code === 'UNRESOLVED_FIELD_VALUE' && err.context.enum === 'CUSTOM_COLOR'
  );
  /** The un-annotated field is unaffected. */
  assert.strictEqual(normalizeFields(bundle, lamp, { brightness: '9' }).brightness, 9);
});

test('the command workflow resolves names against MavCmd only (#153)', () => {
  const conn = { send: () => Promise.resolve(), subscribe: () => 1, unsubscribe: () => true };
  const mk = (command) =>
    new CommandSend({ connection: conn, targetSystem: 1, targetComponent: 1, command, enums: common.enums });

  assert.strictEqual(mk('MAV_CMD_NAV_TAKEOFF').command, 22);
  assert.strictEqual(mk(31010).command, 31010, 'raw ids outside the dialect stay usable');
  /** A member of an unrelated enum used to become command 4 silently. */
  assert.throws(
    () => mk('MAV_STATE_EMERGENCY'),
    (err) => err.code === 'BAD_COMMAND'
  );
});

test('a scalar bitmask field OR-combines an array of flags (additive entry)', () => {
  const clazz = getMessageClass(common, 'ATTITUDE_TARGET');
  const out = normalizeFields(common, clazz, {
    type_mask: ['ATTITUDE_TARGET_TYPEMASK_BODY_ROLL_RATE_IGNORE', 'ATTITUDE_TARGET_TYPEMASK_BODY_YAW_RATE_IGNORE']
  });
  assert.strictEqual(out.type_mask, 5, 'flags 1|4 combine, they are not mutually exclusive');
  /** Mixed forms: bare member names and raw numbers OR together too. */
  const mixed = normalizeFields(common, clazz, { type_mask: ['BODY_ROLL_RATE_IGNORE', 64] });
  assert.strictEqual(mixed.type_mask, 65);
  /** An explicit empty array is zero flags, not an error. */
  assert.strictEqual(normalizeFields(common, clazz, { type_mask: [] }).type_mask, 0);
  /** A misspelled flag inside the array still fails with the scoped-enum error. */
  assert.throws(
    () => normalizeFields(common, clazz, { type_mask: ['BODY_ROLL_RATE_IGNORE', 'NOT_A_FLAG'] }),
    (err) => err.code === 'UNRESOLVED_FIELD_VALUE' && err.context.field === 'type_mask'
  );
});

test('an array on a scalar non-bitmask field fails loudly instead of leaking through', () => {
  const clazz = getMessageClass(common, 'HEARTBEAT');
  /** MAV_TYPE is an exclusive enum: an array of members is a caller bug. The
   * per-element mapping used to pass the array to node-mavlink's scalar
   * writer, which silently serialized garbage. */
  assert.throws(
    () => normalizeFields(common, clazz, { type: ['MAV_TYPE_QUADROTOR', 'MAV_TYPE_GCS'] }),
    (err) => {
      assert.strictEqual(err.code, 'FIELD_NOT_ARRAY');
      assert.strictEqual(err.context.field, 'type');
      return true;
    }
  );
  /** A scalar field with no declared enum rejects arrays the same way. */
  assert.throws(
    () => normalizeFields(common, clazz, { custom_mode: [1, 2] }),
    (err) => err.code === 'FIELD_NOT_ARRAY' && err.context.field === 'custom_mode'
  );
});

test('a 64-bit bitmask field ORs an array of flags as BigInt', () => {
  const clazz = getMessageClass(common, 'AUTOPILOT_VERSION');
  const out = normalizeFields(common, clazz, {
    capabilities: ['MAV_PROTOCOL_CAPABILITY_MISSION_FLOAT', 'MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE']
  });
  assert.strictEqual(out.capabilities, 17n, 'uint64 field: 1 | 16 combined as BigInt');
});

test('flag-array elements are validated before the OR (no silent bitwise wrap)', () => {
  const clazz = getMessageClass(common, 'ATTITUDE_TARGET');
  /** JS bitwise would wrap these into valid-looking masks: [-1] -> 4294967295,
   * [2^32] -> 0. Both must fail loudly instead (Codex review on the additive
   * array form). */
  for (const bad of [-1, 4294967296, 1.5]) {
    assert.throws(
      () => normalizeFields(common, clazz, { type_mask: [1, bad] }),
      (err) => ['BAD_FLAG_VALUE', 'FIELD_NOT_INTEGER'].includes(err.code) && err.context.field === 'type_mask',
      `rejects ${bad}`
    );
  }
  /** A flag above the field's unsigned wire width cannot ride the mask —
   * ATTITUDE_TARGET.type_mask is uint8_t, so bit 31 must be rejected. */
  assert.throws(
    () => normalizeFields(common, clazz, { type_mask: [2147483648] }),
    (err) => err.code === 'BAD_FLAG_VALUE' && /8-bit/.test(err.message)
  );
  /** 64-bit fields reject negative elements rather than OR-ing them in. */
  assert.throws(
    () => normalizeFields(common, getMessageClass(common, 'AUTOPILOT_VERSION'), { capabilities: ['-1'] }),
    (err) => err.code === 'BAD_FLAG_VALUE' && err.context.field === 'capabilities'
  );
});

test('an empty flag array on a uint64 bitmask field returns 0n, not Number 0', () => {
  /** Keyed off the FIELD type: with no elements to inspect, the BigInt path
   * must still engage or the uint64 serializer receives the wrong type. */
  const clazz = getMessageClass(common, 'AUTOPILOT_VERSION');
  assert.strictEqual(normalizeFields(common, clazz, { capabilities: [] }).capabilities, 0n);
});

test('a one-flag *_FLAGS bitmask still accepts the array form (name rescue)', () => {
  /** HIL_ACTUATOR_CONTROLS_FLAGS defines only LOCKSTEP = 1; the flag-count
   * floor alone would send this to FIELD_NOT_ARRAY (Codex review). The field
   * is uint64, so the single flag also proves the BigInt path end-to-end. */
  const clazz = getMessageClass(common, 'HIL_ACTUATOR_CONTROLS');
  const out = normalizeFields(common, clazz, { flags: ['HIL_ACTUATOR_CONTROLS_FLAGS_LOCKSTEP'] });
  assert.strictEqual(out.flags, 1n);
});
