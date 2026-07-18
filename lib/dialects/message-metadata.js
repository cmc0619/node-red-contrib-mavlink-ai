'use strict';

const fs = require('fs');
const path = require('path');
const { loadDialect } = require('./dialect-loader');
const { paramControl, looksBoolean } = require('../command/param-metadata');
const { isBitmaskEnum } = require('../util/bitmask');

/**
 * Editor metadata for a dialect: the message list, each message's fields
 * (name/type/units/enum/description), and the enum value tables. This powers
 * the dynamic field editor in mavlink-ai-build (the aigen-style "pick a
 * message, get its fields with readable enum dropdowns" UX).
 *
 * The per-field enum association is the tricky part: the runtime `FIELDS`
 * metadata only records the primitive wire type (uint8_t), not which enum a
 * field uses. That association only lives in the MAVLink XML — but the
 * generated `mavlink-mappings` TypeScript declarations annotate each field with
 * its enum class (e.g. `command: MavCmd`). So we parse the bundled `.d.ts`
 * files to recover field -> enum, fully offline (no XML fetch required).
 *
 * The same `.d.ts` files carry the MAVLink XML descriptions as JSDoc — on the
 * message classes, on each field, on each enum member, and on the generated
 * command classes. Those descriptions feed the visible editor help (issue #45),
 * so the parse below recovers them in the same pass as the enum associations.
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

// Parsed `.d.ts` structures per bundled dialect module (common, minimal, …).
// Independent of any bundle's enum set, so it caches per module file.
const dtsCache = new Map();

/**
 * Parse one dialect `.d.ts` file in a single pass, recovering everything the
 * editor metadata needs that the runtime `FIELDS` metadata lacks:
 *
 * - message classes: class-level JSDoc description plus, per field, the
 *   declared type name (an enum class for enum-backed fields) and description
 * - enums: per-member JSDoc descriptions
 * - generated command classes (e.g. `NavWaypointCommand extends CommandLong`):
 *   the class-level command description and the ordered, named `param1..param7`
 *   accessors with their descriptions/units. The `.d.ts` doesn't say which
 *   `param1..7` each accessor maps to (some commands skip params — e.g.
 *   NAV_TAKEOFF's yaw is param4), so the caller resolves the real index by
 *   probing the runtime command class.
 *
 * @param {string} dialectName  bundled dialect module name (e.g. "common")
 * @returns {{
 *   classes: Object<string, {description:?string, fields:Object<string,{type:string,description:?string}>}>,
 *   enums: Object<string, {description:?string, members:Object<string,?string>}>,
 *   commands: Object<string, {description:?string, accessors:Object<string,{description:?string,units:?string}>}>
 * }}
 */
