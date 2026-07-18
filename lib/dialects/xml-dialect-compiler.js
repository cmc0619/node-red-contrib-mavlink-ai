'use strict';

const path = require('path');
const xml2js = require('xml2js');
const { MavLinkData, MavLinkPacketField } = require('node-mavlink');
const { MavlinkError } = require('../util/errors');
const { resolveXmlIncludeGraph } = require('./xml-include-resolver');
const { screamingToCamel } = require('./field-enums');

/**
 * Runtime compilation of a user-provided MAVLink XML dialect (issue #2).
 *
 * MAVLink dialects are normally consumed from the pre-generated
 * `mavlink-mappings` package. This module compiles an *arbitrary* local (or
 * Docker-mounted) XML dialect at runtime into the same in-memory shape a bundled
 * dialect module exposes (a REGISTRY of message classes, enum objects, and a
 * magic-number table), so the rest of the stack — codec, normalizer, routing —
 * treats a custom dialect identically to a bundled one.
 *
 * How it stays correct without re-implementing MAVLink's quirks: the heavy
 * lifting (field sizing, payload length, CRC_EXTRA / magic number, enum prefix
 * stripping, extension-field handling) is reused from `mavlink-mappings-gen`'s
 * `XmlDataSource`, the exact same code that generates `mavlink-mappings`. We
 * only turn its structured message/enum defs into live `node-mavlink` classes.
 *
 * xml2js parses synchronously (its callback fires before returning for string
 * input), so compilation is synchronous and `loadDialect` stays synchronous —
 * no async ripple into the profile/connection handshake.
 */

// mavlink-mappings-gen does not re-export XmlDataSource from its package index;
// it lives in the compiled generator directory. Resolve it from the package
// entry so this keeps working regardless of the install location.
let XmlDataSource;
/**
 * Lazily resolve the generator's XmlDataSource class.
 *
 * @returns {Function}
 */
function getXmlDataSource() {
  if (!XmlDataSource) {
    try {
      // require.resolve('mavlink-mappings-gen') -> .../dist/index.js, so the
      // generator sources sit alongside it under ./generator. XmlDataSource is
      // not re-exported from the package index, hence the direct module load.
      const genDir = path.dirname(require.resolve('mavlink-mappings-gen'));
      ({ XmlDataSource } = require(path.join(genDir, 'generator', 'datasource.js')));
    } catch (err) {
      throw new MavlinkError(
        'DIALECT_COMPILER_UNAVAILABLE',
        `Custom dialect compilation requires the mavlink-mappings-gen XML parser, which could not be ` +
          `loaded: ${err.message}.`,
        { module: 'mavlink-mappings-gen' }
      );
    }
    if (typeof XmlDataSource !== 'function') {
      throw new MavlinkError(
        'DIALECT_COMPILER_UNAVAILABLE',
        'mavlink-mappings-gen did not expose the expected XmlDataSource parser.',
        { module: 'mavlink-mappings-gen' }
      );
    }
  }
  return XmlDataSource;
}

/**
 * Parse dialect XML synchronously into an xml2js document, raising a structured
 * error on malformed XML or a missing `<mavlink>` root.
 *
 * @param {string} text
 * @param {string} sourcePath  for error context
 * @returns {object} the xml2js `<mavlink>` node (normalized to always carry
 *   `enums[0].enum` and `messages[0].message` arrays)
 */
function parseMavlinkXml(text, sourcePath) {
  let result;
  let error;
  new xml2js.Parser({ explicitChildren: true, preserveChildrenOrder: true }).parseString(text, (e, r) => {
    error = e;
    result = r;
  });
  if (error) {
    throw new MavlinkError('DIALECT_XML_INVALID', `Invalid dialect XML '${sourcePath}': ${error.message}`, {
      path: sourcePath
    });
  }
  if (!result || !result.mavlink) {
    throw new MavlinkError('DIALECT_XML_INVALID', `Dialect XML '${sourcePath}' has no <mavlink> root element.`, {
      path: sourcePath
    });
  }
  const mav = result.mavlink;
  // XmlDataSource.read walks only enums[0]/messages[0] and assumes both exist.
  // Normalize: a dialect may define only messages or only enums, and a file
  // with several <enums>/<messages> sections must have them merged rather than
  // silently dropping everything after the first section.
  mav.enums = [{ enum: collectSectionItems(mav.enums, 'enum') }];
  mav.messages = [{ message: collectSectionItems(mav.messages, 'message') }];
  return mav;
}

