'use strict';

const { MavLinkPacketSignature } = require('node-mavlink');
const { toBool } = require('../lib/util/validation');
const { MavlinkError } = require('../lib/util/errors');

/**
 * mavlink-ai-local-identity (issue #228).
 *
 * A Local MAVLink Identity is who this Node-RED runtime *is* when it
 * transmits: the source sysid/compid stamped into outbound frame headers, the
 * HEARTBEAT identity it advertises, and the signing credential/policy it
 * authenticates with. It owns nothing about the vehicle being addressed (that
 * is the Vehicle Profile) and nothing about how bytes move (that is the
 * Connection).
 *
 * Multiple Local Identity config nodes may coexist without error — one
 * Node-RED runtime may deliberately act as, say, both a GCS and an onboard
 * companion. Which identities may transmit on a given link is decided by the
 * Connection's explicit bindings, never here.
 *
 * Signing note (#192): the identity owns the shared secret and the
 * sign/verify/require policy, because a credential is naturally reused across
 * links. The signing *link id*, sequence counters, monotonic signing
 * timestamps, and inbound replay memory are channel state and belong to the
 * Connection's LinkState — a link id identifies a channel, not a credential.
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
    heartbeatType: 'MAV_TYPE_ONBOARD_CONTROLLER'
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
    node.sourceComponentId = identityUint8(config.sourceComponentId, 'Source component ID', preset.compid, 0);

    // HEARTBEAT identity (issue #195): what this component advertises itself
    // as. This is *local* identity — a GCS or companion must never advertise
    // the target vehicle's MAV_TYPE.
    node.heartbeatType = config.heartbeatType || preset.heartbeatType;
    node.heartbeatAutopilot = config.heartbeatAutopilot || 'MAV_AUTOPILOT_INVALID';

    // MAVLink 2 signing policy (issue #15). The passphrase is a Node-RED
    // credential so it is never written into exported flow JSON.
    node.signOutbound = toBool(config.signOutbound, false);
    node.verifyInbound = toBool(config.verifyInbound, false);
    node.requireSignature = toBool(config.requireSignature, false);

    // Sign-outbound with no passphrase cannot do what the setting promises:
    // every frame would go out unsigned while the user believes traffic is
    // authenticated. Fail closed (#91): mark the identity invalid, which
    // prevents connections bound to it from starting.
    const passphrase = (node.credentials && node.credentials.signingPassphrase) || '';
    if (node.signOutbound && !passphrase) {
      problems.push(
        "'Sign outbound' is enabled but no signing passphrase is set — packets are never sent unsigned under this setting"
      );
    }

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

    /**
     * The 32-byte signing key derived from the passphrase (SHA-256, the same
     * derivation Mission Planner / QGroundControl use), or null when no
     * passphrase is configured. Derived once.
     */
    const signingKey = passphrase ? MavLinkPacketSignature.key(passphrase) : null;

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

    /**
     * The signing policy this identity carries, or null when signing is
     * entirely off. `key` is the derived 32-byte key (null without a
     * passphrase). The signing link id is deliberately NOT here — it is
     * channel state owned by the Connection (#192).
     *
     * 'Require signature' is a fail-closed policy: it is meaningless without
     * inbound verification, so it implies it (#70).
     *
     * @returns {?{key: ?Buffer, signOutbound: boolean, verifyInbound: boolean,
     *   requireSignature: boolean}}
     */
    node.getSigningPolicy = () => {
      const verifyInbound = node.verifyInbound || node.requireSignature;
      if (!signingKey && !node.signOutbound && !verifyInbound) {
        return null;
      }
      return {
        key: signingKey,
        signOutbound: node.signOutbound,
        verifyInbound,
        requireSignature: node.requireSignature
      };
    };
  }

  // The signing passphrase is a credential so it lives in the encrypted
  // credential store, never in exported flow JSON (issue #15).
  RED.nodes.registerType('mavlink-ai-local-identity', MavlinkAiLocalIdentityNode, {
    credentials: {
      signingPassphrase: { type: 'password' }
    }
  });
};
