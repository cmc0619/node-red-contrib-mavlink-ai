'use strict';

const { idAccepted } = require('../util/validation');

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
 *   profile       string     match resolved profile name
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
      lastDeliveredAt: 0,
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
    for (const sub of this._subs.values()) {
      if (!matches(sub.filter, payload)) {
        continue;
      }
      if (sub.filter.rateLimitHz > 0) {
        const minIntervalMs = 1000 / sub.filter.rateLimitHz;
        if (now - sub.lastDeliveredAt < minIntervalMs) {
          continue;
        }
      }
      if (sub.filter.changedOnly) {
        const key = `${payload.name}:${payload.sysid}:${payload.compid}`;
        const sig = JSON.stringify(payload.fields);
        if (sub.lastSignature.get(key) === sig) {
          continue;
        }
        sub.lastSignature.set(key, sig);
      }
      sub.lastDeliveredAt = now;
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
    sysids: filter.sysid === undefined || filter.sysid === '*' || filter.sysid == null ? [] : [Number(filter.sysid)],
    compids:
      filter.compid === undefined || filter.compid === '*' || filter.compid == null ? [] : [Number(filter.compid)],
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
  if (filter.profile && payload.profile !== filter.profile) {
    return false;
  }
  return true;
}

module.exports = { SubscriptionRegistry, normalizeFilter, matches };
