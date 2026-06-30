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
    let value;
    if (Object.prototype.hasOwnProperty.call(input, field.source)) {
      value = input[field.source];
    } else if (Object.prototype.hasOwnProperty.call(input, field.name)) {
      value = input[field.name];
    } else {
      continue;
    }
    out[field.source] = resolveFieldValue(bundle, value);
  }
  return out;
}

function resolveFieldValue(bundle, value) {
  if (Array.isArray(value)) {
    return value.map((v) => enumResolver.resolveEnumValue(bundle.enums, v));
  }
  return enumResolver.resolveEnumValue(bundle.enums, value);
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
    let value;
    if (Object.prototype.hasOwnProperty.call(input, field.source)) {
      value = input[field.source];
    } else if (Object.prototype.hasOwnProperty.call(input, field.name)) {
      value = input[field.name];
    } else {
      continue;
    }
    instance[field.name] = resolveFieldValue(bundle, value);
  }
  return { instance, clazz };
}

module.exports = {
  decodePacket,
  decodedMessage,
  normalizeFields,
  buildData
};
