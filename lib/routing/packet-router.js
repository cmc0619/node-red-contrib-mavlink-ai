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
   * the workflow accepts replies from ANY real component of the target
   * system, so the target is viable when some NONZERO responder component
   * would be accepted — a component-specific route table (e.g. `1:1`) must
   * not fail the `(1, 0)` workflow just because compid 0 itself has no
   * route, and conversely a route/filter admitting only compid 0 accepts no
   * actual responder. Only a target no real component of which could get
   * through is rejected.
   *
   * @param {number} sysid
   * @param {number} compid  0 = component broadcast (any responder component)
   * @returns {{ accepted: boolean, profile: *, reason?: string, error?: Error }}
   */
  routeWorkflowTarget(sysid, compid) {
    if (Number(compid) !== 0) {
      return this.route(sysid, compid);
    }
    /**
     * Component broadcast: the replies come from REAL (nonzero) component
     * ids, never from compid 0 itself, so the literal (sysid, 0) probe is
     * irrelevant — a route matching only compid 0 accepts no actual
     * responder (#302 review round 3). Viability is computed from responder
     * semantics alone: some nonzero component of the system must be
     * accepted. The route scan prefers the most specific sysid-matching
     * responder route (the table is specificity-sorted) for the profile,
     * because replies from a routed component decode under THAT route's
     * profile, not the unmatched-default fallback — with several component
     * routes for one system the adoption is inherently ambiguous, which is
     * why resolveWorkflowContext documents "use an explicit profile" there.
     */
    if (this.mode === 'routed') {
      let unresolved = null;
      for (const route of this.routeTable.routes) {
        if (route.sysid !== '*' && route.sysid !== Number(sysid)) {
          continue;
        }
        /** A compid-0-exact route matches no real responder — skip it. */
        if (route.compid !== '*' && Number(route.compid) === 0) {
          continue;
        }
        try {
          return { accepted: true, profile: this.resolveProfile(route.profile) };
        } catch (err) {
          /**
           * Inbound route() rejects a packet on its FIRST matching route, so
           * an unresolvable compid-wildcard route is the first match for
           * every remaining real responder component — nothing gets through,
           * even under unmatchedPolicy 'default' (#302 review round 4). An
           * unresolvable compid-exact route only shadows its own component;
           * keep scanning for the rest.
           */
          if (route.compid === '*') {
            return { accepted: false, profile: null, reason: 'profile-unresolved', error: err };
          }
          unresolved = err;
        }
      }
      /** Unrouted responder components decode under the default profile. */
      if (this.unmatched === 'default' && this.defaultProfile) {
        return { accepted: true, profile: this.defaultProfile, reason: 'unmatched-default' };
      }
      if (unresolved) {
        return { accepted: false, profile: null, reason: 'profile-unresolved', error: unresolved };
      }
      return { accepted: false, profile: null, reason: 'unmatched-reject' };
    }
    /**
     * single-profile: the sysid filter decides first; the compid filter only
     * rejects when it admits no nonzero responder component (a bare [0]).
     */
    if (!idAccepted(sysid, this.acceptedSysids)) {
      return { accepted: false, profile: null, reason: 'sysid-rejected' };
    }
    const admitsRealComponent =
      this.acceptedCompids.length === 0 || this.acceptedCompids.some((c) => Number(c) !== 0);
    if (!admitsRealComponent) {
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
