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
 *    the verification key is unchanged (a new key starts a fresh tracker).
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
}

module.exports = { LinkState };
