'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Field→enum association for encode-time enum scoping (#153).
 *
 * MAVLink XML declares which enum backs a field (`<field ... enum="MAV_TYPE">`),
 * but the compiled `mavlink-mappings` JS drops that association — which is why
 * enum-name resolution has historically been global: any member of any enum
 * resolved for any numeric field, so `HEARTBEAT.type: 'MAV_STATE_ACTIVE'`
 * silently encoded MavState 4 as a MavType.
 *
 * The association is recoverable without new build tooling: the package ships
 * generated `.d.ts` declarations whose class properties are typed with the
 * backing enum (`type: MavType;`) while plain fields carry wire-type aliases
 * (`customMode: uint32_t;`). This module parses those declarations once per
 * dialect module and caches the result. The format is generator-produced and
 * regular; if a declaration file is missing or unreadable the module degrades
 * to an empty association (global resolution), never a load failure.
 *
 * Custom XML dialects don't need this file at all — the runtime compiler sees
 * the `enum=` attribute directly and attaches a `FIELD_ENUMS` static to each
 * generated class (see xml-dialect-compiler).
 */

/**
 * Wire-type aliases and non-enum declaration types. Anything else appearing as
 * a class property type in the generated `.d.ts` names the field's enum class.
 *
 * @type {RegExp}
 */
const NON_ENUM_TYPE = /^(u?int\d+_t|float|double|char|string|number|bigint|boolean|uint8_t_mavlink_version|MavLinkPacketField)(\[\])?$/;

/**
 * Convert an XML enum name to its compiled class name: 'MAV_TYPE' -> 'MavType',
 * 'CUSTOM_COLOR' -> 'CustomColor'. Inverse of enum-resolver's camelToScreaming,
 * matching the generator's naming convention.
 *
 * @param {string} name  screaming-snake XML enum name
 * @returns {string}
 */
function screamingToCamel(name) {
  return String(name)
    .toLowerCase()
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}

/**
 * Parse one generated `.d.ts` into class -> (camel field name -> enum class
 * name). Only classes extending MavLinkData are message classes; only
 * properties typed with a non-primitive name are enum-backed.
 *
 * @param {string} text  the declaration file contents
 * @returns {Map<string, Map<string, string>>}
 */
function parseDtsFieldEnums(text) {
  const out = new Map();
  const classRe = /export declare class (\w+) extends MavLinkData \{([\s\S]*?)\n\}/g;
  let cls;
  while ((cls = classRe.exec(text))) {
    const fields = new Map();
    const propRe = /^ {4}(\w+): ([\w[\]]+);$/gm;
    let prop;
    while ((prop = propRe.exec(cls[2]))) {
      if (!NON_ENUM_TYPE.test(prop[2])) {
        fields.set(prop[1], prop[2].replace(/\[\]$/, ''));
      }
    }
    if (fields.size) {
      out.set(cls[1], fields);
    }
  }
  return out;
}

/** @type {Map<string, Map<string, Map<string, string>>>} per-module cache */
const moduleCache = new Map();

/**
 * The field→enum table for one bundled dialect module, parsed from its shipped
 * declaration file and cached. Missing/unreadable declarations yield an empty
 * table — enum scoping is a fidelity upgrade, never a reason a dialect fails
 * to load.
 *
 * @param {string} moduleName  bundled module name, e.g. 'common'
 * @returns {Map<string, Map<string, string>>}
 */
function moduleFieldEnums(moduleName) {
  if (moduleCache.has(moduleName)) {
    return moduleCache.get(moduleName);
  }
  let table = new Map();
  try {
    const libDir = path.join(path.dirname(require.resolve('mavlink-mappings')), 'lib');
    table = parseDtsFieldEnums(fs.readFileSync(path.join(libDir, `${moduleName}.d.ts`), 'utf8'));
  } catch (e) {
    /** No declarations available — degrade to global resolution. */
  }
  moduleCache.set(moduleName, table);
  return table;
}

/**
 * The merged field→enum table for a bundled dialect chain. Later modules win
 * on a class-name collision (same-name redefinitions follow include order).
 *
 * @param {string[]} chain  module names in include order
 * @returns {Map<string, Map<string, string>>}
 */
function chainFieldEnums(chain) {
  const merged = new Map();
  for (const moduleName of chain) {
    for (const [className, fields] of moduleFieldEnums(moduleName)) {
      merged.set(className, fields);
    }
  }
  return merged;
}

/**
 * The enum class name backing one field of one message class, or undefined for
 * a plain (non-enum) field or when no association is known. Custom-XML classes
 * carry their own FIELD_ENUMS static; bundled classes resolve through the
 * bundle's merged `.d.ts` table.
 *
 * @param {?object} bundle  dialect bundle (may carry fieldEnums)
 * @param {?Function} clazz  message class
 * @param {object} field  MavLinkPacketField metadata
 * @returns {string|undefined} compiled enum class name, e.g. 'MavType'
 */
function fieldEnumFor(bundle, clazz, field) {
  if (!clazz || !field) {
    return undefined;
  }
  if (clazz.FIELD_ENUMS && clazz.FIELD_ENUMS[field.name]) {
    return clazz.FIELD_ENUMS[field.name];
  }
  const table = bundle && bundle.fieldEnums ? bundle.fieldEnums.get(clazz.name) : undefined;
  return table ? table.get(field.name) : undefined;
}

module.exports = { screamingToCamel, parseDtsFieldEnums, moduleFieldEnums, chainFieldEnums, fieldEnumFor };
