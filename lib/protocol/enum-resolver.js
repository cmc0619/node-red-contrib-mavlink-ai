'use strict';

/**
 * Enum resolution for MAVLink dialects.
 *
 * The `mavlink-mappings` package compiles each MAVLink enum to a TypeScript
 * enum object with a bidirectional mapping:
 *
 *   MavCmd.COMPONENT_ARM_DISARM === 400
 *   MavCmd[400] === "COMPONENT_ARM_DISARM"
 *
 * Note that the stored member name is *unprefixed* ("COMPONENT_ARM_DISARM"),
 * while MAVLink and DESIGN.md use the fully-qualified form
 * ("MAV_CMD_COMPONENT_ARM_DISARM"). This module builds an index that accepts
 * both forms so flow authors can use whichever they have in front of them.
 */

/**
 * Convert an enum class name like "MavCmd" to its screaming-snake prefix
 * "MAV_CMD". Inserts an underscore before each uppercase letter that follows
 * a lowercase letter or digit, then uppercases the whole thing.
 */
function camelToScreaming(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/**
 * Detect whether an exported value is a compiled enum object (has at least one
 * reverse numeric-keyed mapping).
 */
function isEnumObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (/^\d+$/.test(key) && typeof value[key] === 'string') {
      return true;
    }
  }
  return false;
}

/**
 * Build an enum index from one or more dialect modules.
 *
 * @returns {object} index with:
 *   byFullName  Map<string, number>  e.g. "MAV_CMD_COMPONENT_ARM_DISARM" -> 400
 *   byMember    Map<string, number>  e.g. "COMPONENT_ARM_DISARM" -> 400 (may collide)
 *   enumsByName object  { MavCmd: <enumObject>, ... }
 */
function buildEnumIndex(modules) {
  const byFullName = new Map();
  const byMember = new Map();
  const enumsByName = {};

  for (const mod of modules) {
    if (!mod) {
      continue;
    }
    for (const [exportName, value] of Object.entries(mod)) {
      if (!isEnumObject(value)) {
        continue;
      }
      // Merge, don't overwrite: an enum such as MavCmd is declared by several
      // modules in the include chain (common defines the base commands,
      // ardupilotmega adds its own) and each module exports a *separate* object
      // holding only its own members. Last-wins would leave enumsByName['MavCmd']
      // as the ardupilotmega subset, breaking reverse lookups (nameFor/getEnum)
      // for every base command (#64). Merge members across modules instead,
      // first-value-wins on any numeric collision to stay deterministic.
      const merged = enumsByName[exportName] || (enumsByName[exportName] = {});
      for (const [k, v] of Object.entries(value)) {
        if (!(k in merged)) {
          merged[k] = v;
        }
      }
      const prefix = camelToScreaming(exportName);
      for (const [k, num] of Object.entries(value)) {
        // Only forward (name -> number) mappings, skip reverse numeric keys.
        if (/^\d+$/.test(k)) {
          continue;
        }
        if (typeof num !== 'number') {
          continue;
        }
        /**
         * The generator keeps a member's *full* source name when stripping the
         * enum prefix would leave a leading digit (e.g. GPS_FIX_TYPE_2D_FIX
         * stays whole because "2D_FIX" is not a valid identifier). Prefixing
         * again would double it (GPS_FIX_TYPE_GPS_FIX_TYPE_2D_FIX).
         */
        const fullName = k.startsWith(`${prefix}_`) ? k : `${prefix}_${k}`;
        if (!byFullName.has(fullName)) {
          byFullName.set(fullName, num);
        }
        if (!byMember.has(k)) {
          byMember.set(k, num);
        }
      }
    }
  }

  return { byFullName, byMember, enumsByName };
}

/**
 * Resolve a single field value that may be an enum name string into its number.
 * Numbers and unknown strings are returned unchanged (callers may pass literal
 * numeric strings or values for non-enum fields).
 */
function resolveEnumValue(index, value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return value;
  }
  // Numeric string -> number.
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const upper = trimmed.toUpperCase();
  if (index.byFullName.has(upper)) {
    return index.byFullName.get(upper);
  }
  if (index.byMember.has(upper)) {
    return index.byMember.get(upper);
  }
  return value;
}

/**
 * Resolve a value to a number using ONLY the named enum (e.g. 'MavCmd'), so a
 * name belonging to a *different* enum can't resolve through the global index —
 * the whole-index {@link resolveEnumValue} would happily turn a 'MAV_FRAME_*'
 * string into that frame's number. A number or numeric string passes through
 * (raw/custom ids are allowed); a name, fully-qualified ('MAV_CMD_X') or bare
 * member ('X'), resolves against that enum only; anything unresolvable returns
 * undefined.
 *
 * @param {object} index     enum index from {@link buildEnumIndex}
 * @param {string} enumName  compiled enum class name, e.g. 'MavCmd'
 * @param {*} value
 * @returns {number|undefined}
 */
function resolveInEnum(index, enumName, value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const e = index && index.enumsByName ? index.enumsByName[enumName] : null;
  if (!e) {
    return undefined;
  }
  const prefix = camelToScreaming(enumName);
  const upper = trimmed.toUpperCase();
  const member = upper.startsWith(`${prefix}_`) ? upper.slice(prefix.length + 1) : upper;
  for (const key of [member, upper]) {
    if (typeof e[key] === 'number') {
      return e[key];
    }
  }
  return undefined;
}

/**
 * Look up the numeric value of an enum member by name, or undefined.
 */
function lookup(index, name) {
  if (typeof name !== 'string') {
    return undefined;
  }
  const upper = name.trim().toUpperCase();
  if (index.byFullName.has(upper)) {
    return index.byFullName.get(upper);
  }
  if (index.byMember.has(upper)) {
    return index.byMember.get(upper);
  }
  return undefined;
}

/**
 * Resolve a number back to a fully-qualified enum name for a named enum.
 * Returns undefined if the enum or value is unknown.
 */
function nameFor(index, enumName, value) {
  const e = index.enumsByName[enumName];
  if (!e) {
    return undefined;
  }
  const member = e[value];
  if (typeof member !== 'string') {
    return undefined;
  }
  /**
   * Digit-leading members keep their full source name in the generated enum
   * (see buildEnumIndex); re-prefixing those would produce an invalid, doubled
   * MAVLink name like GPS_FIX_TYPE_GPS_FIX_TYPE_2D_FIX.
   */
  const prefix = camelToScreaming(enumName);
  return member.startsWith(`${prefix}_`) ? member : `${prefix}_${member}`;
}

module.exports = {
  camelToScreaming,
  buildEnumIndex,
  resolveEnumValue,
  resolveInEnum,
  lookup,
  nameFor
};
