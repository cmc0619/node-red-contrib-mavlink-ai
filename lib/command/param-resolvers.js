'use strict';

const { modeChoices } = require('./flight-modes');

/**
 * Profile/target-context resolvers for raw `MAV_CMD_*` parameters (issue #97).
 *
 * Some command parameters cannot be described by any single global table: the
 * same numeric slot means different things depending on the profile firmware,
 * vehicle type, or the target component the command addresses. A parameter
 * whose control spec names a `resolver` (see param-metadata.js) is populated at
 * editor time by calling that resolver here with the current runtime context,
 * so changing the profile or target component refreshes the available choices.
 *
 * Each resolver returns:
 *   {
 *     scope:   'profile' | 'component' | null   which context it depends on
 *     generic: boolean                          true only when the choices are
 *                                               plain dialect metadata, not
 *                                               firmware/profile-specific
 *     choices: [{ name, value, description? }]  readable name + numeric wire value
 *     label?:  string                           short UI label for the choice set
 *     enum?:   string                           source enum name where applicable
 *   }
 *
 * The mechanism is reusable: new resolvers register here, and the editor renders
 * any of them the same way (a dropdown with a "Custom value…" numeric fallback).
 */

// Component type -> the dialect enum whose members are that component's mode /
// action values. A component-addressed parameter resolves to the right choice
// set from generic dialect metadata by selecting the enum for the target
// component type, rather than assuming one table fits every component.
const COMPONENT_MODE_ENUMS = {
  camera: 'CAMERA_MODE',
  gimbal: 'MAV_MOUNT_MODE',
  mount: 'MAV_MOUNT_MODE',
  autopilot: 'MAV_MOUNT_MODE'
};

const RESOLVERS = {
  /**
   * Firmware + vehicle-type aware flight modes (DO_SET_MODE custom_mode). The
   * same name maps to a different wire value per vehicle class.
   */
  'profile-flight-mode'(ctx) {
    const choices = modeChoices(ctx.firmware, ctx.vehicleType);
    const label = choices.length
      ? `${ctx.firmware}${ctx.vehicleType ? ' ' + ctx.vehicleType : ''} modes`
      : '';
    return { scope: 'profile', generic: false, label, choices };
  },

  /**
   * Component-addressed mode/action values (e.g. mount/gimbal/camera). The valid
   * choice set depends on the target component type; the values themselves come
   * from the dialect enum tables passed in ctx.enums, so custom dialects that
   * define those enums get the same treatment.
   */
  'component-mode'(ctx) {
    const componentType = String(ctx.componentType || 'autopilot').toLowerCase();
    const enumName = COMPONENT_MODE_ENUMS[componentType] || null;
    const table = (enumName && ctx.enums && ctx.enums[enumName]) || [];
    return {
      scope: 'component',
      generic: false,
      enum: enumName,
      label: enumName ? `${componentType} (${enumName})` : '',
      choices: table.map((e) => ({ name: e.name, value: e.value, description: e.description }))
    };
  }
};

/**
 * Resolve a named resolver against the given context.
 *
 * @param {string} resolver  resolver name (e.g. 'profile-flight-mode')
 * @param {object} ctx       { firmware, vehicleType, componentType, enums }
 * @returns {{ resolver: string, scope: ?string, generic: boolean,
 *   choices: object[], label?: string, enum?: ?string, unknownResolver?: boolean }}
 */
function resolveParamChoices(resolver, ctx) {
  const fn = RESOLVERS[resolver];
  if (!fn) {
    return { resolver, scope: null, generic: true, choices: [], unknownResolver: true };
  }
  return Object.assign({ resolver }, fn(ctx || {}));
}

module.exports = { resolveParamChoices, RESOLVERS, COMPONENT_MODE_ENUMS };
