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
    if (this.mode === 'routed') {
      /**
       * An empty route table has no match, so it must honor the `unmatched`
       * policy (default 'reject'). Falling through to the single-profile
       * accept-everything filters would fail *open*, decoding every packet with
       * the default profile despite the user's reject policy (#150).
       */
      const match = this.routeTable.size > 0 ? this.routeTable.match(sysid, compid) : null;
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

    /** single-profile mode: apply accept filters. */
    if (!idAccepted(sysid, this.acceptedSysids)) {
      return { accepted: false, profile: null, reason: 'sysid-rejected' };
    }
    if (!idAccepted(compid, this.acceptedCompids)) {
      return { accepted: false, profile: null, reason: 'compid-rejected' };
    }
    return { accepted: true, profile: this.defaultProfile };
  }

  /**
   * Routing decision for a WORKFLOW's addressed target, as opposed to an
   * inbound packet (#196). For a non-zero component this is exactly
   * {@link route}. Component 0 (MAV_COMP_ID_ALL) is a component broadcast:
   * the workflow accepts replies from ANY component of the target system, so
   * the target is viable when any responder component would be accepted — a
   * component-specific route table (e.g. `1:1`) must not fail the `(1, 0)`
   * workflow just because compid 0 itself has no route. Only a target no
   * component of which could get through is rejected.
   *
   * When the compid-0 identity itself is not accepted, the fallback scan
   * prefers the most specific sysid-matching route (the table is
   * specificity-sorted) for the profile — with several component routes for
   * one system the adoption is inherently ambiguous, which is why
   * resolveWorkflowContext documents "use an explicit profile" there.
   *
   * @param {number} sysid
   * @param {number} compid  0 = component broadcast (any responder component)
   * @returns {{ accepted: boolean, profile: *, reason?: string, error?: Error }}
   */
  routeWorkflowTarget(sysid, compid) {
    const direct = this.route(sysid, compid);
    if (Number(compid) !== 0) {
      return direct;
    }
    /**
     * Only a LITERAL route match short-circuits a component broadcast. An
     * unmatched-default acceptance must not: replies from a component with
     * its own route (e.g. 1:1) are decoded under THAT route's profile, so
     * the workflow has to prefer a sysid-matching responder route over the
     * default-profile fallback (#302 review).
     */
    if (direct.accepted && direct.reason !== 'unmatched-default') {
      return direct;
    }
    if (this.mode === 'routed') {
      let unresolved = null;
      for (const route of this.routeTable.routes) {
        if (route.sysid !== '*' && route.sysid !== Number(sysid)) {
          continue;
        }
        try {
          return { accepted: true, profile: this.resolveProfile(route.profile) };
        } catch (err) {
          unresolved = err;
        }
      }
      /**
       * No resolvable responder route. An unmatched-default acceptance still
       * stands (replies from unrouted components decode under the default
       * profile); under unmatched-reject an unresolvable route is the more
       * precise failure, and no route at all leaves the direct reject.
       */
      if (direct.accepted) {
        return direct;
      }
      if (unresolved) {
        return { accepted: false, profile: null, reason: 'profile-unresolved', error: unresolved };
      }
      return direct;
    }
    /**
     * single-profile: a non-empty compid accept filter still admits the
     * listed components, so it can never make a component broadcast
     * hopeless — only the sysid filter decides.
     */
    if (!idAccepted(sysid, this.acceptedSysids)) {
      return { accepted: false, profile: null, reason: 'sysid-rejected' };
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
      } catch {
        // Unresolved route profiles are reported by the connection's route
        // validation and reject their packets at routing time; they simply
        // contribute nothing to the merged CRC table here.
      }
    }
    return out;
  }
}

module.exports = { PacketRouter };
