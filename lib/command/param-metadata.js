'use strict';

/**
 * Reusable control hints for raw `MAV_CMD_*` parameters (issue #97).
 *
 * Raw MAV_CMD mode is the advanced escape hatch, but most command parameters
 * carry richer semantics than "a number": an enum, a flag bitmask, a boolean,
 * or a value whose meaning depends on the profile firmware / vehicle type /
 * target component. The generic MAVLink metadata we already recover from the
 * `.d.ts` (name, description, units, and — added in this change — min/max/
 * increment) does not say *which* enum a command param references, and can
 * never express firmware/vehicle/component context.
 *
 * This narrow registry supplies that missing association so the raw command
 * editor can render metadata-driven controls (dropdowns, bitmask checklists,
 * profile-aware mode pickers) instead of bare numeric inputs. It is deliberately
 * small and generic — each entry names a *reusable control kind*, not a bespoke
 * per-command form:
 *
 *   { enum: 'MAV_FRAME' }         ordinary enum   -> dropdown from the dialect
 *   { bitmask: 'MAV_MODE_FLAG' }  flag bitmask    -> multi-select checklist
 *   { boolean: true }             boolean         -> checkbox
 *   { control, resolver,          context-specific-> resolver-populated dropdown
 *     profileAware, componentAware }               (see param-resolvers.js)
 *
 * Custom dialects can add hints at runtime via {@link registerParamControl}
 * without a handwritten friendly preset per command. Anything not covered here
 * still gets generic constraint metadata (min/max/increment) or falls back to a
 * plain numeric input.
 */

// MAV_CMD name -> { <paramIndex>: controlSpec }. Only params whose meaning the
// XML/.d.ts cannot express on its own need an entry.
const COMMAND_PARAM_CONTROLS = {
  MAV_CMD_DO_SET_MODE: {
    // base_mode is a MAV_MODE_FLAG bitmask; custom_mode is firmware + vehicle
    // specific (GUIDED is 4 on ArduCopter, 15 on ArduPlane) so it defers to the
    // profile-aware flight-mode resolver rather than any global table.
    1: { bitmask: 'MAV_MODE_FLAG' },
    2: { control: 'flight-mode', resolver: 'profile-flight-mode', profileAware: true }
  },
  MAV_CMD_DO_CHANGE_SPEED: {
    1: { enum: 'SPEED_TYPE' }
  },
  MAV_CMD_DO_SET_ROI: {
    1: { enum: 'MAV_ROI' }
  },
  MAV_CMD_DO_MOUNT_CONFIGURE: {
    1: { enum: 'MAV_MOUNT_MODE' }
  },
  MAV_CMD_SET_CAMERA_MODE: {
    2: { enum: 'CAMERA_MODE' }
  },
  // A component-addressed parameter: the mount/gimbal mode's valid choices come
  // from the target component type, not one global table. Demonstrates the
  // component-aware resolver path (non-flight-mode, profile/component-specific).
  MAV_CMD_DO_MOUNT_CONTROL: {
    7: { control: 'component-mode', resolver: 'component-mode', profileAware: true, componentAware: true }
  }
};

/**
 * Register (or override) a control hint for one command parameter. Lets custom
 * XML dialects and integrations add context-specific resolver hints without a
 * hand-written preset per command (issue #97).
 *
 * @param {string} command  MAV_CMD_* name
 * @param {number} index    1..7
 * @param {object} spec     control spec (enum|bitmask|boolean|control|resolver…)
 * @returns {void}
 */
function registerParamControl(command, index, spec) {
  if (!command || !index || !spec) {
    return;
  }
  const byIndex = COMMAND_PARAM_CONTROLS[command] || (COMMAND_PARAM_CONTROLS[command] = {});
  byIndex[Number(index)] = Object.assign({}, byIndex[Number(index)], spec);
}

/**
 * The registered control hint for a command parameter, if any.
 *
 * @param {string} command  MAV_CMD_* name
 * @param {number} index    1..7
 * @returns {?object}
 */
function paramControl(command, index) {
  const byIndex = COMMAND_PARAM_CONTROLS[command];
  return (byIndex && byIndex[Number(index)]) || null;
}

/**
 * Heuristic boolean detection from generic MAVLink metadata, for params without
 * an explicit registry entry. MAVLink marks true/false params with the MAV_BOOL
 * convention in their description ("MAV_BOOL_FALSE: ..."), often alongside a
 * 0..1 / increment-1 constraint. Only the description signal is trusted here so
 * a genuine 0..1 continuous value (e.g. a normalized ratio) is never mistaken
 * for a checkbox.
 *
 * @param {object} param  { description, min, max, increment }
 * @returns {boolean}
 */
function looksBoolean(param) {
  if (!param || !param.description) {
    return false;
  }
  return /\bMAV_BOOL_(?:TRUE|FALSE)\b/.test(param.description);
}

module.exports = {
  registerParamControl,
  paramControl,
  looksBoolean
};