function parseDialectDts(dialectName) {
  if (dtsCache.has(dialectName)) {
    return dtsCache.get(dialectName);
  }
  const empty = { classes: {}, enums: {}, commands: {} };
  const file = path.join(mappingsLibDir(), `${dialectName}.d.ts`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // The .d.ts is how we recover per-field enum associations and descriptions.
    // If the mavlink-mappings package layout ever changes, warn loudly rather
    // than silently dropping enum dropdowns.
    console.warn(
      `[mavlink-ai] could not read type declarations for dialect '${dialectName}' (${file}): ` +
        `${e.message}. Enum dropdowns and field help for this dialect will be unavailable.`
    );
    dtsCache.set(dialectName, empty);
    return empty;
  }

  const result = { classes: {}, enums: {}, commands: {} };

  // Class declarations with their optional preceding JSDoc block.
  const classRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?export declare class (\w+) extends (\w+) \{([\s\S]*?)\n\}/g;
  let m;
  while ((m = classRe.exec(text)) !== null) {
    const doc = m[1] || '';
    const className = m[2];
    const base = m[3];
    const body = m[4];

    if (base === 'MavLinkData') {
      const fieldRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?(\w+):\s*(\w+);/g;
      let f;
      const fields = {};
      while ((f = fieldRe.exec(body)) !== null) {
        fields[f[2]] = { type: f[3], description: docText(f[1] || '') };
      }
      result.classes[className] = { description: docText(doc), fields };
    } else {
      // Generated command convenience classes (NavWaypointCommand, …): the
      // optional JSDoc block immediately precedes each `get <name>(): number;`.
      const getterRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?get (\w+)\(\)\s*:\s*number;/g;
      const accessors = {};
      let g;
      while ((g = getterRe.exec(body)) !== null) {
        const gdoc = g[1] || '';
        accessors[g[2]] = {
          description: docText(gdoc),
          units: (gdoc.match(/@units\s+(\S+)/) || [])[1] || null,
          // Generic numeric constraints ride the accessor JSDoc as `@min: -180`,
          // `@max: 180`, `@increment: 1` — recovered here so the editor can
          // render a constrained numeric input (issue #97).
          min: numericTag(gdoc, 'min'),
          max: numericTag(gdoc, 'max'),
          increment: numericTag(gdoc, 'increment')
        };
      }
      if (Object.keys(accessors).length) {
        result.commands[className] = { description: docText(doc), accessors };
      }
    }
  }

  // Enum declarations: per-member JSDoc descriptions keyed by member name
  // (the runtime module exports carry the values; descriptions merge by name).
  const enumRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?export declare enum (\w+) \{([\s\S]*?)\n\}/g;
  while ((m = enumRe.exec(text)) !== null) {
    const enumDoc = m[1] || '';
    const enumName = m[2];
    const body = m[3];
    const memberRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?'?([A-Z0-9_]+)'? = \d+,?/g;
    const members = {};
    let e;
    while ((e = memberRe.exec(body)) !== null) {
      members[e[2]] = docText(e[1] || '');
    }
    result.enums[enumName] = { description: docText(enumDoc), members };
  }

  dtsCache.set(dialectName, result);
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
  } catch {
    return null;
  }
  const marker = -987654321;
  try {
    inst[accessor] = marker;
  } catch {
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
 * Extract the human-readable description from a JSDoc comment body: strip
 * ` * ` prefixes, stop at the first @tag, and re-join the generator's hard
 * line-wrapping into flowing text (blank lines become paragraph breaks).
 *
 * @param {string} doc
 * @returns {?string}
 */
function docText(doc) {
  const lines = [];
  for (const raw of doc.split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trimEnd();
    if (line.trim().startsWith('@')) {
      break; // description ends at the first JSDoc tag
    }
    if (/^Units:\s/.test(line.trim())) {
      continue; // units already ride in dedicated metadata; don't repeat them
    }
    lines.push(line);
  }
  const textOut = lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p)
    .join('\n');
  return textOut || null;
}

/**
 * Parse a numeric JSDoc constraint tag (`@min: -180`, `@max: 180`,
 * `@increment: 1`) from an accessor's doc block. The generator emits the tag
 * name with a trailing colon; the value may be negative or fractional.
 *
 * @param {string} doc  JSDoc block text
 * @param {string} tag  'min' | 'max' | 'increment'
 * @returns {?number} the parsed value, or null when the tag is absent/unparsable
 */
