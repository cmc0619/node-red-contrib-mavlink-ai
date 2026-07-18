'use strict';

const { idAccepted } = require('../util/validation');
const { fieldsSignature } = require('../util/fields-signature');
const { MavlinkError } = require('../util/errors');

/**
 * Cap on the per-subscription rate-limit/changed-only tracking maps. Keys are
 * `connection:name:sysid:compid`, and sysid/compid arrive from the wire — unsigned but
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
 *   sysids        number[]   match source systems (empty/absent = all)
 *   compids       number[]   match source components (empty/absent = all)
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
      /** key: connection+name+sysid+compid -> timestamp */
      lastDeliveredAt: new Map(),
      /** key: connection+name+sysid+compid -> fields signature */
      lastSignature: new Map()
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
    /**
     * Rate limiting and changed-only are keyed per (connection, name, sysid,
     * compid), like the filter node: a subscription matching several message
     * types must not let the fastest stream (e.g. ATTITUDE) consume the
     * delivery window and starve the slower ones (e.g. HEARTBEAT), and two
     * links carrying the same wire identity must not suppress each other
     * (#240). A registry serves one connection today, so the connection_id
     * segment is constant here — it exists so the keying stays correct if a
     * registry ever dispatches for more than one link.
     */
    const key = `${payload.connection_id || ''}:${payload.name}:${payload.sysid}:${payload.compid}`;
    /**
     * The changed-only signature is a JSON serialization of the decoded
     * fields — O(payload size) — and the payload is identical for every
     * subscriber in this dispatch. Compute it at most once, and only when a
     * matching changed-only subscriber actually needs it, instead of once per
     * changed-only subscriber (a computed flag rather than an undefined
     * check, so a signature that legitimately serializes to undefined —
     * fields absent — is still only computed once).
     */
    let changedSignature;
    let changedSignatureComputed = false;
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
        if (!changedSignatureComputed) {
          changedSignature = fieldsSignature(payload.fields);
          changedSignatureComputed = true;
        }
        if (sub.lastSignature.get(key) === changedSignature) {
          continue;
        }
        boundedSet(sub.lastSignature, key, changedSignature);
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
 * Validate an id filter into a numeric array, failing CLOSED on bad input.
 * Absent/`'*'` means "accept all" (empty array), and an explicitly empty array
 * keeps that documented wildcard meaning — but any *supplied* entry must be an
 * integer MAVLink id (0-255). The old normalizer silently dropped invalid
 * entries, so a malformed list like `['bad']` collapsed to the empty array and
 * became a wildcard — a filter meant to narrow delivery accepting everything
 * instead, the exact fail-open #193 removed from the id-list parser. Editor
 * paths already validate via parseIdListStrict; this closes the programmatic
 * subscribe() path.
 *
 * @param {*} value   the filter's sysids/compids value
 * @param {string} field  field name for the error
 * @returns {number[]}
 * @throws {MavlinkError} BAD_FILTER on a non-array or invalid entry
 */
function strictIdArray(value, field) {
  if (value === undefined || value === null || value === '*') {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MavlinkError(
      'BAD_FILTER',
      `Subscription filter ${field} must be an array of MAVLink ids (got ${JSON.stringify(value)}).`,
      { field, value }
    );
  }
  return value.map((entry) => {
    /**
     * Only a number or a non-empty numeric string may reach Number(): bare
     * coercion quietly maps true/[1] to 1 and ''/null to 0 — a malformed
     * entry registering a REAL filter on sysid/compid 1 or 0 instead of
     * failing closed (#288 review).
     */
    const coercible =
      typeof entry === 'number' || (typeof entry === 'string' && entry.trim() !== '');
    const n = coercible ? Number(entry) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new MavlinkError(
        'BAD_FILTER',
        `Subscription filter ${field} entry ${JSON.stringify(entry)} is not an integer MAVLink id (0-255).`,
        { field, entry }
      );
    }
    return n;
  });
}

/**
 * Coerce a raw filter object into the normalized internal shape (uppercased
 * names, numeric id arrays, wildcards collapsed to "accept all"). Malformed
 * id lists throw rather than widen (see {@link strictIdArray}), and the
 * removed singular sysid/compid spellings are rejected loudly — ignoring them
 * would silently turn an existing narrow filter into a wildcard, the same
 * fail-open this normalizer exists to prevent.
 *
 * @param {object} [filter]
 * @returns {object} normalized filter
 * @throws {MavlinkError} BAD_FILTER
 */
function normalizeFilter(filter = {}) {
  if (filter.sysid !== undefined || filter.compid !== undefined) {
    throw new MavlinkError(
      'BAD_FILTER',
      'Subscription filters take plural sysids/compids arrays; the singular sysid/compid fields are not accepted.',
      { sysid: filter.sysid, compid: filter.compid }
    );
  }
  return {
    messageNames: (filter.messageNames || []).map((n) => String(n).toUpperCase()),
    messageIds: (filter.messageIds || []).map((n) => Number(n)),
    sysids: strictIdArray(filter.sysids, 'sysids'),
    compids: strictIdArray(filter.compids, 'compids'),
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

module.exports = { SubscriptionRegistry, matches };
