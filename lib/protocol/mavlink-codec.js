'use strict';

const {
  MavLinkProtocolV1,
  MavLinkProtocolV2,
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  x25crc
} = require('node-mavlink');

const normalizer = require('./message-normalizer');
const { MavlinkError } = require('../util/errors');
const { getMessageClass } = require('../dialects/dialect-loader');

/** V1 frame header length (magic, len, seq, sysid, compid, msgid). */
const V1_PAYLOAD_OFFSET = 6;

/**
 * The v1 wire payload length for a message class: the byte offset where its
 * MAVLink-2 extension fields begin, or the full length when it has none. MAVLink
 * appends extension fields after the base block in wire order, so this is the
 * boundary to truncate at. Equal to PAYLOAD_LENGTH for messages with no
 * extensions.
 *
 * @param {object} clazz  a node-mavlink message data class
 * @returns {number}
 */
function v1BasePayloadLength(clazz) {
  let base = clazz.PAYLOAD_LENGTH;
  for (const field of clazz.FIELDS) {
    if (field.extension && field.offset < base) {
      base = field.offset;
    }
  }
  return base;
}

/**
 * Re-frame a node-mavlink v1 buffer without its MAVLink-2 extension fields
 * (issue #138). node-mavlink's V1 serializer writes the full PAYLOAD_LENGTH —
 * including extension bytes — but the MAVLink 1 spec forbids extension fields on
 * the wire (a v1 COMMAND_ACK must be 3 payload bytes, not 10), and strict
 * parsers reject the over-length frame. Truncate the payload to the base length,
 * fix the length byte, and recompute the CRC over the shortened frame. A message
 * with no extensions is returned unchanged.
 *
 * @param {Buffer} buffer  the full v1 frame from node-mavlink
 * @param {object} clazz   the message data class (for extension offsets + CRC extra)
 * @returns {Buffer}
 */
function truncateV1Extensions(buffer, clazz) {
  const baseLen = v1BasePayloadLength(clazz);
  if (baseLen >= clazz.PAYLOAD_LENGTH) {
    return buffer;
  }
  const out = Buffer.alloc(V1_PAYLOAD_OFFSET + baseLen + 2);
  buffer.copy(out, 0, 0, V1_PAYLOAD_OFFSET + baseLen);
  out.writeUInt8(baseLen, 1);
  const crc = x25crc(out, 1, 2, clazz.MAGIC_NUMBER);
  out.writeUInt16LE(crc, out.length - 2);
  return out;
}

/**
 * Validate a MAVLink uint8 identity value (#90). Anything supplied must be an
 * integer within [min, 255] — invalid values throw instead of being silently
 * truncated or wrapped.
 *
 * @param {*} value
 * @param {string} field  field name for the error
 * @param {number} [min=0]
 * @returns {number}
 * @throws {MavlinkError} IDENTITY_INVALID
 */
function requireUint8(value, field, min = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > 255) {
    throw new MavlinkError(
      'IDENTITY_INVALID',
      `${field} must be an integer in [${min}, 255] (got ${JSON.stringify(value)}).`,
      { field, value }
    );
  }
  return n;
}

/**
 * The protocol wrapper from DESIGN.md §16, dialect-scoped only (issues #192,
 * #228). Node files should never touch `node-mavlink` directly — they go
 * through a codec instance, which owns the dialect bundle and the configured
 * wire-version preference and NOTHING else.
 *
 * Everything that is channel or identity state is deliberately *not* here:
 *
 *  - the local source sysid/compid come from the resolved Local Identity and
 *    are passed per encode() call;
 *  - the packet sequence counter, signing timestamps, per-peer detected wire
 *    versions, and inbound replay memory live in the connection-owned
 *    {@link LinkState} (lib/protocol/link-state.js);
 *  - the signing key/policy comes from the Local Identity, and the signing
 *    link id from the Connection.
 *
 * That separation is what lets one connection cache a codec per Vehicle
 * Profile (dialect) while several local identities transmit through it, each
 * with its own correct sequence/signing stream — and lets a codec rebuild
 * (profile edit) happen without resetting any channel state.
 */
class MavlinkCodec {
  /**
   * @param {object} opts
   * @param {DialectBundle} opts.bundle
   * @param {string} [opts.version]  "auto" | "v1" | "v2" (default auto -> v2)
   */
  constructor({ bundle, version = 'auto' }) {
    if (!bundle || !bundle.valid) {
      throw new MavlinkError(
        'DIALECT_INVALID',
        `Cannot create codec: dialect '${bundle && bundle.name}' is not valid.`,
        bundle && bundle.error ? bundle.error.context : {}
      );
    }
    this.bundle = bundle;
    this.version = version;
  }

