'use strict';

const { RouteTable } = require('./route-table');
const { idAccepted } = require('../util/validation');

/**
 * Packet router (DESIGN.md §9, §10). Decides which profile (if any) owns a
 * decoded packet, given the connection's routing mode and accept filters.
 *
 * This module is pure routing logic — it does not touch transport or decode.
 * The connection wires it up with resolved profile references.
 */
class PacketRouter {
  /**
   * @param {object} opts
   * @param {string} opts.mode            'single-profile' | 'routed'
   * @param {*}      opts.defaultProfile  resolved default profile ref
   * @param {Array}  [opts.routes]        route entries for routed mode
   * @param {number[]} [opts.acceptedSysids]   single-profile accept filter
   * @param {number[]} [opts.acceptedCompids]  single-profile accept filter
   * @param {string} [opts.unmatched]     'reject' | 'default' (routed mode)
   * @param {function} [opts.resolveProfile] (nameOrId) => profile ref
   */
  constructor(opts = {}) {
    this.mode = opts.mode || 'single-profile';
    this.defaultProfile = opts.defaultProfile || null;
    this.acceptedSysids = opts.acceptedSysids || [];
    this.acceptedCompids = opts.acceptedCompids || [];
    this.unmatched = opts.unmatched || (this.mode === 'routed' ? 'reject' : 'default');
    this.resolveProfile = opts.resolveProfile || ((p) => p);
    this.routeTable = RouteTable.parse(opts.routes);
  }

  /**
   * Route a packet header.
   *
   * A matched route whose profile reference cannot be resolved (resolveProfile
   * throws) REJECTS the packet with reason 'profile-unresolved' — it must never
   * silently fall back to the default profile, which would decode and
   * signature-check the packet with the wrong dialect while labeling it as the
   * route's profile.
   *
   * @returns {{ accepted: boolean, profile: *, reason?: string, error?: Error }}
   */
  route(sysid, compid) {
    if (this.mode === 'routed' && this.routeTable.size > 0) {
      const match = this.routeTable.match(sysid, compid);
      if (match) {
        try {
          return { accepted: true, profile: this.resolveProfile(match.profile) };
        } catch (err) {
          return { accepted: false, profile: null, reason: 'profile-unresolved', error: err };
        }
      }
      if (this.unmatched === 'default' && this.defaultProfile) {
        return { accepted: true, profile: this.defaultProfile, reason: 'unmatched-default' };
      }
      return { accepted: false, profile: null, reason: 'unmatched-reject' };
    }

    // single-profile mode (or routed with no routes): apply accept filters.
    if (!idAccepted(sysid, this.acceptedSysids)) {
      return { accepted: false, profile: null, reason: 'sysid-rejected' };
    }
    if (!idAccepted(compid, this.acceptedCompids)) {
      return { accepted: false, profile: null, reason: 'compid-rejected' };
    }
    return { accepted: true, profile: this.defaultProfile };
  }

  /**
   * All distinct resolved profiles this router can hand out: the default plus
   * every route-table target. The connection uses this to build a packet
   * splitter CRC table covering every routed dialect, so packets for a custom
   * dialect's message ids are not silently dropped before routing.
   *
   * @returns {Array<*>} resolved profile refs (deduplicated)
   */
  profiles() {
    const out = [];
    const seen = new Set();
    const add = (p) => {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    };
    add(this.defaultProfile);
    for (const route of this.routeTable.routes) {
      try {
        add(this.resolveProfile(route.profile));
      } catch (err) {
        // Unresolved route profiles are reported by the connection's route
        // validation and reject their packets at routing time; they simply
        // contribute nothing to the merged CRC table here.
      }
    }
    return out;
  }
}

module.exports = { PacketRouter };
