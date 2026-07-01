'use strict';

const fs = require('fs');
const path = require('path');
const { loadDialect } = require('./dialect-loader');

/**
 * Editor metadata for a dialect: the message list, each message's fields
 * (name/type/units/enum), and the enum value tables. This powers the dynamic
 * field editor in mavlink-ai-build (the aigen-style "pick a message, get its
 * fields with readable enum dropdowns" UX).
 *
 * The per-field enum association is the tricky part: the runtime `FIELDS`
 * metadata only records the primitive wire type (uint8_t), not which enum a
 * field uses. That association only lives in the MAVLink XML — but the
 * generated `mavlink-mappings` TypeScript declarations annotate each field with
 * its enum class (e.g. `command: MavCmd`). So we parse the bundled `.d.ts`
 * files to recover field -> enum, fully offline (no XML fetch required).
 */

const cache = new Map();

/**
 * Resolve the directory of mavlink-mappings' compiled `lib` (where the per
 * dialect `.d.ts` files live).
 *
 * @returns {string}
 */
function mappingsLibDir() {
  // require.resolve gives .../mavlink-mappings/dist/index.js
  const index = require.resolve('mavlink-mappings');
  return path.join(path.dirname(index), 'lib');
}

/**
 * Parse one dialect `.d.ts` file into a map of
 * className -> { camelFieldName: EnumClassName } for fields whose declared type
 * is a known enum.
 *
 * @param {string} dialectName  bundled dialect module name (e.g. "common")
 * @param {Set<string>} enumNames  known enum class names for this bundle
 * @returns {Object<string, Object<string, string>>}
 */
function parseFieldEnums(dialectName, enumNames) {
  const file = path.join(mappingsLibDir(), `${dialectName}.d.ts`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // The .d.ts is how we recover per-field enum associations. If the
    // mavlink-mappings package layout ever changes, warn loudly rather than
    // silently dropping enum dropdowns.
    // eslint-disable-next-line no-console
    console.warn(
      `[mavlink-ai] could not read type declarations for dialect '${dialectName}' (${file}): ` +
        `${e.message}. Enum dropdowns for this dialect will be unavailable.`
    );
    return {};
  }

  const result = {};
  // Split on class declarations; each chunk begins right after the class name.
  const classRe = /export declare class (\w+) extends MavLinkData \{([\s\S]*?)\n\}/g;
  let m;
  while ((m = classRe.exec(text)) !== null) {
    const className = m[1];
    const body = m[2];
    const fieldRe = /^\s{4}(\w+):\s*(\w+);/gm;
    let f;
    const fieldMap = {};
    while ((f = fieldRe.exec(body)) !== null) {
      const fieldName = f[1];
      const typeName = f[2];
      if (enumNames.has(typeName)) {
        fieldMap[fieldName] = typeName;
      }
    }
    if (Object.keys(fieldMap).length) {
      result[className] = fieldMap;
    }
  }
  return result;
}

/**
 * Convert a CamelCase enum class name to its screaming-snake prefix, matching
 * the enum-resolver convention (MavCmd -> MAV_CMD).
 *
 * @param {string} name
 * @returns {string}
 */
function screaming(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/**
 * Build the editor metadata for a dialect.
 *
 * @param {string} dialectName  e.g. "ardupilotmega"
 * @param {object} [opts]  passed to loadDialect (e.g. customDialectPath)
 * @returns {{dialect: string, valid: boolean, error: ?object,
 *   messages: object, enums: object}}
 */
function buildMetadata(dialectName, opts = {}) {
  const key = `${dialectName}:${opts.customDialectPath || ''}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  const bundle = loadDialect(dialectName, opts);
  if (!bundle.valid) {
    const invalid = { dialect: dialectName, valid: false, error: bundle.error, messages: {}, enums: {} };
    cache.set(key, invalid);
    return invalid;
  }

  const enumNames = new Set(Object.keys(bundle.enums.enumsByName));

  // Merge per-class field->enum maps across the dialect's include chain
  // (re-derived by name, since the bundle doesn't expose chain members).
  const fieldEnumsByClass = {};
  for (const name of dialectChainNames(dialectName, opts)) {
    Object.assign(fieldEnumsByClass, parseFieldEnums(name, enumNames));
  }

  // Map each class *reference* to its export name. Keying by MSG_NAME collides,
  // because convenience command subclasses inherit MSG_NAME (e.g. "COMMAND_LONG")
  // from the real message class; keying by the class object avoids that.
  const nameByClassRef = new Map();
  for (const mod of bundle.modules) {
    for (const [exportName, val] of Object.entries(mod)) {
      if (val && typeof val === 'function' && val.MSG_NAME && !nameByClassRef.has(val)) {
        nameByClassRef.set(val, exportName);
      }
    }
  }

  const messages = {};
  for (const clazz of Object.values(bundle.registry)) {
    const className = nameByClassRef.get(clazz);
    const fieldEnums = (className && fieldEnumsByClass[className]) || {};
    messages[clazz.MSG_NAME] = {
      id: clazz.MSG_ID,
      fields: clazz.FIELDS.map((field) => ({
        name: field.source,
        type: field.type,
        array: field.type.endsWith('[]') || field.length > 1,
        units: field.units || null,
        enum: fieldEnums[field.name] ? screaming(fieldEnums[field.name]) : null,
        extension: Boolean(field.extension)
      }))
    };
  }

  // Enum value tables: readable full name + numeric value. An enum such as
  // MavCmd is split across dialect modules (common defines the base commands,
  // ardupilotmega adds its own), so merge members across every module rather
  // than trusting enumsByName (which keeps only the last module's copy).
  const membersByPrefix = {};
  for (const mod of bundle.modules) {
    for (const [exportName, val] of Object.entries(mod)) {
      if (!enumNames.has(exportName)) {
        continue;
      }
      const prefix = screaming(exportName);
      const seen = membersByPrefix[prefix] || (membersByPrefix[prefix] = new Map());
      for (const [k, v] of Object.entries(val)) {
        if (/^\d+$/.test(k) || typeof v !== 'number') {
          continue; // skip reverse numeric keys
        }
        if (!seen.has(k)) {
          seen.set(k, v);
        }
      }
    }
  }
  const enums = {};
  for (const [prefix, seen] of Object.entries(membersByPrefix)) {
    enums[prefix] = [...seen.entries()]
      .map(([k, v]) => ({ name: `${prefix}_${k}`, value: v }))
      .sort((a, b) => a.value - b.value);
  }

  const result = { dialect: bundle.name, valid: true, error: null, messages, enums };
  cache.set(key, result);
  return result;
}

/**
 * Re-derive the include-chain module names for a dialect (mirrors the loader's
 * DIALECT_CHAINS) so we can locate each member's `.d.ts`.
 *
 * @param {string} dialectName
 * @param {object} opts
 * @returns {string[]}
 */
function dialectChainNames(dialectName, opts) {
  // eslint-disable-next-line global-require
  const { DIALECT_CHAINS, resolveDialectName } = require('./dialect-loader');
  let resolved;
  try {
    resolved = resolveDialectName(dialectName, opts.customDialectPath);
  } catch (e) {
    return [];
  }
  return DIALECT_CHAINS[resolved] || [];
}

module.exports = { buildMetadata };
