'use strict';

/**
 * Outbound queue (DESIGN.md §21). The connection owns outbound serialization so
 * multiple flow tabs don't independently scribble onto the same socket.
 *
 * Starts as a simple FIFO. Priority is supported (lower number = higher
 * priority) but defaults to a single band so it behaves as plain FIFO until a
 * caller opts into priorities.
 *
 * Two fairness mechanisms guard the background band (priority 3, heartbeat) so
 * "normal" traffic can't silently trip a vehicle's GCS-loss failsafe (#150):
 *
 *   - Age promotion: an item's *effective* priority improves by one band for
 *     every `agePromotionMs` it has waited, so a sustained flood of
 *     higher-priority traffic at/above the drain rate can't park a low-priority
 *     item forever.
 *   - Drop-superseded coalescing: enqueuing an item with a `coalesceKey` drops
 *     any still-queued (not in-flight) item with the same key, so a periodic
 *     producer (the 1 Hz heartbeat) can't accumulate stale copies behind a
 *     stalled/flooded transport.
 */
class OutboundQueue {
  /**
   * @param {function(Buffer): Promise} writer  async function that writes bytes
   * @param {object} [opts]
   * @param {boolean} [opts.enabled] when false, writes pass straight through
   * @param {number} [opts.maxLength=1000] reject new enqueues past this depth so
   *   a stalled transport can't grow the queue (and pending promises) unbounded
   * @param {number} [opts.agePromotionMs=2000] a queued item is promoted one
   *   priority band for every this-many ms it has waited. Bounds the worst-case
   *   wait of a low-priority item under sustained higher-priority load. Set to
   *   Infinity to disable aging (strict priority).
   * @param {function(): number} [opts.now] clock source (defaults to Date.now);
   *   injectable so aging is deterministically testable.
   */
  constructor(writer, opts = {}) {
    this._writer = writer;
    this.enabled = opts.enabled !== false;
    this.maxLength = Number.isFinite(opts.maxLength) && opts.maxLength > 0 ? opts.maxLength : 1000;
    this.agePromotionMs =
      Number.isFinite(opts.agePromotionMs) && opts.agePromotionMs > 0 ? opts.agePromotionMs : 2000;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._queue = [];
    this._draining = false;
  }

  /**
   * Number of buffers currently waiting to be written.
   *
   * @returns {number}
   */
  get length() {
    return this._queue.length;
  }

  /**
   * Enqueue a buffer for sending. Resolves once it has been written (or once a
   * newer item supersedes it, see `coalesceKey`).
   * @param {Buffer} buffer
   * @param {number} [priority] 0 (highest) .. 3 (background)
   * @param {object} [meta]  passed through to the writer (e.g. { targetSystem }
   *   so a udp-peer transport can route to the addressed vehicle's endpoint)
   * @param {object} [opts]
   * @param {*} [opts.coalesceKey]  when set, any still-queued item carrying the
   *   same key is dropped (its promise resolves — the newer send carries the
   *   same intent) before this one is enqueued. Used to keep the periodic
   *   heartbeat from piling up behind a slow transport.
   * @returns {Promise<void>}
   */
  enqueue(buffer, priority = 2, meta = undefined, opts = undefined) {
    if (!this.enabled) {
      return this._writer(buffer, meta);
    }
    const coalesceKey = opts && opts.coalesceKey != null ? opts.coalesceKey : undefined;
    // Coalesce before the fullness check so a periodic re-send reclaims its
    // predecessor's slot rather than being rejected when the queue is full.
    // The replacement *inherits* the oldest superseded item's enqueue time:
    // otherwise every 1 Hz heartbeat tick would reset its own age to zero and
    // age promotion could never fire under a sustained flood — coalescing would
    // silently defeat the anti-starvation guarantee.
    let inheritedAt;
    if (coalesceKey !== undefined) {
      inheritedAt = this._dropSuperseded(coalesceKey);
    }
    if (this._queue.length >= this.maxLength) {
      return Promise.reject(
        new Error(`Outbound queue is full (${this.maxLength}); transport may be stalled.`)
      );
    }
    return new Promise((resolve, reject) => {
      this._queue.push({
        buffer,
        priority,
        meta,
        coalesceKey,
        enqueuedAt: inheritedAt !== undefined ? inheritedAt : this._now(),
        resolve,
        reject
      });
      this._sort();
      this._drain();
    });
  }

  /**
   * Drop any still-queued item sharing this coalesce key, resolving its pending
   * promise (the newer item supersedes it, so callers see success not an error).
   * Only touches queued items; an in-flight write has already been shifted out.
   *
   * @param {*} coalesceKey
   * @returns {number|undefined} the oldest dropped item's enqueue time, so the
   *   replacement can inherit its accumulated wait (see enqueue), or undefined
   *   if nothing was superseded.
   */
  _dropSuperseded(coalesceKey) {
    let inheritedAt;
    for (let i = this._queue.length - 1; i >= 0; i -= 1) {
      if (this._queue[i].coalesceKey === coalesceKey) {
        const [dropped] = this._queue.splice(i, 1);
        if (inheritedAt === undefined || dropped.enqueuedAt < inheritedAt) {
          inheritedAt = dropped.enqueuedAt;
        }
        dropped.resolve();
      }
    }
    return inheritedAt;
  }

  /**
   * The priority actually used for ordering: base priority improved by one band
   * per `agePromotionMs` waited. Lower is more urgent.
   *
   * @param {object} item
   * @param {number} now
   * @returns {number}
   */
  _effectivePriority(item, now) {
    const waited = now - item.enqueuedAt;
    const promotions = waited > 0 ? Math.floor(waited / this.agePromotionMs) : 0;
    return item.priority - promotions;
  }

  /**
   * Order the queue by effective (age-adjusted) priority, breaking ties in favor
   * of the older item (smaller enqueuedAt). The age tie-break is what actually
   * defeats starvation: once a parked low-priority item ages up to the band of a
   * never-ending stream of fresh higher-priority arrivals, it is older than all
   * of them and drains ahead — a plain stable sort would instead keep it pinned
   * behind them. It also preserves FIFO within a band (same-age items keep
   * insertion order via the stable sort).
   *
   * @returns {void}
   */
  _sort() {
    const now = this._now();
    this._queue.sort((a, b) => {
      const byPriority = this._effectivePriority(a, now) - this._effectivePriority(b, now);
      return byPriority !== 0 ? byPriority : a.enqueuedAt - b.enqueuedAt;
    });
  }

  /**
   * Drain the queue, writing buffers one at a time in priority order. Re-entrant
   * calls are ignored so only one drain loop runs at a time. The queue is
   * re-sorted before each write so aging is honored even across slow writes with
   * no new enqueues to trigger a sort.
   *
   * @returns {Promise<void>}
   */
  async _drain() {
    if (this._draining) {
      return;
    }
    this._draining = true;
    try {
      while (this._queue.length) {
        this._sort();
        const item = this._queue.shift();
        try {
          await this._writer(item.buffer, item.meta);
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this._draining = false;
    }
  }

  /**
   * Drop all queued buffers, rejecting their pending promises.
   *
   * @returns {void}
   */
  clear() {
    const pending = this._queue.splice(0);
    for (const item of pending) {
      item.reject(new Error('Outbound queue cleared'));
    }
  }
}

module.exports = { OutboundQueue };
