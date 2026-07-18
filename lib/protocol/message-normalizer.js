'use strict';

const { MavlinkError } = require('../util/errors');
const { getMessageClass } = require('../dialects/dialect-loader');
const enumResolver = require('./enum-resolver');
const fieldEnums = require('../dialects/field-enums');
const { nonFiniteFloatToString, parseFloatSentinel } = require('../util/float-sentinels');
const { isBitmaskEnum, orBits, parseBitmaskValue } = require('../util/bitmask');

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
 * @param {string} [meta.connection]    connection display name
 * @param {string} [meta.connection_id] connection config-node id (canonical,
 *   #240) — the stable identity flows key per-link state on; a profile can be
 *   shared by several connections, so profile_id cannot disambiguate links
 * @param {object} [meta.transport]  transport descriptor (name/type/remote...)
 * @returns {object|null} decoded payload, or null if the msgid is unknown
 */
function decodePacket(bundle, packet, meta = {}) {
  const header = packet.header;
  const clazz = bundle && bundle.valid ? bundle.registry[header.msgid] : undefined;

  /**
   * The wire version byte comes from the frame itself, not header.magic:
   * node-mavlink's v1 parser never populates header.magic (it stays 0), so a v1
   * frame would otherwise report raw.magic = 0 (#138).
   */
  const wireMagic = packet.buffer && packet.buffer.length ? packet.buffer[0] : header.magic;

  const base = {
    name: clazz ? clazz.MSG_NAME : `UNKNOWN_${header.msgid}`,
    id: header.msgid,
    sysid: header.sysid,
    compid: header.compid,
    profile: meta.profile,
    profile_id: meta.profile_id,
    connection: meta.connection,
    connection_id: meta.connection_id,
    fields: {},
    raw: {
      magic: wireMagic,
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
    base.fields[field.source] = jsonSafeValue(data[field.name]);
  }

  /**
   * PARAM byte-union support (#146): on PX4-style stacks PARAM_VALUE /
   * PARAM_SET carry integer parameters as the raw bytes of the float32
   * `param_value` (PARAM_ENCODE_BYTEWISE). Every float32 NaN bit pattern —
   * including INT32 -1 = 0xFFFFFFFF — collapses to the one canonical JS NaN
   * the moment the float is read, so the exact wire bytes are captured here as
   * a derived `param_value_bits` key for the param workflow to decode integer
   * values losslessly. buildData only reads declared fields, so the extra key
   * never affects re-encoding a decoded payload.
   */
  if (clazz.MSG_NAME === 'PARAM_VALUE' || clazz.MSG_NAME === 'PARAM_SET') {
    const pv = clazz.FIELDS.find((f) => f.source === 'param_value' && f.type === 'float');
    if (pv && Buffer.isBuffer(packet.payload)) {
      const bytes = Buffer.alloc(4);
      packet.payload.copy(bytes, 0, pv.offset, Math.min(pv.offset + 4, packet.payload.length));
      base.fields.param_value_bits = bytes.readUInt32LE(0);
    }
  }
  return base;
}

/**
 * Convert a decoded field value into the JSON-safe public representation
 * (DESIGN.md §14.1). node-mavlink decodes `int64_t`/`uint64_t` fields as
 * `BigInt`, which preserves full precision but is not JSON-serializable and is
 * awkward for common downstream nodes (MQTT, HTTP, file, database, Debug JSON,
 * context store). The public contract is a decimal string: it survives
 * `JSON.stringify()`, keeps the full signed/unsigned 64-bit range, and feeds
 * back losslessly into the outbound builder, whose `coerce64()` accepts decimal
 * strings.
 *
 * Non-finite `float`/`double` values get the same treatment for the same
 * reason: `JSON.stringify` turns NaN/±Infinity into `null`, silently losing the
 * NaN "ignore" sentinel MAVLink uses on setpoint/gimbal fields and collapsing
 * the three values to one. They are represented as the strings "NaN" /
 * "Infinity" / "-Infinity", which the outbound builder accepts back on float
 * fields. Finite numbers, char strings, and arrays pass through unchanged. Never
 * route a 64-bit value through `Number`, where precision above 2^53 is lost.
 *
 * @param {*} value  a decoded scalar or array
 * @returns {*}
 */
function jsonSafeValue(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return nonFiniteFloatToString(value);
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafeValue);
  }
  return value;
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
    out[field.source] = resolveFieldValue(bundle, lookup.value, field, clazz);
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
 * @param {Function} [clazz]  message class, for the field's declared enum (#153)
 * @returns {*}
 */
function resolveFieldValue(bundle, value, field, clazz) {
  if (Array.isArray(value)) {
    const isArrayField = !field || field.type.endsWith('[]') || field.length > 1;
    if (!isArrayField) {
      return resolveFlagArray(bundle, value, field, clazz);
    }
    return value.map((v) => resolveSingleValue(bundle, v, field, clazz));
  }
  return resolveSingleValue(bundle, value, field, clazz);
}

/**
 * OR-combine an array supplied for a SCALAR field. Only a field backed by a
 * bitmask enum accepts this form — an additive flag list, e.g.
 * `type_mask: ['ATTITUDE_TARGET_TYPEMASK_BODY_ROLL_RATE_IGNORE',
 * 'ATTITUDE_TARGET_TYPEMASK_BODY_YAW_RATE_IGNORE']` → 5. Each element
 * resolves exactly like a scalar value (names, numbers, numeric strings, with
 * all the same integer/typo guards), then the values OR together; a 64-bit
 * bitmask field ORs as BigInt because coerce64 has already converted the
 * elements. Any other scalar field rejects the array loudly: the per-element
 * mapping used to pass the array straight through to node-mavlink's scalar
 * writer, which silently serializes garbage.
 *
 * @param {DialectBundle} bundle
 * @param {Array<*>} values
 * @param {MavLinkPacketField} field
 * @param {Function} [clazz]
 * @returns {number|bigint}
 * @throws {MavlinkError} FIELD_NOT_ARRAY when the field's enum is not a
 *   bitmask (or it has no declared enum at all)
 */
function resolveFlagArray(bundle, values, field, clazz) {
  const scopedEnum = fieldEnums.fieldEnumFor(bundle, clazz, field);
  const members = scopedEnum && bundle.enums.enumsByName ? bundle.enums.enumsByName[scopedEnum] : null;
  const memberValues = members
    ? Object.entries(members)
        .filter(([k, v]) => typeof v === 'number' && !/^\d+$/.test(k))
        .map(([, v]) => v)
    : [];
  if (!isBitmaskEnum(memberValues)) {
    throw new MavlinkError(
      'FIELD_NOT_ARRAY',
      `Field '${field.source}' (${field.type}) is scalar but got an array; ` +
        'only bitmask-enum fields combine an array of flags into one value.',
      { field: field.source, type: field.type }
    );
  }
  const resolved = values.map((v) => resolveSingleValue(bundle, v, field, clazz));
  /**
   * Every element must be a valid flag BEFORE the OR (Codex review): JS
   * bitwise silently wraps out-of-range numbers, so [-1] would become
   * 4294967295 and [4294967296] would become 0 — a valid-looking but wrong
   * mask, with no serializer error to catch it. 64-bit fields arrive as
   * BigInt (coerce64) and only need the sign check; the combined value must
   * also fit the field's unsigned wire width (a 0x80000000 flag cannot ride
   * a uint16 type_mask).
   */
  // Keyed off the FIELD type, not just the element types: an empty array on a
  // uint64 field must still return 0n, or the serializer gets a Number where
  // it expects a BigInt (Codex review).
  if (/^u?int64_t/.test(field.type)) {
    return resolved.reduce((acc, v) => {
      if (typeof v !== 'bigint' || v < 0n) {
        throw badFlag(field, v);
      }
      return acc | v;
    }, 0n);
  }
  for (const v of resolved) {
    if (parseBitmaskValue(v) === null) {
      throw badFlag(field, v);
    }
  }
  const combined = orBits(resolved);
  const width = /^uint(8|16|32)_t$/.exec(field.type);
  if (width && combined > 2 ** Number(width[1]) - 1) {
    throw new MavlinkError(
      'BAD_FLAG_VALUE',
      `Field '${field.source}' (${field.type}) flag array combines to ${combined}, ` +
        `which exceeds the field's unsigned ${width[1]}-bit range.`,
      { field: field.source, type: field.type, value: combined }
    );
  }
  return combined;
}

/**
 * Structured error for a flag-array element that is not a usable flag value
 * (negative, fractional, or above the uint32 flag range).
 *
 * @param {MavLinkPacketField} field
 * @param {*} value  the resolved offending element
 * @returns {MavlinkError}
 */
function badFlag(field, value) {
  return new MavlinkError(
    'BAD_FLAG_VALUE',
    `Field '${field.source}' (${field.type}) flag array got ${value}, ` +
      'which is not a non-negative integer flag value.',
    { field: field.source, type: field.type, value: typeof value === 'bigint' ? value.toString() : value }
  );
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
 * @param {Function} [clazz]  message class, for the field's declared enum (#153)
 * @returns {*}
 * @throws {MavlinkError} UNRESOLVED_FIELD_VALUE for unresolvable strings on
 *   numeric fields
 */
function resolveSingleValue(bundle, value, field, clazz) {
  /**
   * char/char[] fields carry text, not numbers or enum members, so enum/number
   * resolution must never run on them (issue #137): a string that is all digits
   * ("123") or that collides with an enum member name ("GENERIC") would become a
   * Number, and node-mavlink's char serializer then writes zero bytes — silently
   * corrupting STATUSTEXT.text, PARAM_SET.param_id, and any other char field.
   */
  if (field && isCharFieldType(field.type)) {
    return value;
  }
  const pre = coerce64(value, field);
  if (typeof pre === 'bigint') {
    return pre;
  }
  /**
   * Field-scoped enum resolution (#153): when the dialect declares which enum
   * backs this field (from the shipped declarations for bundled dialects, or
   * the XML `enum=` attribute for custom ones), a name resolves against THAT
   * enum only — the global index would happily turn a member of an unrelated
   * enum into a wrong-but-valid number, so `HEARTBEAT.type: 'MAV_STATE_ACTIVE'`
   * silently encoded MavState 4 as a MavType. A field with no declared enum
   * (COMMAND_LONG's generic params legitimately receive mode/flag members)
   * keeps global resolution, as does a dialect with no association metadata.
   */
  const scopedEnum = fieldEnums.fieldEnumFor(bundle, clazz, field);
  const useScoped =
    scopedEnum && typeof value === 'string' && bundle.enums.enumsByName && bundle.enums.enumsByName[scopedEnum];
  let resolved;
  if (useScoped) {
    const scoped = enumResolver.resolveInEnum(bundle.enums, scopedEnum, value);
    /** Unresolvable in the declared enum: keep the string so the error path
     * below names the field AND the enum the value was expected to come from. */
    resolved = coerce64(scoped === undefined ? value : scoped, field);
  } else {
    resolved = coerce64(enumResolver.resolveEnumValue(bundle.enums, value), field);
  }
  if (typeof resolved === 'string' && field && isNumericFieldType(field.type)) {
    /**
     * A finite decimal string on a float/double field is a real value, not a
     * typo — stringified MQTT/CSV inputs routinely arrive as "1.5" or "-2.5e3".
     * Accept it here (the enum resolver only auto-converts integer strings, to
     * avoid clobbering the int64 precision path). A blank/whitespace string is
     * NOT accepted: `Number('')`/`Number('  ')` are 0, which would silently turn
     * a missing CSV/MQTT value into a real zero — require non-empty content so
     * it fails loudly instead. Integer fields still reject a fractional string.
     * The non-finite sentinels "NaN"/"Infinity"/"-Infinity" are accepted on
     * float fields (the reverse of the decode representation above), so a NaN
     * "ignore" value round-trips; on integer fields they remain a typo. (#153)
     */
    if (isFloatFieldType(field.type) && resolved.trim() !== '') {
      const n = Number(resolved);
      if (Number.isFinite(n)) {
        return n;
      }
      const sentinel = parseFloatSentinel(resolved.trim());
      if (sentinel !== undefined) {
        return sentinel;
      }
    }
    const context = { field: field.source, type: field.type, value: resolved };
    let expected = 'a known enum name';
    if (useScoped) {
      expected = `a member of its declared enum ${enumResolver.camelToScreaming(scopedEnum)}`;
      context.enum = enumResolver.camelToScreaming(scopedEnum);
    }
    throw new MavlinkError(
      'UNRESOLVED_FIELD_VALUE',
      `Field '${field.source}' (${field.type}) got '${resolved}', which is neither a number nor ${expected}.`,
      context
    );
  }
  /**
   * An integer wire field must reject a fractional or non-finite Number
   * BEFORE serialization (#201): node-mavlink's writer silently truncates
   * (`target_system: 1.5` → 1, `NaN` → 0), so a flow could address a different
   * system or corrupt a counter with no error. 64-bit fields are already
   * converted to BigInt (or rejected) by coerce64 above; this guards the
   * 8/16/32-bit types, scalar and per array element. `Number.isInteger` is
   * false for fractions, NaN, and Infinity.
   */
  if (field && typeof resolved === 'number' && isIntegerWireType(field.type) && !Number.isInteger(resolved)) {
    throw new MavlinkError(
      'FIELD_NOT_INTEGER',
      `Field '${field.source}' (${field.type}) got ${resolved}, which is not an integer; ` +
        'integer wire fields reject fractional and non-finite numbers rather than silently truncating.',
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
 * True for the floating-point wire types (`float`, `double`), which — unlike
 * the integer types — legitimately carry fractional values, so a decimal
 * string like "1.5" is a valid input rather than a typo (#153).
 *
 * @param {string} type  e.g. 'float', 'double', 'uint16_t'
 * @returns {boolean}
 */
function isFloatFieldType(type) {
  return /^(float|double)/.test(String(type));
}

/**
 * True for the integer wire types (uint8/16/32/64_t, int8/16/32/64_t, and the
 * `uint8_t_mavlink_version` variant), which carry whole numbers only — a
 * fractional or non-finite value is a mistake to reject, not truncate (#201).
 *
 * @param {string} type  e.g. 'uint8_t', 'int32_t', 'float'
 * @returns {boolean}
 */
function isIntegerWireType(type) {
  return /^u?int(8|16|32|64)_t/.test(String(type));
}

/**
 * True for char/char[] wire types, whose values are text strings and must be
 * kept verbatim (never enum/number-resolved). Covers both a scalar `char` and
 * an array `char[N]`.
 *
 * @param {string} type  e.g. 'char', 'char[16]', 'uint16_t'
 * @returns {boolean}
 */
function isCharFieldType(type) {
  return /^char(\[|$)/.test(String(type));
}

/**
 * Coerce a Number or numeric string to BigInt for 64-bit integer fields.
 * node-mavlink stores uint64_t/int64_t as BigInt; flow payloads come from JSON,
 * which has no BigInt, so a plain number would otherwise throw "Cannot mix
 * BigInt and other types" deep in serialization. Strings convert losslessly
 * via BigInt(); `double` stays a JS number.
 *
 * A Number is accepted only when it is a SAFE integer (#201): above 2^53 a
 * JS Number has already lost bits, and a fractional value used to be silently
 * `Math.trunc`ed — both corrupt a 64-bit field without any error. Larger or
 * exact values must arrive as a BigInt or a decimal string.
 *
 * @param {*} value
 * @param {MavLinkPacketField} [field]
 * @returns {*}
 * @throws {MavlinkError} FIELD_NOT_INTEGER for a fractional/unsafe Number
 */
function coerce64(value, field) {
  if (!field || !/^u?int64_t/.test(field.type)) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MavlinkError(
        'FIELD_NOT_INTEGER',
        `Field '${field.source}' (${field.type}) got ${value}; a 64-bit integer field accepts a Number ` +
          'only when it is a safe integer — pass a BigInt or a decimal string for larger or exact values.',
        { field: field.source, type: field.type, value }
      );
    }
    return BigInt(value);
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
    instance[field.name] = resolveFieldValue(bundle, lookup.value, field, clazz);
  }
  return { instance, clazz };
}

/**
 * Inclusive integer wire-type ranges, keyed by the base type (the leading
 * `uint8_t`/`int16_t`/... of a field type — `uint8_t_mavlink_version` and
 * array types like `uint16_t[4]` reduce to their base). Used only to name the
 * offending field when serialization has already failed.
 */
const INT_RANGES = {
  int8_t: [-128, 127],
  uint8_t: [0, 255],
  int16_t: [-32768, 32767],
  uint16_t: [0, 65535],
  int32_t: [-2147483648, 2147483647],
  uint32_t: [0, 4294967295]
};

/** 64-bit ranges as BigInt, kept separate since their bounds exceed Number. */
const BIGINT_RANGES = {
  int64_t: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64_t: [0n, 2n ** 64n - 1n]
};

/**
 * If a single resolved field value is out of its wire-type's range or (for a
 * char field) not representable in Latin-1, describe the problem; otherwise
 * return null. `value` is a post-resolution scalar (number, BigInt, or string).
 *
 * @param {string} type  wire type, e.g. 'uint8_t', 'char[50]', 'float'
 * @param {*} value
 * @returns {?string} a human phrase naming the violation, or null
 */
function wireValueProblem(type, value) {
  if (isCharFieldType(type)) {
    if (typeof value === 'string') {
      for (const ch of value) {
        if (ch.codePointAt(0) > 255) {
          return `contains a non-Latin-1 character ('${ch}') — MAVLink char fields hold one byte per character`;
        }
      }
    }
    return null;
  }
  const base = String(type).match(/^u?int\d+_t/);
  /** float/double and anything else: no fixed integer range to check. */
  if (!base) {
    return null;
  }
  const key = base[0];
  const bigRange = BIGINT_RANGES[key];
  if (bigRange) {
    let big;
    try {
      big = typeof value === 'bigint' ? value : BigInt(value);
    } catch {
      /** Not an integer we can range-check here — leave it to the serializer. */
      return null;
    }
    return big < bigRange[0] || big > bigRange[1] ? `is out of range for ${key} [${bigRange[0]}, ${bigRange[1]}]` : null;
  }
  const range = INT_RANGES[key];
  if (!range || typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value < range[0] || value > range[1] ? `is out of range for ${key} [${range[0]}, ${range[1]}]` : null;
}

/**
 * Turn an opaque serialization RangeError into a structured error that names the
 * offending field (#153). node-mavlink's serializer throws a bare Node
 * `RangeError` ("The value of \"value\" is out of range...") with no field name
 * when an integer value overflows its wire type or a char field carries a
 * non-Latin-1 character, so the flow author cannot tell which of a dozen fields
 * is at fault. This runs only after serialization has already failed: it scans
 * the built instance for the first field whose value violates its wire type and
 * returns a labelled {@link MavlinkError}, or null when no such field is found
 * (leave the original error to the caller).
 *
 * @param {Function} clazz     the message class that failed to serialize
 * @param {object} instance    the built MavLinkData instance (resolved values)
 * @returns {?MavlinkError} a FIELD_OUT_OF_RANGE error naming the field, or null
 */
function describeSerializeError(clazz, instance) {
  for (const field of clazz.FIELDS) {
    const raw = instance[field.name];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const problem = wireValueProblem(field.type, value);
      if (problem) {
        const shown = typeof value === 'string' ? `'${value}'` : String(value);
        return new MavlinkError(
          'FIELD_OUT_OF_RANGE',
          `Field '${field.source}' (${field.type}) ${problem} (got ${shown}).`,
          { field: field.source, type: field.type, value: typeof value === 'bigint' ? value.toString() : value }
        );
      }
    }
  }
  return null;
}

module.exports = {
  decodePacket,
  normalizeFields,
  buildData,
  describeSerializeError
};