function numericTag(doc, tag) {
  const m = doc.match(new RegExp(`@${tag}:?\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (!m) {
    return null;
  }
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
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
 * Attach the best-available control metadata to a raw command parameter
 * (issue #97): a registered enum/bitmask/boolean/resolver hint, or a heuristic
 * boolean derived from the MAV_BOOL description convention. Params with no
 * reliable metadata are returned unchanged (the editor keeps a numeric input;
 * min/max/increment already ride the param when present).
 *
 * @param {string} commandName  MAV_CMD_* name
 * @param {object} param        { index, name, description, units, min, max, increment }
 * @returns {object} the same param, with control attributes merged in
 */
function annotateParamControl(commandName, param) {
  const spec = paramControl(commandName, param.index);
  if (spec) {
    if (spec.enum) {
      param.enum = spec.enum;
    }
    if (spec.bitmask) {
      param.bitmask = spec.bitmask;
    }
    if (spec.boolean) {
      param.boolean = true;
    }
    if (spec.control) {
      param.control = spec.control;
    }
    if (spec.resolver) {
      param.resolver = spec.resolver;
    }
    if (spec.profileAware) {
      param.profileAware = true;
    }
    if (spec.componentAware) {
      param.componentAware = true;
    }
  }
  // Generic boolean fallback when no explicit hint claimed the param.
  if (!param.enum && !param.bitmask && !param.boolean && !param.resolver && looksBoolean(param)) {
    param.boolean = true;
  }
  return param;
}

/**
 * Build the editor metadata for a dialect.
 *
 * @param {string} dialectName  e.g. "ardupilotmega"
 * @param {object} [opts]  passed to loadDialect (e.g. customDialectPath)
 * @returns {{dialect: string, valid: boolean, error: ?object,
 *   messages: object, enums: object, commands: object}}
 */
/**
 * Cap on cached metadata entries. Bundled dialects are a small fixed set, but
 * custom-path keys are caller-controlled (one per distinct path×mtime), so an
 * unbounded map would grow with every probe/edit. FIFO eviction — metadata is
 * cheap to rebuild.
 */
const MAX_METADATA_CACHE = 32;

function buildMetadata(dialectName, opts = {}) {
  /**
   * Custom XML is recompiled by the runtime on every deploy, but this cache
   * used to serve the FIRST compile forever — after editing the XML file the
   * editor showed stale fields/enums until a Node-RED restart while the
   * runtime already spoke the new dialect. Keying on the file's mtime makes an
   * edit a cache miss; a stat failure keys on 'stat-failed' so the (invalid)
   * result is still cached rather than rebuilt per keystroke.
   */
  let custom = opts.customDialectPath || '';
  if (custom) {
    let stamp = 'stat-failed';
    try {
      stamp = String(fs.statSync(custom).mtimeMs);
    } catch {
      /** unreadable path: loadDialect below reports the real error */
    }
    custom = `${custom}@${stamp}`;
  }
  const key = `${dialectName}:${custom}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  if (cache.size >= MAX_METADATA_CACHE) {
    cache.delete(cache.keys().next().value);
  }

  const bundle = loadDialect(dialectName, opts);
  if (!bundle.valid) {
    const invalid = { dialect: dialectName, valid: false, error: bundle.error, messages: {}, enums: {}, commands: {} };
    cache.set(key, invalid);
    return invalid;
  }

  const enumNames = new Set(Object.keys(bundle.enums.enumsByName));

  // Merge the parsed `.d.ts` structures (field enums/descriptions, enum member
  // descriptions, command docs) across the dialect's include chain
  // (re-derived by name, since the bundle doesn't expose chain members).
  const classDocs = {};
  const enumDocs = {};
  const commandDocs = {};
  for (const name of dialectChainNames(dialectName, opts)) {
    const parsed = parseDialectDts(name);
    Object.assign(classDocs, parsed.classes);
    Object.assign(commandDocs, parsed.commands);
    // An enum such as MavCmd is re-declared by each module that extends it
    // (common defines the base commands, ardupilotmega adds its own), so merge
    // member docs per enum instead of letting the last module's subset win.
    for (const [enumName, doc] of Object.entries(parsed.enums)) {
      const target = enumDocs[enumName] || (enumDocs[enumName] = { description: doc.description, members: {} });
      for (const [member, text] of Object.entries(doc.members)) {
        if (!(member in target.members)) {
          target.members[member] = text;
        }
      }
    }
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

  // Enum value tables: readable full name + numeric value. An enum such as
  // MavCmd is split across dialect modules (common defines the base commands,
  // ardupilotmega adds its own), so merge members across every module rather
  // than trusting enumsByName (which keeps only the last module's copy).
  // Built before the message tables so field entries can consult the merged
  // member values for the bitmask flag below.
  const membersByPrefix = {};
  for (const mod of bundle.modules) {
    for (const [exportName, val] of Object.entries(mod)) {
      if (!enumNames.has(exportName)) {
        continue;
      }
      const memberDocs = (enumDocs[exportName] && enumDocs[exportName].members) || {};
      const prefix = screaming(exportName);
      const seen = membersByPrefix[prefix] || (membersByPrefix[prefix] = new Map());
      for (const [k, v] of Object.entries(val)) {
        if (/^\d+$/.test(k) || typeof v !== 'number') {
          continue; // skip reverse numeric keys
        }
        if (!seen.has(k)) {
          seen.set(k, { value: v, description: memberDocs[k] || null });
        }
      }
    }
  }
  const enums = {};
  for (const [prefix, seen] of Object.entries(membersByPrefix)) {
    enums[prefix] = [...seen.entries()]
      .map(([k, m]) => ({ name: `${prefix}_${k}`, value: m.value, description: m.description }))
      .sort((a, b) => a.value - b.value);
  }

  /**
   * Enums whose member values form an additive bitmask (ATTITUDE_TARGET's
   * type_mask, MAV_MODE_FLAG, ...). MAVLink XML marks these with
   * `display="bitmask"`, but the generated modules drop the attribute, so it
   * is re-derived from value shape (see isBitmaskEnum). Editors use the
   * per-field flag to render an additive flag checklist instead of a
   * single-select, which can only express one flag of a combination.
   */
  const bitmaskPrefixes = new Set(
    Object.entries(enums)
      .filter(([, members]) => isBitmaskEnum(members.map((m) => m.value)))
      .map(([prefix]) => prefix)
  );

  const messages = {};
  for (const clazz of Object.values(bundle.registry)) {
    const className = nameByClassRef.get(clazz);
    const classDoc = (className && classDocs[className]) || { description: null, fields: {} };
    messages[clazz.MSG_NAME] = {
      id: clazz.MSG_ID,
      description: classDoc.description,
      fields: clazz.FIELDS.map((field) => {
        const fieldDoc = classDoc.fields[field.name] || {};
        const isEnum = fieldDoc.type && enumNames.has(fieldDoc.type);
        const enumPrefix = isEnum ? screaming(fieldDoc.type) : null;
        return {
          name: field.source,
          type: field.type,
          array: field.type.endsWith('[]') || field.length > 1,
          units: field.units || null,
          enum: enumPrefix,
          bitmask: enumPrefix !== null && bitmaskPrefixes.has(enumPrefix),
          description: fieldDoc.description || null,
          extension: Boolean(field.extension)
        };
      })
    };
  }

  // Command param metadata: MAV_CMD_* -> ordered named params (labels/units)
  // plus the command-level description. Recovered from the generated command
  // classes (COMMANDS registry maps a MavCmd value to a class such as
  // NavWaypointCommand, whose .d.ts declares the named param accessors in
  // param1..param7 order).
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
      const cmdDoc = cmdClass && cmdClass.name ? commandDocs[cmdClass.name] : null;
      if (!cmdName || !cmdDoc || commands[cmdName]) {
        continue;
      }
      // Resolve the real param index for each named accessor (some commands
      // skip params), then order by index.
      const params = [];
      for (const [name, doc] of Object.entries(cmdDoc.accessors)) {
        const index = resolveParamIndex(cmdClass, name);
        if (index) {
          params.push(
            annotateParamControl(cmdName, {
              index,
              name,
              description: doc.description,
              units: doc.units,
              min: doc.min,
              max: doc.max,
              increment: doc.increment
            })
          );
        }
      }
      params.sort((a, b) => a.index - b.index);
      if (params.length) {
        commands[cmdName] = { description: cmdDoc.description, params };
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
  const { DIALECT_CHAINS, resolveDialectName } = require('./dialect-loader');
  let resolved;
  try {
    resolved = resolveDialectName(dialectName, opts.customDialectPath);
  } catch {
    return [];
  }
  return DIALECT_CHAINS[resolved] || [];
}

module.exports = { buildMetadata };
