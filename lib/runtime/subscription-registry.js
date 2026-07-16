'use strict';

const { idAccepted } = require('../util/validation');
const { fieldsSignature } = require('../util/fields-signature');

/**
 * Cap on the per-subscription rate-limit/changed-only tracking maps. Keys are
 * `name:sysid:compid`, and sysid/compid arrive from the wire — unsigned but
 * CRC-valid frames are trivial to forge, so without a bound a sender sweeping
 * the 65 536 sysid×compid space (times message names) grows these maps without
 * limit. Oldest-inserted entries are evicted first; evicting a hot key merely
 * lets one extra delivery through (rate limit) or re-delivers one unchanged
 * message (changed-only), so the bound is safe.
 *
 * @type {number}
 */
const MAX_TRACKED_KEYS = 4096;

/**
 * Insert into a bounded Map, evicting the oldest-inserted entry when full.
 *
 * @param {Map<string, *>} map
 * @param {string} key
 * @param {*} value
 * @returns {void}
 */
function boundedSet(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRACKED_KEYS) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

/**
 * Subscription registry (DESIGN.md §20). The connection decodes each packet
 * once, then distributes normalized messages to matching subscribers. This
 * avoids every node running its own decoder and lets high-rate telemetry be
 * rate-limited per subscriber instead of flooding the whole runtime.
 *
 * A subscription filter supports:
 *   messageNames  string[]   match by MSG_NAME
 *   messageIds    number[]   match by msgid
 *   sysid         number|*   match source system
 *   compid        number|*   match source component
 *   profile       string     match resolved profile name or config-node id
 *   rateLimitHz   number     max deliveries/sec for this subscription
 *   changedOnly   boolean    only deliver when fields change vs last delivered
 */
class SubscriptionRegistry {
  constructor() {
    this._subs = new Map();
    this._nextId = 1;
    this._onError = null;
  }

  /**
   * Register a handler invoked when a subscriber callback throws. Subscriber
   * errors are still isolated (delivery to other subscribers continues); this
   * just adds observability instead of swallowing them silently.
   *
   * @param {function(Error, object): void} handler  receives (error, subscription)
   * @returns {void}
   */
  setErrorHandler(handler) {
    this._onError = typeof handler === 'function' ? handler : null;
  }

  /**
   * Number of active subscriptions.
   *
   * @returns {number}
   */
  get size() {
    return this._subs.size;
  }

  /**
   * Register a subscriber with a filter (see class doc for filter shape).
   *
   * @param {object} filter  message/identity/profile filter + rate/changed opts
   * @param {function(object): void} callback  invoked with each matching message
   * @returns {number} subscription id, for later {@link unsubscribe}
   */
  subscribe(filter, callback) {
    const id = this._nextId++;
    this._subs.set(id, {
      id,
      filter: normalizeFilter(filter),
      callback,
      lastDeliveredAt: new Map(), // key: name+sysid+compid -> timestamp
      lastSignature: new Map() // key: name+sysid+compid -> JSON of fields
    });
    return id;
  }

  /**
   * Remove a subscription by id.
   *
   * @param {number} id  id returned by {@link subscribe}
   * @returns {boolean} true if a subscription was removed
   */
  unsubscribe(id) {
    return this._subs.delete(id);
  }

  /**
   * Drop all subscriptions (used on connection teardown).
   *
   * @returns {void}
   */
  clear() {
    this._subs.clear();
  }

  /**
   * Distribute a decoded message (the §14.1 envelope) to all matching subs.
   * @param {object} message  { topic, payload }
   */
  dispatch(message) {
    const payload = message.payload;
    const now = Date.now();
    // Rate limiting and changed-only are keyed per (name, sysid, compid), like
    // the filter node: a subscription matching several message types must not
    // let the fastest stream (e.g. ATTITUDE) consume the delivery window and
    // starve the slower ones (e.g. HEARTBEAT).
    const key = `${payload.name}:${payload.sysid}:${payload.compid}`;
    for (const sub of this._subs.values()) {
      if (!matches(sub.filter, payload)) {
        continue;
      }
      if (sub.filter.rateLimitHz > 0) {
        const minIntervalMs = 1000 / sub.filter.rateLimitHz;
        if (now - (sub.lastDeliveredAt.get(key) || 0) < minIntervalMs) {
          continue;
        }
      }
      if (sub.filter.changedOnly) {
        const sig = fieldsSignature(payload.fields);
        if (sub.lastSignature.get(key) === sig) {
          continue;
        }
        boundedSet(sub.lastSignature, key, sig);
      }
      /**
       * Only track delivery times when a rate limit actually reads them:
       * unconditional tracking made every subscription accumulate one entry
       * per (name, sysid, compid) seen for the connection's lifetime.
       */
      if (sub.filter.rateLimitHz > 0) {
        boundedSet(sub.lastDeliveredAt, key, now);
      }
      try {
        sub.callback(message);
      } catch (e) {
        // A subscriber throwing must not break distribution to others, but
        // surface it through the optional error handler for observability.
        if (this._onError) {
          try {
            this._onError(e, sub);
          } catch (_ignored) {
            /* an error handler that itself throws must not break dispatch */
          }
        }
      }
    }
  }
}

/**
 * Normalize an id filter into a numeric array. Prefers a plural `ids` array
 * (the id-list form the in/filter nodes now pass), falling back to a single
 * `id` value for back-compat; a wildcard/blank/absent value means "accept all"
 * (empty array). Non-finite entries are dropped.
 *
 * @param {*} ids     array form (may be undefined)
 * @param {*} id      single form (may be undefined)
 * @returns {number[]}
 */
function toIdArray(ids, id) {
  if (Array.isArray(ids)) {
    return ids.map(Number).filter((n) => Number.isFinite(n));
  }
  return id === undefined || id === '*' || id == null ? [] : [Number(id)];
}

/**
 * Coerce a raw filter object into the normalized internal shape (uppercased
 * names, numeric id arrays, wildcards collapsed to "accept all").
 *
 * @param {object} [filter]
 * @returns {object} normalized filter
 */
function normalizeFilter(filter = {}) {
  return {
    messageNames: (filter.messageNames || []).map((n) => String(n).toUpperCase()),
    messageIds: (filter.messageIds || []).map((n) => Number(n)),
    sysids: toIdArray(filter.sysids, filter.sysid),
    compids: toIdArray(filter.compids, filter.compid),
    profile: filter.profile || null,
    rateLimitHz: Number(filter.rateLimitHz || 0),
    changedOnly: Boolean(filter.changedOnly)
  };
}

/**
 * Test whether a decoded payload satisfies a normalized filter.
 *
 * @param {object} filter   normalized filter from {@link normalizeFilter}
 * @param {object} payload  decoded §14.1 payload
 * @returns {boolean}
 */
function matches(filter, payload) {
  if (filter.messageNames.length && !filter.messageNames.includes(String(payload.name).toUpperCase())) {
    return false;
  }
  if (filter.messageIds.length && !filter.messageIds.includes(Number(payload.id))) {
    return false;
  }
  if (!idAccepted(payload.sysid, filter.sysids)) {
    return false;
  }
  if (!idAccepted(payload.compid, filter.compids)) {
    return false;
  }
  // The profile filter matches the display name or the config-node id, so
  // subscribers can key on the canonical id or the human-readable name.
  if (filter.profile && payload.profile !== filter.profile && payload.profile_id !== filter.profile) {
    return false;
  }
  return true;
}

module.exports = { SubscriptionRegistry, normalizeFilter, matches };
