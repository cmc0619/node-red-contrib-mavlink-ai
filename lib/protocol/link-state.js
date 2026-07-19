'use strict';

const { ReplayTracker } = require('./replay-tracker');

/**
 * Per-connection MAVLink channel/session state (issues #192, #228).
 *
 * MAVLink scopes packet sequence numbers to the sending component and signing
 * timestamps to the `(SystemID, ComponentID, LinkID)` stream. That state used
 * to live inside each dialect codec, which broke whenever two routed profiles
 * shared one local identity (duplicate sequence/timestamp streams) or a codec
 * was rebuilt on a live link (sequence/replay state silently reset). It now
 * lives here, owned by the Connection and keyed by local identity, so:
 *
 *  - sequence numbers advance per local `(sysid, compid)` no matter which
 *    dialect codec serialized the frame;
 *  - outbound signing timestamps stay unique and monotonic per
 *    `(sysid, compid, linkId)` across routed vehicle profiles and hot reloads;
 *  - inbound anti-replay memory survives a dialect/profile rebuild as long as
 *    the verification key is unchanged (a new key starts a fresh tracker);
 *  - per-peer wire-version detection ("auto" mode) is shared by every codec on
 *    the link instead of being re-learned per dialect.
 *
 * A LinkState instance lives exactly as long as its connection's
 * transport/session: it is created when the connection constructs and reset
 * only when the link itself is torn down (deactivate), never on a profile or
 * identity edit.
 */
class LinkState {
  constructor() {
    /** 'sysid:compid' -> next outbound sequence number (0..255). */
    this._seq = new Map();
    /** 'sysid:compid:linkId' -> last outbound signing timestamp (ms). */
    this._signMs = new Map();
    /**
     * key (hex) -> ReplayTracker. Keyed by the derived signing key so replay
     * memory survives codec/profile rebuilds under the same key, while a key
     * change (which invalidates old signatures anyway) starts fresh.
     */
    this._replayByKey = new Map();
    /** Peer sysid -> 'v1' | 'v2' observed on inbound frames (issue #69). */
    this._detectedBySysid = new Map();
    /** Version of the most recent inbound frame, for untargeted sends. */
    this._lastDetected = null;
  }

  /**
   * Next outbound sequence number for one local sender identity, wrapping at
   * 8 bits. Each `(sysid, compid)` advances independently, as the packet-loss
   * accounting rules require.
   *
   * @param {number} sysid   local source system id
   * @param {number} compid  local source component id
   * @returns {number} 0..255
   */
  nextSeq(sysid, compid) {
    const key = `${sysid}:${compid}`;
    const seq = this._seq.get(key) || 0;
    this._seq.set(key, (seq + 1) & 0xff);
    return seq;
  }

  /**
   * A strictly-increasing signing timestamp (Date.now() milliseconds) for one
   * `(sysid, compid, linkId)` signing stream. The signing spec requires each
   * signed frame on a stream to carry a timestamp greater than the previous
   * one; two frames emitted in the same millisecond would otherwise share a
   * timestamp and the receiver would drop the second as a replay.
   *
   * @param {number} sysid   local source system id
   * @param {number} compid  local source component id
   * @param {number} linkId  connection-owned signing link id
   * @returns {number}
   */
  nextSignTimestampMs(sysid, compid, linkId) {
    const key = `${sysid}:${compid}:${linkId}`;
    const last = this._signMs.get(key) || 0;
    const nowMs = Date.now();
    const next = nowMs > last ? nowMs : last + 1;
    this._signMs.set(key, next);
    return next;
  }

  /**
   * The inbound anti-replay tracker for a verification key. The same key gets
   * the same tracker for the life of the link, so a dialect/profile/identity
   * rebuild cannot reset replay memory and re-accept a recently captured frame
   * within the freshness window (#192). A different key gets a fresh tracker.
   *
   * @param {Buffer} key  the derived 32-byte signing key
   * @returns {ReplayTracker}
   */
  replayTrackerFor(key) {
    const id = Buffer.isBuffer(key) ? key.toString('hex') : String(key);
    let tracker = this._replayByKey.get(id);
    if (!tracker) {
      tracker = new ReplayTracker();
      this._replayByKey.set(id, tracker);
    }
    return tracker;
  }

  /**
   * Record the wire version observed on an inbound packet (issue #19). In
   * "auto" mode outbound framing follows the peer: a v1-only peer (0xFE magic)
   * silently ignores v2 frames. Tracked per source sysid so a mixed v1/v2
   * fleet on one link frames each target correctly (#69).
   *
   * @param {number} magic  first wire byte (0xFD = v2, 0xFE = v1)
   * @param {number} [sysid]  source system of the frame
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
   * The wire version outbound packets should use right now: the explicit
   * profile setting, or for "auto" the detected version — of the addressed
   * peer when a target sysid is given, else the most recent inbound frame
   * (v2 until any inbound is seen).
   *
   * @param {string} configured  'auto' | 'v1' | 'v2' (the vehicle profile's setting)
   * @param {number} [targetSysid]  the system this frame is addressed to
   * @returns {string} 'v1' | 'v2'
   */
  effectiveVersion(configured, targetSysid) {
    if (configured === 'v1' || configured === 'v2') {
      return configured;
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
   * Detected peer sysids grouped by wire version — but only when the fleet is
   * genuinely mixed. A broadcast to a mixed fleet must be encoded once per
   * version group (#199): a single frame can only carry one magic byte, and a
   * v1-only vehicle silently drops 0xFD frames. Returns null for an empty or
   * single-version fleet so the caller keeps the one-encode fast path.
   *
   * @returns {?{v1: number[], v2: number[]}}
   */
  mixedVersionGroups() {
    const v1 = [];
    const v2 = [];
    for (const [sysid, version] of this._detectedBySysid) {
      (version === 'v1' ? v1 : v2).push(sysid);
    }
    if (v1.length === 0 || v2.length === 0) {
      return null;
    }
    return { v1, v2 };
  }
}

module.exports = { LinkState };
