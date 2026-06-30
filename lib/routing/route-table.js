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

function normalizeId(value) {
  if (isWildcard(value)) {
    return '*';
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : '*';
}

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
        sysid: normalizeId(r.sysid),
        compid: normalizeId(r.compid),
        profile: r.profile,
        index
      }))
      // Sort by specificity desc, then original order to keep ties deterministic.
      .sort((a, b) => specificity(b) - specificity(a) || a.index - b.index);
  }

  get size() {
    return this.routes.length;
  }

  /**
   * Return the matching route for a packet, or null.
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
   * Parse a route table from config. Accepts a JSON string or an array.
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
        arr = [];
      }
    }
    if (!Array.isArray(arr)) {
      arr = [];
    }
    return new RouteTable(arr);
  }
}

module.exports = { RouteTable };
