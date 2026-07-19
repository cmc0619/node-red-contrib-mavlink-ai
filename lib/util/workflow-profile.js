'use strict';

const { MavlinkError } = require('./errors');
const { firstDefined } = require('./validation');

/**
 * Effective Vehicle Profile resolution for stateful workflow nodes (mission,
 * param, command await-ack). A workflow must run under one Vehicle Profile
 * end-to-end — dialect/enums, firmware behavior, target defaults, and the
 * profile reference carried on every outbound send — otherwise its sends
 * encode with the connection's default codec while its target may be routed
 * to a different profile.
 *
 * The Vehicle Profile is target-facing only (#228): the local source identity
 * a workflow transmits as resolves separately through the connection's
 * `resolveOutboundIdentity()` and can never be influenced by this resolution.
 */

/**
 * True if a resolved reference is a real profile config node (as opposed to a
 * name-only `{ name }` label or a raw string).
 *
 * @param {*} profile
 * @returns {boolean}
 */
function isProfileNode(profile) {
  return !!profile && typeof profile.getDialect === 'function' && typeof profile.isValid === 'function';
}

/**
 * Resolve the profile, defaults, and target a workflow should run under.
 *
 * With an explicit profile reference (node config or msg payload) the
 * reference must resolve, via the connection, to a real valid profile —
 * anything else throws, because silently running under the connection default
 * is the failure this resolution exists to prevent. Without one, the target
 * (from the payload or the default profile's defaults) is routed through the
 * connection's route table — the same resolution inbound packets from that
 * system get — falling back to the connection's default profile. Route tables
 * with component-specific routes can be ambiguous when the component comes
 * from a default rather than the payload; use an explicit profile there.
 *
 * @param {object} connection  connection runtime API (§12)
 * @param {object} [opts]
 * @param {string|object} [opts.profile]  explicit profile reference (id or node)
 * @param {*} [opts.targetSystem]         payload-supplied target system, if any
 * @param {*} [opts.targetComponent]      payload-supplied target component, if any
 * @returns {{profile: ?object, defaults: object, targetSystem: *, targetComponent: *}}
 * @throws {MavlinkError} PROFILE_UNRESOLVED / PROFILE_INVALID for a bad
 *   explicit reference. The unresolved code comes straight from the
 *   connection's strict `resolveProfile()`, matching the connection outbound
 *   contract; the local `PROFILE_UNRESOLVED` guard below only fires for a
 *   degenerate connection lacking `resolveProfile()`. ROUTE_REJECTED when the
 *   connection's inbound routing drops packets from the addressed target —
 *   the workflow would run to a guaranteed timeout (#196).
 */
function resolveWorkflowContext(connection, opts = {}) {
  const ref = opts.profile;
  const explicit = ref !== undefined && ref !== null && ref !== '';
  let profile;
  if (explicit) {
    profile = typeof connection.resolveProfile === 'function' ? connection.resolveProfile(ref) : ref;
    if (!isProfileNode(profile)) {
      throw new MavlinkError(
        'PROFILE_UNRESOLVED',
        `Workflow names profile '${typeof ref === 'object' ? ref.name : ref}' but no such profile config node exists.`,
        { profile: typeof ref === 'object' ? ref.name : ref }
      );
    }
    if (!profile.isValid()) {
      const err = profile.getError && profile.getError();
      throw new MavlinkError(
        'PROFILE_INVALID',
        `Workflow names profile '${profile.name || profile.id}' whose dialect failed to load${err ? `: ${err.message}` : '.'}`,
        { profile: profile.name || profile.id }
      );
    }
  } else {
    profile = connection.profile || null;
  }

  let defaults = profile && profile.getDefaults ? profile.getDefaults() : {};
  const targetSystem = firstDefined(opts.targetSystem, defaults.defaultTargetSystem, 1);
  const targetComponent = firstDefined(opts.targetComponent, defaults.defaultTargetComponent, 1);

  if (typeof connection.getRouteDecision === 'function') {
    /**
     * Route the addressed target through the connection's inbound routing.
     * Two outcomes matter here:
     *
     * REJECTED — the connection drops every inbound packet from this target
     * (routed unmatched-reject, an unresolvable route profile, or a
     * single-profile accept filter). The workflow's sends would leave, but no
     * reply could ever reach it, so it is guaranteed to time out. Fail fast
     * with ROUTE_REJECTED before anything hits the wire (#196). This applies
     * even under an explicit profile override: the override picks the encode
     * dialect, not what inbound routing drops.
     *
     * ACCEPTED — without an explicit override, the workflow adopts the
     * target's owning profile so it speaks that system's dialect, not the
     * default's. The target ids stay as addressed — only protocol behavior
     * (enums, firmware, mission preferences) follows the routed profile, and
     * the routed Vehicle Profile never changes the local outbound
     * identity (#228).
     */
    const decision = connection.getRouteDecision({ sysid: Number(targetSystem), compid: Number(targetComponent) });
    if (!decision.accepted) {
      throw new MavlinkError(
        'ROUTE_REJECTED',
        `Target ${targetSystem}/${targetComponent} is rejected by the connection's inbound routing ` +
          `(${decision.reason || 'rejected'}): replies from it are dropped before decode, so this workflow ` +
          'cannot complete. Add a route for the target, adjust the accept filters, or change the unmatched policy.',
        { targetSystem: Number(targetSystem), targetComponent: Number(targetComponent), reason: decision.reason }
      );
    }
    const routed = decision.profile;
    if (!explicit && isProfileNode(routed) && routed.isValid() && routed !== profile) {
      profile = routed;
      defaults = routed.getDefaults();
    }
  } else if (!explicit && typeof connection.getProfileForPacket === 'function') {
    /**
     * Legacy connection API (pre-#196): only the accepted profile is visible,
     * a reject collapses onto null and silently keeps the default profile.
     */
    const routed = connection.getProfileForPacket({ sysid: Number(targetSystem), compid: Number(targetComponent) });
    if (isProfileNode(routed) && routed.isValid() && routed !== profile) {
      profile = routed;
      defaults = routed.getDefaults();
    }
  }

  return { profile, defaults, targetSystem, targetComponent };
}

module.exports = { isProfileNode, resolveWorkflowContext };
