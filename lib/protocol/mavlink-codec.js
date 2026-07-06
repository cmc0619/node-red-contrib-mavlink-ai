'use strict';

const {
  MavLinkProtocolV1,
  MavLinkProtocolV2,
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  MavLinkPacketSignature
} = require('node-mavlink');

const normalizer = require('./message-normalizer');
const { MavlinkError } = require('../util/errors');

/**
 * Normalize a raw signing config (from the profile) into the codec's internal
 * shape, or null when signing is entirely off. MAVLink 2 signing (issue #15)
 * is a thin wrapper over what `node-mavlink` exposes:
 *
 *  - `MavLinkPacketSignature.key(passphrase)` derives the 32-byte SHA-256 key
 *    (the same derivation Mission Planner / QGroundControl use).
 *  - a V2 protocol constructed with `IFLAG_SIGNED` + `sign()` produces a signed
 *    outbound frame (13 trailing bytes: link id, timestamp, 48-bit signature).
 *  - an inbound `MavLinkPacket.signature` (non-null only for signed frames)
 *    exposes `.matches(key)` for verification.
 *
 * We deliberately do not build a custom signing/crypto layer on top of that.
 *
 * @param {object|null} signing
 * @returns {?{passphrase: string, linkId: number, signOutbound: boolean,
 *   verifyInbound: boolean, requireSignature: boolean}}
 */