/**
 * Flatten every `<enums>`/`<messages>` section's items into one array.
 *
 * @param {Array|undefined} sections  xml2js section array (e.g. mav.enums)
 * @param {string} itemKey  'enum' or 'message'
 * @returns {Array}
 */
function collectSectionItems(sections, itemKey) {
  const out = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section && Array.isArray(section[itemKey])) {
      out.push(...section[itemKey]);
    }
  }
  return out;
}

/**
 * Build the ordered `FIELDS` metadata for a message, mirroring the generator's
 * wire layout: non-extension fields sorted largest-first (stable for equal
 * sizes, preserving XML order), then extension fields appended in XML order.
 *
 * @param {object[]} defFields  XmlDataSource field defs
 * @returns {MavLinkPacketField[]}
 */
function buildFields(defFields) {
  const base = defFields.filter((f) => !f.extension).sort((a, b) => b.fieldSize - a.fieldSize);
  const ext = defFields.filter((f) => f.extension);
  const fields = [];
  let offset = 0;
  for (const f of [...base, ...ext]) {
    fields.push(
      new MavLinkPacketField(
        f.source.name,
        f.name,
        offset,
        Boolean(f.extension),
        f.fieldSize,
        f.fieldType,
        f.units || '',
        f.arrayLength || 0
      )
    );
    offset += f.size;
  }
  return fields;
}

/**
 * Compute the constructor-init descriptor for one field, mirroring the
 * generated classes: strings init to '', 64-bit integers to BigInt(0),
 * arrays to a fresh [], everything else to 0. Without this, serializing a
 * message with an omitted string/array field crashes, and 64-bit fields
 * poison the arithmetic with undefined instead of a BigInt.
 *
 * @param {object} f  XmlDataSource field def
 * @returns {'string'|'bigint'|'array'|'zero'}
 */
function initKindFor(f) {
  const isString = f.type === 'string' || String(f.type).startsWith('char');
  if (isString) {
    return 'string';
  }
  if (f.arrayLength) {
    return 'array';
  }
  // Wire types: uint64_t/int64_t are BigInt in node-mavlink; double is a JS number.
  if (/^u?int64_t/.test(f.fieldType)) {
    return 'bigint';
  }
  return 'zero';
}

/**
 * Turn one XmlDataSource message def into a live node-mavlink data class.
 *
 * @param {object} def
 * @returns {Function} a MavLinkData subclass
 */
function buildMessageClass(def) {
  const fields = buildFields(def.fields);
  const inits = def.fields.map((f) => ({ name: f.name, kind: initKindFor(f) }));
  const cls = class extends MavLinkData {
    constructor() {
      super();
      for (const { name, kind } of inits) {
        if (kind === 'string') {
          this[name] = '';
        } else if (kind === 'array') {
          this[name] = []; // fresh array per instance — never share a mutable default
        } else if (kind === 'bigint') {
          this[name] = BigInt(0);
        } else {
          this[name] = 0;
        }
      }
    }
  };
  // Give the class a readable name for debugging / metadata keyed by class ref.
  Object.defineProperty(cls, 'name', { value: def.name, configurable: true });
  cls.MSG_ID = Number(def.id);
  cls.MSG_NAME = def.source.name;
  cls.PAYLOAD_LENGTH = def.payloadLength;
  cls.MAGIC_NUMBER = def.magic;
  cls.FIELDS = fields;
  /**
   * Field→enum association for encode-time enum scoping (#153): the XML
   * declares which enum backs each field (`enum="CUSTOM_COLOR"`), converted
   * here to the compiled enum class name ('CustomColor') the module exports
   * enums under. Bundled dialects recover the same association from their
   * shipped declarations instead (lib/dialects/field-enums.js).
   */
  const fieldEnums = {};
  let hasEnums = false;
  for (const f of def.fields) {
    if (f.source && f.source.enum) {
      fieldEnums[f.name] = screamingToCamel(f.source.enum);
      hasEnums = true;
    }
  }
  if (hasEnums) {
    cls.FIELD_ENUMS = fieldEnums;
  }
  return cls;
}

