'use strict';

const { MavlinkError } = require('../lib/util/errors');
const { toBool } = require('../lib/util/validation');

/**
 * mavlink-ai-local-identity (issue #228).
 *
 * A Local MAVLink Identity is who this Node-RED runtime *is* when it
 * transmits: the source sysid/compid stamped into outbound frame headers and
 * the HEARTBEAT identity it advertises. It owns nothing about the vehicle being
 * addressed (that is the Vehicle Profile) and nothing about how bytes move or
 * how the link is secured (that is the Connection).
 *
 * Multiple Local Identity config nodes may coexist without error — one
 * Node-RED runtime may deliberately act as, say, both a GCS and an onboard
 * companion. Which identities may transmit on a given link is decided by the
 * Connection's explicit bindings, never here.
 *
 * Signing lives on the Connection, not here: a MAVLink link has exactly one
 * signing key shared by both endpoints, so the credential and the
 * sign/verify/require policy belong to the secured link — letting one identity
 * talk signed on one connection and unsigned on another.
 */

/** Role presets (issue #106): suggested identity per role. */
const ROLE_PRESETS = {
  gcs: {
    sysid: 255,
    compid: 190, // MAV_COMP_ID_MISSIONPLANNER, the conventional GCS component
    heartbeatType: 'MAV_TYPE_GCS'
  },
  companion: {
    // A companion normally shares its vehicle's sysid (commonly 1) and keeps
    // its own component id: MAV_COMP_ID_ONBOARD_COMPUTER.
    sysid: 1,
    compid: 191,
    heartbeatType: 'MAV_TYPE_ONBOARD_CONTROLLER',
    // A companion is well-placed to advertise its own health via HEARTBEAT
    // system_status (#225); default that behavior on for this role.
    healthDriven: true
  },
  custom: {
    sysid: 255,
    compid: 190,
    heartbeatType: 'MAV_TYPE_GENERIC'
  }
};

module.exports = function registerMavlinkAiLocalIdentity(RED) {
  function MavlinkAiLocalIdentityNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.role = ROLE_PRESETS[config.role] ? config.role : 'custom';
    const preset = ROLE_PRESETS[node.role];

    // MAVLink identity fields are uint8s on the wire (#90). Validate here —
    // not just in the editor — so imported/API-created flows get the same
    // enforcement. A blank value takes the role preset's default; anything
    // else must be an integer in range, never silently truncated or wrapped.
    const problems = [];
    /**
     * Validate one uint8 identity config value, collecting the problem
     * instead of throwing so every bad field is reported at once.
     *
     * @param {*} value  raw config value
     * @param {string} field  readable field name
     * @param {number} fallback  default when blank
     * @param {number} [min=0]  lower bound (source sysid disallows 0)
     * @returns {number}
     */
    function identityUint8(value, field, fallback, min = 0) {
      if (value === undefined || value === null || value === '') {
        return fallback;
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > 255) {
        problems.push(`${field} must be an integer in [${min}, 255] (got ${JSON.stringify(value)})`);
        return fallback;
      }
      return n;
    }
    // Source sysid 0 means "unknown/broadcast" and is not a valid sender id.
    node.sourceSystemId = identityUint8(config.sourceSystemId, 'Source system ID', preset.sysid, 1);
    /** Source compid 0 is MAV_COMP_ID_ALL (the broadcast component address),
     * never a valid sender id — same floor the codec enforces (#153). */
    node.sourceComponentId = identityUint8(config.sourceComponentId, 'Source component ID', preset.compid, 1);

    // HEARTBEAT identity (issue #195): what this component advertises itself
    // as. This is *local* identity — a GCS or companion must never advertise
    // the target vehicle's MAV_TYPE.
    node.heartbeatType = config.heartbeatType || preset.heartbeatType;
    node.heartbeatAutopilot = config.heartbeatAutopilot || 'MAV_AUTOPILOT_INVALID';

    /**
     * Health-driven heartbeat (#225): when on, the connection maps this
     * identity's advertised health to HEARTBEAT.system_status instead of the
     * static MAV_STATE_ACTIVE. Defaults to the role preset (companion → on).
     */
    node.healthDriven = toBool(config.healthDriven, !!preset.healthDriven);

    node._identityError = problems.length
      ? new MavlinkError(
          'IDENTITY_INVALID',
          `Invalid Local MAVLink Identity configuration: ${problems.join('; ')}.`,
          { problems }
        )
      : null;
    if (node._identityError) {
      node.error(`MAVLink local identity '${node.name || node.id}': ${node._identityError.message}`);
    }

    /** @returns {boolean} whether the identity configuration is valid */
    node.isValid = () => !node._identityError;
    /** @returns {?MavlinkError} the identity configuration error, or null */
    node.getError = () => node._identityError;

    /**
     * The wire identity stamped into outbound frame headers.
     *
     * @returns {{sysid: number, compid: number}}
     */
    node.getIdentity = () => ({ sysid: node.sourceSystemId, compid: node.sourceComponentId });

    /**
     * Human-readable identity label for errors/UI: "name (sysid/compid)".
     *
     * @returns {string}
     */
    node.describe = () => `${node.name || node.id} (${node.sourceSystemId}/${node.sourceComponentId})`;

    /**
     * HEARTBEAT identity fields (§22, #195). Identity is identity-owned;
     * whether/how often to send is connection-owned (per binding).
     *
     * @returns {object} HEARTBEAT field values
     */
    node.getHeartbeatFields = () => ({
      type: node.heartbeatType,
      autopilot: node.heartbeatAutopilot || 'MAV_AUTOPILOT_INVALID',
      base_mode: 0,
      custom_mode: 0,
      system_status: 'MAV_STATE_ACTIVE',
      // HEARTBEAT.mavlink_version is the wire protocol version of the dialect
      // (the XML `uint8_t_mavlink_version` magic field that mavgen auto-fills
      // with MAVLINK_VERSION = 3). node-mavlink leaves it 0, which then gets
      // truncated away and makes our heartbeats advertise version 0 (#66). The
      // current common message set is version 3 regardless of v1/v2 framing.
      mavlink_version: 3
    });
  }

  RED.nodes.registerType('mavlink-ai-local-identity', MavlinkAiLocalIdentityNode);
};
