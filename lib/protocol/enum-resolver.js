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
      enumsByName[exportName] = value;
      const prefix = camelToScreaming(exportName);
      for (const [k, v] of Object.entries(value)) {
        // Only forward (name -> number) mappings, skip reverse numeric keys.
        if (/^\d+$/.test(k)) {
          continue;
        }
        const num = value[k];
        if (typeof num !== 'number') {
          continue;
        }
        const fullName = `${prefix}_${k}`;
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
  return `${camelToScreaming(enumName)}_${member}`;
}

module.exports = {
  camelToScreaming,
  isEnumObject,
  buildEnumIndex,
  resolveEnumValue,
  lookup,
  nameFor
};
