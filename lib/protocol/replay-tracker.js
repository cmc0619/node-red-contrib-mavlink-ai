'use strict';

/**
 * MAVLink 2 signing anti-replay: the monotonic-timestamp rule (issues #100/#101).
 *
 * A signed MAVLink 2 frame carries a `link_id` and a 48-bit `timestamp`. The
 * signing spec accepts a frame only when its signature matches AND its timestamp
 * is strictly greater than the last accepted timestamp for that *signing stream*
 * — the `(sysid, compid, link_id)` tuple — after which the receiver records it.
 * Authenticity alone (already done in the codec) lets a captured valid frame be
 * replayed; this class supplies the missing timestamp check.
 *
 * It is pure in-memory by default (#100, process lifetime). Given a `scopeKey`
 * and a persistence `store`, it seeds from and advances durable state (#101), so
 * a frame accepted before a restart is still rejected after one.
 */
class ReplayTracker {
  /**
   * @param {object} [opts]
   * @param {string} [opts.scopeKey]  key-identity namespace for durable state
   * @param {{load: function, save: function}} [opts.store]  durable backing
   */
  constructor(opts = {}) {
    /** "sysid:compid:linkId" -> highest accepted 48-bit timestamp. */
    this._max = new Map();
    this._scopeKey = opts.scopeKey || null;
    this._store = opts.store || null;
    if (this._store && this._scopeKey) {
      const seeded = this._store.load(this._scopeKey);
      if (seeded && typeof seeded === 'object') {
        for (const [stream, ts] of Object.entries(seeded)) {
          const n = Number(ts);
          if (Number.isFinite(n)) {
            this._max.set(stream, n);
          }
        }
      }
    }
  }

  /**
   * Apply the monotonic rule for one verified signed frame.
   *
   * @param {number} sysid
   * @param {number} compid
   * @param {number} linkId
   * @param {number} timestamp  48-bit signing timestamp
   * @returns {{accepted: boolean, reason: string}} `signature-valid` when the
   *   timestamp advances the stream; `signature-replayed` when it does not (or
   *   is unusable)
   */
  check(sysid, compid, linkId, timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return { accepted: false, reason: 'signature-replayed' };
    }
    const stream = `${sysid}:${compid}:${linkId}`;
    const last = this._max.get(stream);
    if (last !== undefined && ts <= last) {
      return { accepted: false, reason: 'signature-replayed' };
    }
    this._max.set(stream, ts);
    if (this._store && this._scopeKey) {
      this._store.save(this._scopeKey, this.snapshot());
    }
    return { accepted: true, reason: 'signature-valid' };
  }

  /**
   * Plain-object view of the per-stream state, for persistence.
   *
   * @returns {object}
   */
  snapshot() {
    return Object.fromEntries(this._max);
  }
}

module.exports = { ReplayTracker };
