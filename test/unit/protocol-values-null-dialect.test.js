'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveFrame } = require('../../lib/move/setpoint');
const { buildPayload } = require('../../lib/payload/payload');
const { resolveParamEncoding } = require('../../lib/param/param-encoding');

/**
 * #309 review ("apply core"): dialect-independent common protocol values resolve
 * from the always-available core bundle when a profile has no loaded dialect
 * (enums: null) — so core operations keep working even for a profile whose
 * custom dialect failed to load. Genuinely dialect-specific values (e.g.
 * ArduPilot GripperActions) still fail closed with ENUM_VALUE_UNAVAILABLE.
 * (The constructor-level equivalents are covered in command-workflow,
 * mission-workflow, and vehicle-registry tests.)
 */

test('resolveFrame resolves a common MavFrame from core with no dialect', () => {
  assert.strictEqual(resolveFrame('LOCAL_NED', null), 1); // MAV_FRAME_LOCAL_NED
  assert.strictEqual(resolveFrame('GLOBAL_INT', null), 5); // MAV_FRAME_GLOBAL_INT
});

test('buildPayload builds a common (camera) action from core with no dialect', () => {
  const built = buildPayload('camera_photo', { enums: null, count: 1, targetSystem: 1, targetComponent: 1 });
  assert.strictEqual(built.name, 'COMMAND_LONG');
  // MAV_CMD_IMAGE_START_CAPTURE resolved from the core bundle to its number.
  assert.strictEqual(typeof built.fields.command, 'number');
});

test('the fail-closed contract is preserved: an unknown member still throws with no dialect', () => {
  // Core resolution does not weaken the strict boundary — a member absent from
  // the core bundle still fails with ENUM_VALUE_UNAVAILABLE rather than
  // silently returning a wrong value.
  assert.throws(
    () => resolveFrame('NOT_A_REAL_FRAME', null),
    (err) => err.code === 'ENUM_VALUE_UNAVAILABLE'
  );
});

test('resolveParamEncoding resolves MavProtocolCapability from core with no dialect', () => {
  const enc = resolveParamEncoding({ firmware: 'px4', enums: null });
  assert.strictEqual(enc.encoding, 'bytewise');
});
