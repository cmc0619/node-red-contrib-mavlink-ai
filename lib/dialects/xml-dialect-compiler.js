'use strict';

const path = require('path');
const xml2js = require('xml2js');
const { MavLinkData, MavLinkPacketField } = require('node-mavlink');
const { MavlinkError } = require('../util/errors');
const { resolveXmlIncludeGraph } = require('./xml-include-resolver');

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
    const genDir = path.dirname(require.resolve('mavlink-mappings-gen'));
    // eslint-disable-next-line global-require, import/no-dynamic-require
    ({ XmlDataSource } = require(path.join(genDir, 'generator', 'datasource.js')));
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
  // XmlDataSource.read assumes both sections exist; a dialect may define only
  // messages or only enums, so normalize the shape it walks.
  if (!Array.isArray(mav.enums)) {
    mav.enums = [{ enum: [] }];
  }
  if (!mav.enums[0] || !Array.isArray(mav.enums[0].enum)) {
    mav.enums[0] = { enum: [] };
  }
  if (!Array.isArray(mav.messages)) {
    mav.messages = [{ message: [] }];
  }
  if (!mav.messages[0] || !Array.isArray(mav.messages[0].message)) {
    mav.messages[0] = { message: [] };
  }
  return mav;
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
 * Turn one XmlDataSource message def into a live node-mavlink data class.
 *
 * @param {object} def
 * @returns {Function} a MavLinkData subclass
 */
function buildMessageClass(def) {
  const fields = buildFields(def.fields);
  const cls = class extends MavLinkData {};
  // Give the class a readable name for debugging / metadata keyed by class ref.
  Object.defineProperty(cls, 'name', { value: def.name, configurable: true });
  cls.MSG_ID = Number(def.id);
  cls.MSG_NAME = def.source.name;
  cls.PAYLOAD_LENGTH = def.payloadLength;
  cls.MAGIC_NUMBER = def.magic;
  cls.FIELDS = fields;
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