/**
 * Turn one XmlDataSource enum def into a bidirectional enum object, matching the
 * shape the generated modules export (member -> number and number -> member,
 * members with the common prefix already stripped by XmlDataSource).
 *
 * @param {object} def
 * @returns {object}
 */
function buildEnumObject(def) {
  const obj = {};
  for (const value of def.values) {
    const num = Number(value.value);
    if (!Number.isFinite(num)) {
      continue; // skip non-numeric (e.g. bitmask expressions we can't evaluate)
    }
    obj[value.name] = num;
    if (obj[num] === undefined) {
      obj[num] = value.name; // reverse mapping (first member wins on duplicates)
    }
  }
  return obj;
}

/**
 * Compile a custom MAVLink XML dialect (and its `<include>` graph) into a
 * synthetic dialect module compatible with the bundled `mavlink-mappings`
 * modules.
 *
 * @param {string} rootPath  path to the root dialect `.xml`
 * @param {object} [opts]
 * @param {string[]} [opts.includeDirs]  extra directories to search for includes
 * @returns {{name: string, module: object, magicNumbers: Object<number, number>,
 *   files: string[]}}
 * @throws {MavlinkError} DIALECT_XML_NOT_FOUND | DIALECT_INCLUDE_NOT_FOUND |
 *   DIALECT_INCLUDE_CYCLE | DIALECT_XML_INVALID
 */
function compileXmlDialect(rootPath, opts = {}) {
  const graph = resolveXmlIncludeGraph(rootPath, { includeDirs: opts.includeDirs || [] });
  const DataSource = getXmlDataSource();

  const REGISTRY = {};
  const MSG_ID_MAGIC_NUMBER = {};
  const module = {};

  // orderedFiles is dependency-first, so bases (e.g. minimal, common) compile
  // before the dialects that extend them; later defs win on id/enum collisions.
  for (const file of graph.orderedFiles) {
    const mav = parseMavlinkXml(graph.documents[file].text, file);
    let defs;
    try {
      defs = new DataSource().read(mav);
    } catch (err) {
      throw new MavlinkError('DIALECT_XML_INVALID', `Could not compile dialect XML '${file}': ${err.message}`, {
        path: file
      });
    }
    for (const enumDef of defs.enumDefs) {
      const built = buildEnumObject(enumDef);
      module[enumDef.name] = module[enumDef.name] ? Object.assign(module[enumDef.name], built) : built;
    }
    for (const messageDef of defs.messageDefs) {
      const cls = buildMessageClass(messageDef);
      /**
       * A same-name redefinition is a deliberate override (a dialect refining
       * a base message) and keeps the later-wins rule above. A *different*
       * message reusing an occupied id is an authoring error pymavlink also
       * hard-fails on: silently shadowing (e.g. a custom message on id 0
       * replacing HEARTBEAT) poisons the shared CRC table and surfaces as
       * mysterious CRC drops for the legitimate message.
       */
      const existing = REGISTRY[cls.MSG_ID];
      if (existing && existing.MSG_NAME !== cls.MSG_NAME) {
        throw new MavlinkError(
          'DIALECT_XML_INVALID',
          `Duplicate message id ${cls.MSG_ID} in '${file}': '${cls.MSG_NAME}' conflicts with '${existing.MSG_NAME}'.`,
          { path: file, msgid: cls.MSG_ID, messages: [existing.MSG_NAME, cls.MSG_NAME] }
        );
      }
      REGISTRY[cls.MSG_ID] = cls;
      MSG_ID_MAGIC_NUMBER[cls.MSG_ID] = cls.MAGIC_NUMBER;
    }
  }

  module.REGISTRY = REGISTRY;
  module.MSG_ID_MAGIC_NUMBER = MSG_ID_MAGIC_NUMBER;

  const name = path.basename(graph.rootPath).replace(/\.xml$/i, '');
  return { name, module, magicNumbers: MSG_ID_MAGIC_NUMBER, files: graph.orderedFiles };
}

module.exports = { compileXmlDialect };
