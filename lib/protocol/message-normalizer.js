'use strict';

const { MavlinkError } = require('../util/errors');
const { getMessageClass } = require('../dialects/dialect-loader');
const enumResolver = require('./enum-resolver');

/**
 * Translation between raw `node-mavlink` packets/data classes and the stable
 * message contracts defined in DESIGN.md §14.
 *
 * Field naming: the generated data classes expose camelCase JS properties
 * (e.g. `baseMode`) while MAVLink/DESIGN.md use snake_case (`base_mode`). The
 * `FIELDS` metadata carries both (`source` = snake_case, `name` = camelCase),
 * so we always normalize on the snake_case `source` name in message contracts.
 */

/**
 * Decode a raw MavLinkPacket into the §14.1 decoded payload object.
 *
 * @param {DialectBundle} bundle
 * @param {MavLinkPacket} packet
 * @param {object} [meta]
 * @param {string} [meta.profile]    resolved profile name for this packet
 * @param {string} [meta.profile_id] resolved profile config-node id (canonical)
 * @param {object} [meta.transport]  transport descriptor (name/type/remote...)
 * @returns {object|null} decoded payload, or null if the msgid is unknown
 */
function decodePacket(bundle, packet, meta = {}) {
  const header = packet.header;
  const clazz = bundle && bundle.valid ? bundle.registry[header.msgid] : undefined;

  const base = {
    name: clazz ? clazz.MSG_NAME : `UNKNOWN_${header.msgid}`,
    id: header.msgid,
    sysid: header.sysid,
    compid: header.compid,
    profile: meta.profile,
    profile_id: meta.profile_id,
    fields: {},
    raw: {
      magic: header.magic,
      seq: header.seq,
      incompat_flags: header.incompatibilityFlags,
      compat_flags: header.compatibilityFlags
    },
    transport: meta.transport,
    receivedAt: Date.now()
  };

  if (!clazz) {
    return base; // Unknown message: still routable/observable, just no fields.
  }

  const data = packet.protocol.data(packet.payload, clazz);
  for (const field of clazz.FIELDS) {
    base.fields[field.source] = data[field.name];
  }
  return base;
}

/**
 * Wrap a decoded payload in the standard message envelope (§14.1).
 */
function decodedMessage(bundle, packet, meta) {
  const payload = decodePacket(bundle, packet, meta);
  if (!payload) {
    return null;
  }
  return { topic: `mavlink/${payload.name}`, payload };
}

/**
 * Normalize an arbitrary fields object (snake_case or camelCase keys) against a
 * message class, returning a snake_case object containing only known fields,
 * with enum-name strings resolved to numbers.
 */
function normalizeFields(bundle, clazz, fields) {
  const out = {};
  const input = fields && typeof fields === 'object' ? fields : {};
  for (const field of clazz.FIELDS) {
    const lookup = readInputField(input, field);
    if (!lookup.found) {
      continue;
    }
    out[field.source] = resolveFieldValue(bundle, lookup.value, field);
  }
  return out;
}

/**
 * Look up a field's value from an input object, accepting either the snake_case
 * `source` name or the camelCase `name`. Shared by normalizeFields/buildData so
 * the lookup rules stay identical.
 *
 * @param {object} input
 * @param {MavLinkPacketField} field
 * @returns {{found: boolean, value?: *}}
 */
function readInputField(input, field) {
  if (Object.prototype.hasOwnProperty.call(input, field.source)) {
    return { found: true, value: input[field.source] };
  }
  if (Object.prototype.hasOwnProperty.call(input, field.name)) {
    return { found: true, value: input[field.name] };
  }
  return { found: false };
}

/**
 * Resolve a field value (or array of values), turning enum-name strings into
 * their numeric values via the dialect's enum index.
 *
 * @param {DialectBundle} bundle
 * @param {*} value
 * @param {MavLinkPacketField} [field]  target field, for 64-bit coercion
 * @returns {*}
 */
function resolveFieldValue(bundle, value, field) {
  if (Array.isArray(value)) {
    return value.map((v) => resolveSingleValue(bundle, v, field));
  }
  return resolveSingleValue(bundle, value, field);
}

/**
 * Resolve one scalar field value. 64-bit coercion runs on the *raw* value
 * first: a numeric string must become BigInt directly, because the enum
 * resolver's numeric-string path goes through Number() and silently loses
 * precision above 2^53 (uint64 max would round up to 2^64 and crash
 * serialization out of range).
 *
 * A string that survives enum resolution on a numeric wire type is a typo
 * (e.g. MAV_CMD_ARM_DISRAM): fail here with the field named rather than let
 * it die later inside buffer serialization with an opaque range error.
 *
 * @param {DialectBundle} bundle
 * @param {*} value
 * @param {MavLinkPacketField} [field]
 * @returns {*}
 * @throws {MavlinkError} UNRESOLVED_FIELD_VALUE for unresolvable strings on
 *   numeric fields
 */
function resolveSingleValue(bundle, value, field) {
  const pre = coerce64(value, field);
  if (typeof pre === 'bigint') {
    return pre;
  }
  const resolved = coerce64(enumResolver.resolveEnumValue(bundle.enums, value), field);
  if (typeof resolved === 'string' && field && isNumericFieldType(field.type)) {
    throw new MavlinkError(
      'UNRESOLVED_FIELD_VALUE',
      `Field '${field.source}' (${field.type}) got '${resolved}', which is neither a number nor a known enum name.`,
      { field: field.source, type: field.type, value: resolved }
    );
  }
  return resolved;
}

/**
 * True for wire types that carry numbers (char/char[] fields keep strings).
 *
 * @param {string} type  e.g. 'uint16_t', 'float', 'char[16]'
 * @returns {boolean}
 */
function isNumericFieldType(type) {
  return /^(u?int\d+_t|float|double)/.test(String(type));
}

/**
 * Coerce a Number or numeric string to BigInt for 64-bit integer fields.
 * node-mavlink stores uint64_t/int64_t as BigInt; flow payloads come from JSON,
 * which has no BigInt, so a plain number would otherwise throw "Cannot mix
 * BigInt and other types" deep in serialization. Strings convert losslessly
 * via BigInt(); `double` stays a JS number.
 *
 * @param {*} value
 * @param {MavLinkPacketField} [field]
 * @returns {*}
 */
function coerce64(value, field) {
  if (!field || !/^u?int64_t/.test(field.type)) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return value;
}

/**
 * Build a concrete MavLinkData instance from a message name and fields object,
 * ready to be serialized. Resolves enum-name strings to numbers and maps
 * snake_case field names onto the camelCase class properties.
 *
 * @throws {MavlinkError} UNKNOWN_MESSAGE if the name is not in the dialect.
 */
function buildData(bundle, name, fields) {
  const clazz = getMessageClass(bundle, name);
  if (!clazz) {
    throw new MavlinkError('UNKNOWN_MESSAGE', `Message '${name}' is not defined in dialect '${bundle.name}'.`, {
      message: name,
      dialect: bundle.name
    });
  }

  const instance = new clazz();
  const input = fields && typeof fields === 'object' ? fields : {};
  for (const field of clazz.FIELDS) {
    const lookup = readInputField(input, field);
    if (!lookup.found) {
      continue;
    }
    instance[field.name] = resolveFieldValue(bundle, lookup.value, field);
  }
  return { instance, clazz };
}

module.exports = {
  decodePacket,
  decodedMessage,
  normalizeFields,
  buildData
};