  /**
   * Create a streaming decoder. Feed raw bytes via `write()`; each complete,
   * CRC-valid packet is delivered to `onPacket(packet)`. Returns a handle with
   * `write(buffer)` and `destroy()`.
   *
   * @param {function} onPacket
   * @param {function} [onError]
   * @param {object} [opts]
   * @param {object} [opts.magicNumbers]  override the CRC-extra table — a routed
   *   connection passes a merge across all its profiles' dialects so message ids
   *   defined only by a routed (e.g. custom) dialect survive the splitter.
   */
  createDecoder(onPacket, onError, opts = {}) {
    const splitter = new MavLinkPacketSplitter(
      {},
      { magicNumbers: opts.magicNumbers || this.bundle.magicNumbers }
    );
    const parser = new MavLinkPacketParser();
    splitter.pipe(parser);

    parser.on('data', (packet) => {
      try {
        onPacket(packet);
      } catch (err) {
        if (onError) {
          onError(err);
        }
      }
    });
    // Always attach an 'error' listener: an unhandled stream 'error' event would
    // otherwise crash the process on a single malformed packet.
    const handleStreamError = onError || (() => {});
    splitter.on('error', handleStreamError);
    parser.on('error', handleStreamError);

    return {
      write(buffer) {
        splitter.write(buffer);
      },
      destroy() {
        try {
          splitter.unpipe(parser);
          splitter.removeAllListeners();
          parser.removeAllListeners();
          splitter.destroy();
          parser.destroy();
        } catch (e) {
          /* best-effort cleanup */
        }
      }
    };
  }

  /**
   * Decode a raw packet into the §14.1 decoded payload object.
   */
  decode(packet, meta) {
    return normalizer.decodePacket(this.bundle, packet, meta);
  }

  /**
   * Whether a message type carries a `target_system` field — i.e. it addresses
   * a specific system rather than being a broadcast. Used so a udp-peer
   * transport fans a genuinely untargeted message (HEARTBEAT, ...) out to every
   * peer instead of unicasting it to the profile's default target (#148). An
   * unknown message name is treated as unaddressed.
   *
   * @param {string} name  MAVLink message name
   * @returns {boolean}
   */
  addressesTarget(name) {
    try {
      const clazz = getMessageClass(this.bundle, name);
      return clazz.FIELDS.some((field) => field.source === 'target_system');
    } catch (e) {
      return false;
    }
  }

  /**
   * Build and serialize an outbound message into a wire-ready Buffer.
   *
   * The sender context is explicit on every call (issues #192, #228): the
   * resolved Local Identity supplies `sysid`/`compid` and the signing
   * key/policy, the Connection supplies the shared {@link LinkState} (sequence
   * + signing-timestamp streams) and the signing link id. The codec itself
   * contributes only the dialect and the configured version preference.
   *
   * @param {string} name    MAVLink message name, e.g. "COMMAND_LONG"
   * @param {object} fields  field values (snake_case or camelCase, enum names ok)
   * @param {object} opts
   * @param {number} opts.sysid    local source system id (from the Local Identity)
   * @param {number} opts.compid   local source component id
   * @param {LinkState} opts.link  the connection's channel state
   * @param {?object} [opts.signing]  outbound signing context, or null/absent to
   *   send unsigned: { key: Buffer, linkId: number }
   * @param {number} [opts.targetSystem]     applied to target_system if present
   * @param {number} [opts.targetComponent]  applied to target_component if present
   * @returns {Buffer}
   */
  encode(name, fields, opts = {}) {
    const link = opts.link;
    if (!link || typeof link.nextSeq !== 'function') {
      throw new MavlinkError('LINK_STATE_REQUIRED', 'encode() requires the connection LinkState (opts.link).');
    }
    // Source identity is stamped into every outbound frame header as uint8s.
    // Enforce the range here (#90) so an out-of-range value fails the send
    // instead of being truncated by the serializer. Source sysid 0 means
    // "unknown/broadcast" and is not a valid sender id.
    const sysid = requireUint8(opts.sysid, 'Source system id', 1);
    const compid = requireUint8(opts.compid, 'Source component id', 0);

    const merged = { ...(fields || {}) };
    if (opts.targetSystem !== undefined && merged.target_system === undefined && merged.targetSystem === undefined) {
      merged.target_system = opts.targetSystem;
    }
    if (
      opts.targetComponent !== undefined &&
      merged.target_component === undefined &&
      merged.targetComponent === undefined
    ) {
      merged.target_component = opts.targetComponent;
    }

    const { instance, clazz } = normalizer.buildData(this.bundle, name, merged);

    /**
     * Signed outbound frames are MAVLink 2 only. When a signing context is
     * supplied we build a V2 protocol with the IFLAG_SIGNED incompatibility
     * flag set (so the header and CRC account for it), serialize, then append
     * the signature block — this is exactly node-mavlink's own sendSigned()
     * sequence, just split so the framed buffer can flow through our outbound
     * queue/transport. Sequence numbers and signing timestamps come from the
     * shared LinkState so they stay correct per identity/stream no matter
     * which codec serialized the frame (#192).
     *
     * The serialize calls are wrapped so an opaque range/charset RangeError from
     * node-mavlink becomes a structured error naming the offending field (#153).
     */
    try {
      if (opts.signing && opts.signing.key) {
        const linkId = requireUint8(opts.signing.linkId || 0, 'Signing link id', 0);
        const protocol = new MavLinkProtocolV2(sysid, compid, MavLinkProtocolV2.IFLAG_SIGNED);
        const unsigned = protocol.serialize(instance, link.nextSeq(sysid, compid));
        return protocol.sign(
          unsigned,
          linkId,
          opts.signing.key,
          link.nextSignTimestampMs(sysid, compid, linkId)
        );
      }

      const protocol =
        link.effectiveVersion(this.version, opts.targetSystem) === 'v1' && !(clazz.MSG_ID > 255)
          ? new MavLinkProtocolV1(sysid, compid)
          : new MavLinkProtocolV2(sysid, compid);
      const frame = protocol.serialize(instance, link.nextSeq(sysid, compid));
      if (protocol instanceof MavLinkProtocolV1) {
        /** v1 framing must not carry MAVLink-2 extension fields (#138). */
        return truncateV1Extensions(frame, clazz);
      }
      return frame;
    } catch (err) {
      /**
       * node-mavlink's serializer throws a bare Node RangeError with no field
       * name when an integer overflows its wire type or a char field carries a
       * non-Latin-1 character. Replace it with a structured error naming the
       * offending field so a flow author can find the mistake (#153); anything
       * else propagates unchanged.
       */
      if (err instanceof RangeError || err.code === 'ERR_OUT_OF_RANGE') {
        const named = normalizer.describeSerializeError(clazz, instance);
        if (named) {
          throw named;
        }
      }
      throw err;
    }
  }

