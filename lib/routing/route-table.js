'use strict';

const { isWildcard } = require('../util/validation');

/**
 * Route table (DESIGN.md §10). Maps MAVLink sysid/compid identity to a profile
 * reference. Matching is deterministic: the most specific route wins.
 *
 * Specificity order (highest first):
 *   1. sysid exact + compid exact
 *   2. sysid exact + compid wildcard
 *   3. sysid wildcard + compid exact
 *   4. sysid wildcard + compid wildcard (fallback)
 */

/**
 * Normalize a route id to a number or the wildcard sentinel `'*'`.
 *
 * Only the explicit wildcard spellings (blank, `*`, `any`, `all`) become a
 * wildcard. A non-empty malformed value (a typo like `"1O"`, an out-of-range
 * id) throws instead of silently collapsing to `'*'` (#71): a routing typo that
 * quietly widens a route to *every* system/component is far worse than a loud
 * config error — in routed mode it sends packets for unrelated vehicles to the
 * wrong profile/dialect.
 *
 * @param {*} value
 * @param {number} index  route index, for the error context
 * @param {string} field  'sysid' or 'compid', for the error context
 * @returns {number|'*'}
 * @throws {Error} on a non-empty non-numeric or out-of-range id
 */
function normalizeId(value, index, field) {
  if (isWildcard(value)) {
    return '*';
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(
      `Invalid route ${field} at index ${index}: '${value}' is neither a MAVLink id nor a wildcard (*, any, all).`
    );
  }
  // MAVLink sysid/compid are uint8 identity fields.
  if (n < 0 || n > 255) {
    throw new Error(`Invalid route ${field} at index ${index}: ${n} is out of the MAVLink 0..255 id range.`);
  }
  return n;
}

/**
 * Score a route's specificity: sysid-exact is weighted above compid-exact so
 * the most specific match wins deterministically.
 *
 * @param {{sysid: (number|'*'), compid: (number|'*')}} route
 * @returns {number} 0 (full wildcard) .. 3 (both exact)
 */
function specificity(route) {
  const sysExact = route.sysid !== '*';
  const compExact = route.compid !== '*';
  return (sysExact ? 2 : 0) + (compExact ? 1 : 0);
}

class RouteTable {
  /**
   * @param {Array} routes  array of { sysid, compid, profile } objects.
   *   `profile` is a profile name/id reference resolved by the connection.
   */
  constructor(routes) {
    this.routes = (routes || [])
      .map((r, index) => ({
        sysid: normalizeId(r.sysid, index, 'sysid'),
        compid: normalizeId(r.compid, index, 'compid'),
        profile: r.profile,
        index
      }))
      // Sort by specificity desc, then original order to keep ties deterministic.
      .sort((a, b) => specificity(b) - specificity(a) || a.index - b.index);
  }

  /**
   * Number of configured routes.
   *
   * @returns {number}
   */
  get size() {
    return this.routes.length;
  }

  /**
   * Return the most specific matching route for a packet identity, or null.
   *
   * @param {number} sysid
   * @param {number} compid
   * @returns {?object} the matched route ({ sysid, compid, profile, index })
   */
  match(sysid, compid) {
    for (const route of this.routes) {
      const sysOk = route.sysid === '*' || route.sysid === Number(sysid);
      const compOk = route.compid === '*' || route.compid === Number(compid);
      if (sysOk && compOk) {
        return route;
      }
    }
    return null;
  }

  /**
   * Parse a route table from config. Accepts a JSON string or an array. Empty
   * input yields an empty table, but malformed JSON or a non-array value throws
   * so a routing typo is visible rather than silently disabling all routing.
   *
   * @param {string|Array} value
   * @returns {RouteTable}
   * @throws {Error} on invalid JSON or non-array config
   */
  static parse(value) {
    if (!value) {
      return new RouteTable([]);
    }
    let arr = value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') {
        return new RouteTable([]);
      }
      try {
        arr = JSON.parse(trimmed);
      } catch (e) {
        throw new Error(`Invalid route table JSON: ${e.message}`);
      }
    }
    if (!Array.isArray(arr)) {
      throw new Error('Route table must be an array of { sysid, compid, profile } entries.');
    }
    return new RouteTable(arr);
  }
}

module.exports = { RouteTable };
