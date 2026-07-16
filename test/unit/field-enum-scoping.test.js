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
