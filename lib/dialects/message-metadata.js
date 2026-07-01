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
 * Parse a dialect `.d.ts` for its generated command classes (e.g.
 * `NavWaypointCommand extends CommandLong`), recovering the ordered, named
 * `param1..param7` accessors plus their descriptions/units from the JSDoc. This
 * is what lets the command editor show real param labels (hold, acceptRadius,
 * latitude, …) instead of generic param1..7.
 *
 * The `.d.ts` gives the accessor names + descriptions/units but not which
 * `param1..7` each maps to (some commands skip params — e.g. NAV_TAKEOFF's yaw
 * is param4), so the caller resolves the real index by probing the runtime
 * command class.
 *
 * @param {string} dialectName
 * @returns {Object<string, Object<string, {description:?string, units:?string}>>}
 *   keyed by command class name, then accessor name
 */
function parseCommandParams(dialectName) {
  const file = path.join(mappingsLibDir(), `${dialectName}.d.ts`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {};
  }

  const result = {};
  const classRe = /export declare class (\w+Command) extends \w+ \{([\s\S]*?)\n\}/g;
  let m;
  while ((m = classRe.exec(text)) !== null) {
    const className = m[1];
    const body = m[2];
    // Optional JSDoc block immediately preceding each `get <name>(): number;`.
    const getterRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?get (\w+)\(\)\s*:\s*number;/g;
    const accessors = {};
    let g;
    while ((g = getterRe.exec(body)) !== null) {
      const doc = g[1] || '';
      accessors[g[2]] = {
        description: firstDocLine(doc),
        units: (doc.match(/@units\s+(\S+)/) || [])[1] || null
      };
    }
    if (Object.keys(accessors).length) {
      result[className] = accessors;
    }
  }
  return result;
}

/**
 * Resolve which `param1..param7` a named command accessor maps to, by setting
 * it to a marker on a fresh instance and seeing which `_paramN` changed.
 *
 * @param {Function} CmdClass  a generated command class (e.g. NavWaypointCommand)
 * @param {string} accessor    e.g. "yaw"
 * @returns {?number} 1..7, or null if the accessor isn't param-backed
 */
function resolveParamIndex(CmdClass, accessor) {
  let inst;
  try {
    inst = new CmdClass();
  } catch (e) {
    return null;
  }
  const marker = -987654321;
  try {
    inst[accessor] = marker;
  } catch (e) {
    return null;
  }
  for (let i = 1; i <= 7; i += 1) {
    if (inst[`_param${i}`] === marker) {
      return i;
    }
  }
  return null;
}

/**
 * Extract the first human-readable sentence from a JSDoc comment body,
 * skipping ` * ` prefixes and @tag lines.
 *
 * @param {string} doc
 * @returns {?string}
 */
function firstDocLine(doc) {
  const lines = doc
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@'));
  return lines.length ? lines[0] : null;
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
 *   messages: object, enums: object, commands: object}}
 */
function buildMetadata(dialectName, opts = {}) {
  const key = `${dialectName}:${opts.customDialectPath || ''}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  const bundle = loadDialect(dialectName, opts);
  if (!bundle.valid) {
    const invalid = { dialect: dialectName, valid: false, error: bundle.error, messages: {}, enums: {}, commands: {} };
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

  // Command param metadata: MAV_CMD_* -> ordered named params (labels/units).
  // Recovered from the generated command classes (COMMANDS registry maps a
  // MavCmd value to a class such as NavWaypointCommand, whose .d.ts declares the
  // named param accessors in param1..param7 order).
  const commandParamsByClass = {};
  for (const name of dialectChainNames(dialectName, opts)) {
    Object.assign(commandParamsByClass, parseCommandParams(name));
  }
  const mavCmdNameByValue = {};
  for (const entry of enums.MAV_CMD || []) {
    mavCmdNameByValue[entry.value] = entry.name;
  }
  const commands = {};
  for (const mod of bundle.modules) {
    if (!mod.COMMANDS) {
      continue;
    }
    for (const [value, cmdClass] of Object.entries(mod.COMMANDS)) {
      const cmdName = mavCmdNameByValue[Number(value)];
      const accessors = cmdClass && cmdClass.name ? commandParamsByClass[cmdClass.name] : null;
      if (!cmdName || !accessors || commands[cmdName]) {
        continue;
      }
      // Resolve the real param index for each named accessor (some commands
      // skip params), then order by index.
      const params = [];
      for (const [name, doc] of Object.entries(accessors)) {
        const index = resolveParamIndex(cmdClass, name);
        if (index) {
          params.push({ index, name, description: doc.description, units: doc.units });
        }
      }
      params.sort((a, b) => a.index - b.index);
      if (params.length) {
        commands[cmdName] = { params };
      }
    }
  }

  const result = { dialect: bundle.name, valid: true, error: null, messages, enums, commands };
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