  /**
   * Build a normalized outbound message object (the §14.2 contract) without
   * encoding it — used by mavlink-ai-build.
   */
  buildNormalized(name, fields, opts = {}) {
    // Validate the name resolves and produce a clean snake_case field set.
    const { clazz } = normalizer.buildData(this.bundle, name, fields);
    const normFields = normalizer.normalizeFields(this.bundle, clazz, fields);
    const out = { name: clazz.MSG_NAME, fields: normFields };
    if (opts.vehicleProfile !== undefined) {
      out.vehicleProfile = opts.vehicleProfile;
    }
    if (opts.targetSystem !== undefined) {
      out.target_system = opts.targetSystem;
    }
    if (opts.targetComponent !== undefined) {
      out.target_component = opts.targetComponent;
    }
    return out;
  }
}

/**
 * Decide whether an inbound packet passes signature verification (issue #15),
 * against an explicit policy — the connection resolves the policy/key from its
 * default Local Identity and the replay tracker from its LinkState, so this is
 * a pure function of (packet, policy) rather than hidden codec state (#192).
 *
 * Checks signature *authenticity* (does the frame's 48-bit signature match the
 * key) and then, as the signing spec requires, **anti-replay** (#100): the
 * frame's timestamp must be within a minute of the current clock (freshness)
 * and must exceed the last accepted timestamp for its `(sysid, compid, linkId)`
 * stream (monotonic).
 *
 * Returns `null` when verification is disabled (the packet flows through
 * unchanged). Otherwise returns a decision describing the outcome:
 *
 *  - unsigned + not required        -> accepted (unsigned traffic allowed)
 *  - unsigned + require signature   -> rejected 'signature-required'
 *  - signed but no key to check     -> rejected 'signature-no-key'
 *  - signed + signature mismatch    -> rejected 'signature-invalid'
 *  - signed + valid + stale/replay  -> rejected 'signature-replayed'
 *  - signed + valid + fresh         -> accepted 'signature-valid'
 *
 * @param {MavLinkPacket} packet  a decoded packet (its `.signature` is non-null
 *   only for signed frames)
 * @param {?object} policy  { verifyInbound, requireSignature, key, replay } —
 *   `key` is the derived 32-byte signing key or null; `replay` is the
 *   connection's ReplayTracker for that key, or null to skip anti-replay
 * @returns {?{accepted: boolean, reason: string, signed: boolean}}
 */
function verifyInboundPacket(packet, policy) {
  if (!policy || !policy.verifyInbound) {
    return null; // verification disabled: pass through
  }
  const signed = Boolean(packet && packet.signature);
  if (!signed) {
    return policy.requireSignature
      ? { accepted: false, reason: 'signature-required', signed: false }
      : { accepted: true, reason: 'unsigned-allowed', signed: false };
  }
  if (!policy.key) {
    // Verification asked for, but no passphrase to check against: fail closed
    // rather than wave the frame through unverified.
    return { accepted: false, reason: 'signature-no-key', signed: true };
  }
  if (!packet.signature.matches(policy.key)) {
    return { accepted: false, reason: 'signature-invalid', signed: true };
  }
  if (policy.replay) {
    /** Authentic frame: enforce the monotonic per-stream timestamp rule. */
    const decision = policy.replay.check(
      packet.header.sysid,
      packet.header.compid,
      packet.signature.linkId,
      packet.signature.timestamp
    );
    return { accepted: decision.accepted, reason: decision.reason, signed: true };
  }
  return { accepted: true, reason: 'signature-valid', signed: true };
}

module.exports = { MavlinkCodec, verifyInboundPacket };
