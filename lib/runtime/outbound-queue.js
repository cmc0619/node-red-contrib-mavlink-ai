'use strict';

const { MavlinkError } = require('../util/errors');

/**
 * The highest (most urgent) priority band, reserved for emergency/mode/arm sends
 * (DESIGN.md §21). No amount of aging may promote a lower-priority item into this
 * band: an emergency command must cut through a backlog, not queue behind stale
 * normal/background traffic that has merely waited a long time.
 *
 * @type {number}
 */
const EMERGENCY_PRIORITY = 0;

/**
 * The floor a non-emergency item's effective priority may reach through aging —
 * one band above {@link EMERGENCY_PRIORITY}. Aging bounds a low-priority item's
 * worst-case wait but must never let it reach or tie the emergency band (ties
 * break by age, so a same-band clamp would still let an older aged item outrank
 * a fresh emergency; flooring strictly above 0 prevents that).
 *
 * @type {number}
 */
const NON_EMERGENCY_FLOOR = EMERGENCY_PRIORITY + 1;

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
 *     item forever. Promotion is clamped at {@link NON_EMERGENCY_FLOOR} so an
 *     aged non-emergency send can never outrank the emergency band.
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
    /**
     * Any positive number is accepted, including `Infinity` — which makes every
     * `waited / agePromotionMs` ratio zero, so effective priority equals base
     * priority and aging is disabled (strict priority). NaN and non-positive
     * values fall back to the 2000 ms default; `Number.isFinite` is deliberately
     * not used here so the documented `Infinity` opt-out actually takes effect.
     */
    this.agePromotionMs =
      typeof opts.agePromotionMs === 'number' && opts.agePromotionMs > 0 ? opts.agePromotionMs : 2000;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._queue = [];
    this._draining = false;
    /** The item shift()ed out of _queue whose write is awaiting completion, so
     * clear() can settle it too (#237); null between writes. */
    this._inFlight = null;
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
   * @param {function} [opts.onWrite]  invoked exactly once, only when this
   *   buffer is actually written to the transport — never when the item is
   *   dropped by coalescing (its promise still resolves) or rejected
   *   (QUEUE_FULL, teardown, writer failure). Lets a caller trace real sends
   *   without counting superseded or never-sent frames.
   * @returns {Promise<void>}
   */
  enqueue(buffer, priority = 2, meta = undefined, opts = undefined) {
    const onWrite = opts && typeof opts.onWrite === 'function' ? opts.onWrite : undefined;
    if (!this.enabled) {
      /**
       * Preserve the promise contract even when bypassing the queue: a writer
       * that throws synchronously must surface as a rejection, not a sync
       * throw, so callers' .catch() handling works identically in both modes.
       * A pass-through write is a real write, so onWrite fires once it settles.
       */
      try {
        const written = Promise.resolve(this._writer(buffer, meta));
        return onWrite
          ? written.then((result) => {
              onWrite();
              return result;
            })
          : written;
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const coalesceKey = opts && opts.coalesceKey != null ? opts.coalesceKey : undefined;
    /**
     * Coalesce before the fullness check so a periodic re-send reclaims its
     * predecessor's slot rather than being rejected when the queue is full. The
     * replacement inherits the oldest superseded item's enqueue time: otherwise
     * every 1 Hz heartbeat tick would reset its own age to zero and age
     * promotion could never fire under a sustained flood — coalescing would
     * silently defeat the anti-starvation guarantee.
     */
    let inheritedAt;
    if (coalesceKey !== undefined) {
      inheritedAt = this._dropSuperseded(coalesceKey);
    }
    if (this._queue.length >= this.maxLength) {
      return Promise.reject(
        new MavlinkError('QUEUE_FULL', `Outbound queue is full (${this.maxLength}); transport may be stalled.`)
      );
    }
    return new Promise((resolve, reject) => {
      this._queue.push({
        buffer,
        priority,
        meta,
        coalesceKey,
        enqueuedAt: inheritedAt !== undefined ? inheritedAt : this._now(),
        onWrite,
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
   * Promotion is clamped so an emergency (band {@link EMERGENCY_PRIORITY}) send
   * can never be outranked by an aged lower-priority one: an item already in the
   * emergency band stays there, and any non-emergency item floors at
   * {@link NON_EMERGENCY_FLOOR} (one band above emergency) no matter how long it
   * has waited. Without the clamp an unbounded backlog could drive a stale
   * priority-2/3 send below 0 and send it ahead of a later arm/mode/emergency
   * command — the opposite of what a backlog needs (#150 review).
   *
   * @param {object} item
   * @param {number} now
   * @returns {number}
   */
  _effectivePriority(item, now) {
    const waited = now - item.enqueuedAt;
    const promotions = waited > 0 ? Math.floor(waited / this.agePromotionMs) : 0;
    const promoted = item.priority - promotions;
    const floor = item.priority <= EMERGENCY_PRIORITY ? EMERGENCY_PRIORITY : NON_EMERGENCY_FLOOR;
    return promoted < floor ? floor : promoted;
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
        /**
         * Track the shifted item so clear() can settle it too (#237): once it
         * leaves _queue it is invisible to the splice, and a writer stalled on
         * it would leave the owning flow message's done() uncalled across a
         * redeploy. Promise settle-once semantics make the eventual writer
         * completion harmless — a resolve/reject after clear()'s rejection is
         * a no-op.
         */
        this._inFlight = item;
        try {
          await this._writer(item.buffer, item.meta);
          /**
           * onWrite fires only here — after the buffer actually reached the
           * transport. A coalesced item is resolved in _dropSuperseded without
           * ever being written, so it never calls onWrite (a debug trace must
           * not count a superseded heartbeat as a send).
           */
          if (item.onWrite) {
            item.onWrite();
          }
          item.resolve();
        } catch (err) {
          item.reject(err);
        } finally {
          this._inFlight = null;
        }
      }
    } finally {
      this._draining = false;
    }
  }

  /**
   * Drop all queued buffers — and settle the item currently in flight — by
   * rejecting their pending promises.
   *
   * @returns {void}
   */
  clear() {
    const pending = this._queue.splice(0);
    /**
     * The in-flight item was shift()ed out of _queue before its write started
     * (#237): reject it here so its caller is released on teardown even if the
     * writer never settles. The drain loop's own settle after the write
     * completes is a no-op on the already-rejected promise, and the loop still
     * owns clearing _inFlight.
     */
    if (this._inFlight) {
      this._inFlight.reject(new MavlinkError('QUEUE_CLEARED', 'Outbound queue cleared'));
    }
    for (const item of pending) {
      /**
       * A stable code lets callers distinguish the routine teardown/deactivate
       * rejection from a real send failure — the connection's heartbeat catch
       * must not log (or re-emit on a torn-down emitter) for an expected clear.
       */
      item.reject(new MavlinkError('QUEUE_CLEARED', 'Outbound queue cleared'));
    }
  }
}

module.exports = { OutboundQueue };
