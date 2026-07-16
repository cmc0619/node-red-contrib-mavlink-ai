'use strict';

const enumResolver = require('../protocol/enum-resolver');

/**
 * The outbound send-priority policy (#241, DESIGN.md §21.1).
 *
 * The outbound queue has always had priority bands with age promotion and an
 * emergency floor (#150), but no producer used them — everything landed in the
 * default band, so an arm/disarm or mode change could sit behind a backlog of
 * routine traffic on a slow link. This module is the single, deliberately
 * small policy every producer assigns from:
 *
 *   CRITICAL (0)    safety/control commands a vehicle must act on promptly —
 *                   ONLY the explicitly listed MAV_CMDs below, never guessed
 *                   from arbitrary messages.
 *   ELEVATED (1)    control streams whose cadence keeps a mode alive: Move
 *                   setpoints (PX4 drops OFFBOARD after ~0.5 s without one).
 *                   Also the age-promotion floor for lower bands, so nothing
 *                   non-critical starves (#150).
 *   NORMAL (2)      everything else — command/mission/param/payload protocol
 *                   traffic. The queue default.
 *   BACKGROUND (3)  periodic heartbeats; coalesced per identity.
 */
const PRIORITY = { CRITICAL: 0, ELEVATED: 1, NORMAL: 2, BACKGROUND: 3 };

/**
 * The MAV_CMD ids mapped to the CRITICAL band. Deliberately tight and
 * id-based: arm/disarm, mode change, flight termination, and parachute — the
 * commands whose delay is a safety problem. Anything not listed rides NORMAL,
 * with the explicit per-message override (see {@link clampPriority}) as the
 * advanced escape hatch for a custom kill switch or similar.
 *
 * @type {Set<number>}
 */
const CRITICAL_COMMANDS = new Set([
  400 /** MAV_CMD_COMPONENT_ARM_DISARM */,
  176 /** MAV_CMD_DO_SET_MODE */,
  185 /** MAV_CMD_DO_FLIGHTTERMINATION */,
  208 /** MAV_CMD_DO_PARACHUTE */
]);

/**
 * The band for a resolved numeric MAV_CMD id.
 *
 * @param {*} commandId
 * @returns {number} PRIORITY.CRITICAL or PRIORITY.NORMAL
 */
function commandPriority(commandId) {
  return CRITICAL_COMMANDS.has(Number(commandId)) ? PRIORITY.CRITICAL : PRIORITY.NORMAL;
}

/**
 * The band for a command that may still be a MAV_CMD name. Resolves against
 * MavCmd only (a name from another enum must not accidentally match a critical
 * id); an unresolvable name rides NORMAL — the encode path reports it, the
 * priority policy never guesses.
 *
 * @param {?object} enums   dialect enum index, or null
 * @param {string|number} command
 * @returns {number}
 */
function commandPriorityFor(enums, command) {
  if (typeof command === 'number') {
    return commandPriority(command);
  }
  if (enums && typeof command === 'string') {
    const resolved = enumResolver.resolveInEnum(enums, 'MavCmd', command);
    if (Number.isFinite(Number(resolved))) {
      return commandPriority(Number(resolved));
    }
  }
  return PRIORITY.NORMAL;
}

/**
 * Bound an explicit per-message priority override (`msg.priority` on the Out
 * node) into the valid band range. Undefined/blank means "no override" and a
 * non-numeric value is ignored the same way — the override is an advanced
 * escape hatch, not a validated input path; the queue's default band applies.
 * Numeric values are truncated to an integer and clamped to [0, 3], so an
 * out-of-range override can neither invent a band above CRITICAL nor park a
 * message below BACKGROUND.
 *
 * @param {*} value
 * @returns {number|undefined} a valid band, or undefined for "no override"
 */
function clampPriority(value) {
  /**
   * Only a number or a numeric string counts as an override. Number() coerces
   * other shapes into "valid" bands — false and a whitespace-only string both
   * become 0 — so a `priority: false` "not a priority" flag or a blank
   * text/env value would silently claim the CRITICAL band for routine traffic,
   * defeating the emergency band this policy protects (Codex review).
   */
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return Math.min(PRIORITY.BACKGROUND, Math.max(PRIORITY.CRITICAL, Math.trunc(n)));
}

module.exports = { PRIORITY, CRITICAL_COMMANDS, commandPriority, commandPriorityFor, clampPriority };
