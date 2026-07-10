'use strict';

const { MavlinkError } = require('./errors');
const { firstDefined } = require('./validation');

/**
 * Effective-profile resolution for stateful workflow nodes (mission, param,
 * command await-ack). A workflow must run under one profile end-to-end —
 * dialect/enums, source identity, firmware behavior, target defaults, and the
 * profile reference carried on every outbound send — otherwise its sends
 * encode with the connection's default codec while its target may be routed
 * to a different profile.
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
 * @param {string|object} [opts.profile]  explicit profile reference (id, name, or node)
 * @param {*} [opts.targetSystem]         payload-supplied target system, if any
 * @param {*} [opts.targetComponent]      payload-supplied target component, if any
 * @returns {{profile: ?object, defaults: object, targetSystem: *, targetComponent: *}}
 * @throws {MavlinkError} UNKNOWN_PROFILE / PROFILE_INVALID for a bad explicit reference
 */
function resolveWorkflowContext(connection, opts = {}) {
  const ref = opts.profile;
  const explicit = ref !== undefined && ref !== null && ref !== '';
  let profile;
  if (explicit) {
    profile = typeof connection.resolveProfile === 'function' ? connection.resolveProfile(ref) : ref;
    if (!isProfileNode(profile)) {
      throw new MavlinkError(
        'UNKNOWN_PROFILE',
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

  if (!explicit && typeof connection.getProfileForPacket === 'function') {
    // Route the addressed target to its owning profile so the workflow speaks
    // that system's dialect/identity, not the default's. The target ids stay
    // as addressed — only protocol behavior (enums, source identity, firmware,
    // mission preferences) follows the routed profile.
    const routed = connection.getProfileForPacket({ sysid: Number(targetSystem), compid: Number(targetComponent) });
    if (isProfileNode(routed) && routed.isValid() && routed !== profile) {
      profile = routed;
      defaults = routed.getDefaults();
    }
  }

  return { profile, defaults, targetSystem, targetComponent };
}

module.exports = { isProfileNode, resolveWorkflowContext };
