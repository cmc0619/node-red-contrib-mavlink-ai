'use strict';

const {
  MavLinkProtocolV1,
  MavLinkProtocolV2,
  MavLinkPacketSplitter,
  MavLinkPacketParser
} = require('node-mavlink');

const normalizer = require('./message-normalizer');
const { MavlinkError } = require('../util/errors');

/**
 * The protocol wrapper from DESIGN.md §16. Node files should never touch
 * `node-mavlink` directly — they go through a codec instance which owns the
 * dialect bundle, the wire protocol version, and the source identity used when
 * encoding outbound messages.
 *
 * One codec is created per connection. It is intentionally stateful (sequence
 * counter, decoder stream) but all state is scoped to the instance — no module
 * level singletons (DESIGN.md §19).
 */
class MavlinkCodec {
  /**
   * @param {object} opts
   * @param {DialectBundle} opts.bundle
   * @param {string} [opts.version]  "auto" | "v1" | "v2" (default auto -> v2)
   * @param {number} [opts.sysid]    source system id for outbound packets
   * @param {number} [opts.compid]   source component id for outbound packets
   */
  constructor({ bundle, version = 'auto', sysid = 255, compid = 190 }) {
    if (!bundle || !bundle.valid) {
      throw new MavlinkError(
        'DIALECT_INVALID',
        `Cannot create codec: dialect '${bundle && bundle.name}' is not valid.`,
        bundle && bundle.error ? bundle.error.context : {}
      );
    }
    this.bundle = bundle;
    this.version = version;
    this.sysid = sysid;
    this.compid = compid;
    this._seq = 0;
  }

  /**
   * Build a protocol serializer for the configured version. "auto" and "v2"
   * both serialize as V2 (the modern default); "v1" uses V1.
   *
   * @returns {MavLinkProtocolV1|MavLinkProtocolV2}
   */
  _makeProtocol() {
    if (this.version === 'v1') {
      return new MavLinkProtocolV1(this.sysid, this.compid);
    }
    return new MavLinkProtocolV2(this.sysid, this.compid);
  }

  /**
   * Return the next outbound sequence number, wrapping at 8 bits.
   *
   * @returns {number} 0..255
   */
  _nextSeq() {
    const seq = this._seq;
    this._seq = (this._seq + 1) & 0xff;
    return seq;
  }

  /**
   * Create a streaming decoder. Feed raw bytes via `write()`; each complete,
   * CRC-valid packet is delivered to `onPacket(packet)`. Returns a handle with
   * `write(buffer)` and `destroy()`.
   */
  createDecoder(onPacket, onError) {
    const splitter = new MavLinkPacketSplitter(
      {},
      { magicNumbers: this.bundle.magicNumbers }
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
    if (onError) {
      splitter.on('error', onError);
      parser.on('error', onError);
    }

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
   * Build and serialize an outbound message into a wire-ready Buffer.
   *
   * @param {string} name    MAVLink message name, e.g. "COMMAND_LONG"
   * @param {object} fields  field values (snake_case or camelCase, enum names ok)
   * @param {object} [opts]
   * @param {number} [opts.targetSystem]     applied to target_system if present
   * @param {number} [opts.targetComponent]  applied to target_component if present
   * @returns {Buffer}
   */
  encode(name, fields, opts = {}) {
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

    const { instance } = normalizer.buildData(this.bundle, name, merged);
    const protocol = this._makeProtocol();
    return protocol.serialize(instance, this._nextSeq());
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
    if (opts.profile !== undefined) {
      out.profile = opts.profile;
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

module.exports = { MavlinkCodec };