function normalizeSigning(signing) {
  if (!signing || typeof signing !== 'object') {
    return null;
  }
  const passphrase = typeof signing.passphrase === 'string' ? signing.passphrase : '';
  const signOutbound = signing.signOutbound === true;
  const requireSignature = signing.requireSignature === true;
  // 'Require signature' is a fail-closed policy: it is meaningless without
  // inbound verification, so it implies it (#70). Otherwise a profile with
  // requireSignature=true but verifyInbound=false would silently accept
  // unsigned frames — the opposite of what the setting says.
  const verifyInbound = signing.verifyInbound === true || requireSignature;
  // Nothing configured -> behave exactly as before (no signing overhead).
  if (!passphrase && !signOutbound && !verifyInbound && !requireSignature) {
    return null;
  }
  let linkId = Number(signing.linkId);
  linkId = Number.isFinite(linkId) ? ((Math.trunc(linkId) % 256) + 256) % 256 : 0;
  return { passphrase, linkId, signOutbound, verifyInbound, requireSignature };
}

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
   * @param {object} [opts.signing]  MAVLink 2 signing config (issue #15):
   *   { passphrase, linkId, signOutbound, verifyInbound, requireSignature }
   */
  constructor({ bundle, version = 'auto', sysid = 255, compid = 190, signing = null }) {
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
    // Observed wire version (auto mode). One connection can carry several peers
    // that don't all speak the same version (a udp-peer link with a v1-only and
    // a v2 vehicle), so track per source sysid and frame outbound to *that*
    // target's version — not just whichever peer spoke last (#69). `_lastMagic`
    // keeps the old global behavior as the fallback for untargeted sends.
    this._detectedBySysid = new Map(); // sysid -> 'v1' | 'v2'
    this._lastDetected = null; // 'v1' | 'v2' from the most recent inbound frame

    // MAVLink 2 signing (issue #15). The 32-byte key is derived once from the
    // passphrase; a config with no passphrase but a verify/require flag still
    // records the intent so inbound handling can react (e.g. reject when a
    // signature is required but no key is configured to check it).
    this.signing = normalizeSigning(signing);
    this._signKey =
      this.signing && this.signing.passphrase ? MavLinkPacketSignature.key(this.signing.passphrase) : null;

    // Sign-outbound with no passphrase would silently downgrade to unsigned
    // frames (signsOutbound() is false without a key). Warn loudly rather than
    // let the misconfiguration pass unnoticed.
    if (this.signing && this.signing.signOutbound && !this._signKey) {
      // eslint-disable-next-line no-console
      console.warn(
        "[mavlink-ai] 'Sign outbound' is enabled but no signing passphrase is set — " +
          'outbound packets will be sent UNSIGNED. Set a passphrase on the profile to sign them.'
      );
    }
  }

  /**
   * Whether this codec signs outbound frames (passphrase present + enabled).
   *
   * @returns {boolean}
   */
  signsOutbound() {
    return Boolean(this._signKey && this.signing && this.signing.signOutbound);
  }

  /**
   * Record the wire version observed on an inbound packet (issue #19). In
   * "auto" mode outbound framing follows the peer: a v1-only peer (0xFE magic)
   * silently ignores v2 frames, so matching what it speaks is the only way
   * commands reach it. Tracks the most recent magic, so a peer that upgrades
   * to v2 mid-session is followed too. Explicit "v1"/"v2" are never affected.
   *
   * @param {number} magic  first wire byte (0xFD = v2, 0xFE = v1)
   * @param {number} [sysid]  source system of the frame, so the version is
   *   tracked per peer (auto mode with mixed v1/v2 vehicles on one connection)
   * @returns {void}
   */
  noteInboundMagic(magic, sysid) {
    const detected = magic === 0xfd ? 'v2' : magic === 0xfe ? 'v1' : null;
    if (!detected) {
      return;
    }
    this._lastDetected = detected;
    if (sysid != null && Number.isFinite(Number(sysid))) {
      this._detectedBySysid.set(Number(sysid), detected);
    }
  }

  /**
   * The wire version outbound packets use right now: the explicit setting, or
   * for "auto" the detected version — of the addressed peer when a target sysid
   * is given, else the most recent inbound frame (v2 until any inbound is seen).
   *
   * @param {number} [targetSysid]  the system this frame is addressed to
   * @returns {string} 'v1' | 'v2'
   */
  effectiveVersion(targetSysid) {
    if (this.version === 'v1' || this.version === 'v2') {
      return this.version;
    }
    if (targetSysid != null) {
      const perPeer = this._detectedBySysid.get(Number(targetSysid));
      if (perPeer) {
        return perPeer;
      }
    }
    return this._lastDetected || 'v2';
  }

  /**
   * Build a protocol serializer for the effective version. Messages with ids
   * above 255 cannot be expressed in v1 framing at all, so they stay v2 even
   * when a v1 peer was detected — sending v2 is no worse than not sending.
   *
   * @param {number} [msgid]  message id about to be serialized
   * @param {number} [targetSysid]  addressed system, for per-peer version
   * @returns {MavLinkProtocolV1|MavLinkProtocolV2}
   */
  _makeProtocol(msgid, targetSysid) {
    if (this.effectiveVersion(targetSysid) === 'v1' && !(msgid > 255)) {
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

    const { instance, clazz } = normalizer.buildData(this.bundle, name, merged);

    // Signed outbound frames are MAVLink 2 only. When signing is enabled we
    // build a V2 protocol with the IFLAG_SIGNED incompatibility flag set (so
    // the header and CRC account for it), serialize, then append the signature
    // block — this is exactly node-mavlink's own sendSigned() sequence, just
    // split so the framed buffer can flow through our outbound queue/transport.
    if (this.signsOutbound()) {
      const protocol = new MavLinkProtocolV2(this.sysid, this.compid, MavLinkProtocolV2.IFLAG_SIGNED);
      const unsigned = protocol.serialize(instance, this._nextSeq());
      return protocol.sign(unsigned, this.signing.linkId, this._signKey);
    }

    const protocol = this._makeProtocol(clazz.MSG_ID, opts.targetSystem);
    return protocol.serialize(instance, this._nextSeq());
  }

  /**
   * Decide whether an inbound packet passes signature verification (issue #15).
   *
   * Scope: this checks signature *authenticity* only (does the frame's 48-bit
   * signature match our key). It does NOT implement MAVLink signing's optional
   * replay protection — the per-(sysid, compid, linkId) monotonic timestamp
   * state and freshness window — because node-mavlink exposes only the
   * authenticity check (`MavLinkPacketSignature.matches`) and stateful,
   * persisted replay tracking is out of scope for this minimal 1.0 support. A
   * captured valid frame can therefore be replayed; document that for anyone
   * relying on signing as anti-replay. (README notes the same.)
   *
   * Returns `null` when verification is disabled (the packet flows through
   * unchanged, exactly as before signing existed). Otherwise returns a decision
   * describing the outcome so the connection can accept the packet or emit a
   * structured rejection:
   *
   *  - unsigned + not required        -> accepted (unsigned traffic allowed)
   *  - unsigned + require signature   -> rejected 'signature-required'
   *  - signed but no key to check     -> rejected 'signature-no-key'
   *  - signed + signature mismatch    -> rejected 'signature-invalid'
   *  - signed + signature matches     -> accepted 'signature-valid'
   *
   * @param {MavLinkPacket} packet  a decoded packet (its `.signature` is a
   *   MavLinkPacketSignature for signed frames, or null for unsigned ones)
   * @returns {?{accepted: boolean, reason: string, signed: boolean}}
   */
  verifyInboundPacket(packet) {
    if (!this.signing || !this.signing.verifyInbound) {
      return null; // verification disabled: pass through
    }
    const signed = Boolean(packet && packet.signature);
    if (!signed) {
      return this.signing.requireSignature
        ? { accepted: false, reason: 'signature-required', signed: false }
        : { accepted: true, reason: 'unsigned-allowed', signed: false };
    }
    if (!this._signKey) {
      // Verification asked for, but no passphrase to check against: fail closed
      // rather than wave the frame through unverified.
      return { accepted: false, reason: 'signature-no-key', signed: true };
    }
    return packet.signature.matches(this._signKey)
      ? { accepted: true, reason: 'signature-valid', signed: true }
      : { accepted: false, reason: 'signature-invalid', signed: true };
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
