'use strict';

const { loadDialect, getMessageClass } = require('../lib/dialects/dialect-loader');
const enumResolver = require('../lib/protocol/enum-resolver');
const normalizer = require('../lib/protocol/message-normalizer');
const { toBool } = require('../lib/util/validation');
const { MavlinkError } = require('../lib/util/errors');
const { registerEditorApi } = require('../lib/editor-api');

/**
 * mavlink-ai-profile (DESIGN.md §6, §7).
 *
 * A profile owns MAVLink identity and protocol defaults: dialect, version,
 * source/target ids, mission preferences, heartbeat identity. It does NOT own
 * sockets, timers, or peer state — that is the connection's job.
 */

// Map profile role/vehicle type to a sensible default heartbeat MAV_TYPE.
// A profile's local MAVLink identity is independent of the target flight
// controller's vehicle type: 'companion-computer' identifies this component
// as an onboard controller (issue #106) regardless of the vehicle it talks to.
const HEARTBEAT_TYPE_BY_PROFILE = {
  gcs: 'MAV_TYPE_GCS',
  generic: 'MAV_TYPE_GENERIC',
  'companion-computer': 'MAV_TYPE_ONBOARD_CONTROLLER',
  copter: 'MAV_TYPE_QUADROTOR',
  plane: 'MAV_TYPE_FIXED_WING',
  rover: 'MAV_TYPE_GROUND_ROVER',
  boat: 'MAV_TYPE_SURFACE_BOAT',
  sub: 'MAV_TYPE_SUBMARINE',
  'antenna-tracker': 'MAV_TYPE_ANTENNA_TRACKER'
};

// Suggested default source component id per profile role, applied only when the
// user leaves Source CompID blank (issue #106). A companion computer normally
// announces itself as MAV_COMP_ID_ONBOARD_COMPUTER (191); every other role
// keeps the historical default of 190. An explicitly configured value is never
// rewritten — identityUint8 only consults this fallback for a blank field.
const DEFAULT_SOURCE_COMPONENT_ID = 190;
const SOURCE_COMPONENT_ID_BY_PROFILE = {
  'companion-computer': 191 // MAV_COMP_ID_ONBOARD_COMPUTER
};

module.exports = function registerMavlinkAiProfile(RED) {
  // Serve the loader's dialect list to the profile editor's dialect dropdown
  // (issue #4), so the UI discovers bundled dialects instead of hard-coding them.
  registerEditorApi(RED);

  function MavlinkAiProfileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.profileType = config.profileType || 'gcs';
    // Firmware abstraction hook (RELEASE_SCOPE §8). Exposed from day one so the
    // code has a place to branch on firmware instead of hard-coding ArduPilot
    // assumptions into generic paths. Behavior is mostly generic for now.
    node.firmware = config.firmware || 'generic';
    node.dialect = config.dialect || 'ardupilotmega';
    node.customDialectPath = config.customDialectPath || '';
    node.mavlinkVersion = config.mavlinkVersion || 'auto';
    // MAVLink identity fields are uint8s on the wire (#90). Validate here —
    // not just in the editor — so imported/API-created flows get the same
    // enforcement. A blank value takes the default; anything else must be an
    // integer in range, never silently truncated, wrapped, or defaulted.
    const identityProblems = [];
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
        identityProblems.push(`${field} must be an integer in [${min}, 255] (got ${JSON.stringify(value)})`);
        return fallback;
      }
      return n;
    }
    // Source sysid 0 means "unknown/broadcast" and is not a valid sender id.
    node.sourceSystemId = identityUint8(config.sourceSystemId, 'Source system ID', 255, 1);
    // The blank-field default follows the profile role (companion computer → 191),
    // but only when nothing is configured; an explicit value passes through as-is.
    const defaultSourceComponentId =
      SOURCE_COMPONENT_ID_BY_PROFILE[node.profileType] || DEFAULT_SOURCE_COMPONENT_ID;
    /** Source compid 0 is MAV_COMP_ID_ALL (the broadcast component address),
     * never a valid sender id — same floor the codec enforces (#153). */
    node.sourceComponentId = identityUint8(config.sourceComponentId, 'Source component ID', defaultSourceComponentId, 1);
    node.defaultTargetSystem = identityUint8(config.defaultTargetSystem, 'Default target system', 1, 0);
    node.defaultTargetComponent = identityUint8(config.defaultTargetComponent, 'Default target component', 1, 0);
    node.preferredMissionItemType = config.preferredMissionItemType || 'MISSION_ITEM_INT';
    node.defaultMissionType = config.defaultMissionType || 'mission';
    node.heartbeatType = config.heartbeatType || '';
    node.heartbeatAutopilot = config.heartbeatAutopilot || 'MAV_AUTOPILOT_INVALID';
    node.debugProtocol = toBool(config.debugProtocol, false);

    // MAVLink 2 signing (issue #15). Minimal support built on node-mavlink's
    // signing primitives: sign outbound frames and/or verify inbound ones with
    // a shared passphrase. The passphrase is a Node-RED credential so it is not
    // written into exported flow JSON; the toggles/link id are plain config.
    node.signOutbound = toBool(config.signOutbound, false);
    node.verifyInbound = toBool(config.verifyInbound, false);
    node.requireSignature = toBool(config.requireSignature, false);
    // The signing link id is also a uint8; wrapping it modulo 256 would turn a
    // config mistake into a *different* valid link id (#90).
    node.signingLinkId = identityUint8(config.signingLinkId, 'Signing link ID', 0, 0);

    // Invalid identity values make the whole profile invalid (#90): the codec
    // and connections must refuse to start rather than send with a wrong id.
    node._identityError = identityProblems.length
      ? new MavlinkError('IDENTITY_INVALID', `Invalid MAVLink identity configuration: ${identityProblems.join('; ')}.`, {
          problems: identityProblems
        })
      : null;
    if (node._identityError) {
      node.error(`MAVLink profile '${node.name || node.id}': ${node._identityError.message}`);
    }

    // Load the dialect at construction. On failure mark invalid and report a
    // useful error — never silently fall back to a different dialect (§15).
    node.bundle = loadDialect(node.dialect, { customDialectPath: node.customDialectPath });
    if (!node.bundle.valid) {
      node.error(
        `MAVLink profile '${node.name || node.id}' dialect load failed: ${node.bundle.error.message}`
      );
    }

    /** @returns {boolean} whether the dialect loaded and identity config is valid */
    node.isValid = () => node.bundle.valid && !node._identityError;
    /** @returns {?object} structured dialect-load/identity error, or null */
    node.getError = () => (node.bundle.valid ? node._identityError : node.bundle.error);
    /** @returns {DialectBundle} the loaded dialect bundle */
    node.getDialect = () => node.bundle;

    /**
     * Profile defaults consumed by connection/flow nodes (targets, mission,
     * identity, debug).
     *
     * @returns {object}
     */
    node.getDefaults = () => ({
      profileType: node.profileType,
      firmware: node.firmware,
      dialect: node.dialect,
      mavlinkVersion: node.mavlinkVersion,
      sourceSystemId: node.sourceSystemId,
      sourceComponentId: node.sourceComponentId,
      defaultTargetSystem: node.defaultTargetSystem,
      defaultTargetComponent: node.defaultTargetComponent,
      preferredMissionItemType: node.preferredMissionItemType,
      defaultMissionType: node.defaultMissionType,
      debugProtocol: node.debugProtocol
    });

    /**
     * MAVLink 2 signing options for the codec (issue #15), or null when signing
     * is entirely off. The passphrase comes from the encrypted credential store;
     * a config with only verify/require flags set (no passphrase) is still
     * returned so inbound handling can fail closed rather than silently pass
     * unverified traffic.
     *
     * @returns {?object}
     */
    node.getSigningOptions = () => {
      const passphrase = (node.credentials && node.credentials.signingPassphrase) || '';
      if (!passphrase && !node.signOutbound && !node.verifyInbound && !node.requireSignature) {
        return null;
      }
      return {
        passphrase,
        linkId: node.signingLinkId,
        signOutbound: node.signOutbound,
        verifyInbound: node.verifyInbound,
        requireSignature: node.requireSignature
      };
    };

    /**
     * Protocol options used to construct a codec (version + source identity +
     * signing).
     *
     * @returns {{version: string, sysid: number, compid: number, signing: ?object}}
     */
    node.getProtocolOptions = () => ({
      version: node.mavlinkVersion,
      sysid: node.sourceSystemId,
      compid: node.sourceComponentId,
      signing: node.getSigningOptions()
    });

    /**
     * Heartbeat identity fields (§22). Identity is profile-owned; whether/how
     * often to send is connection-owned.
     *
     * @returns {object} HEARTBEAT field values
     */
    node.getHeartbeatFields = () => ({
      type: node.heartbeatType || HEARTBEAT_TYPE_BY_PROFILE[node.profileType] || 'MAV_TYPE_GENERIC',
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
     * @param {string|number} nameOrId  message name or id
     * @returns {?Function} the message class, or undefined
     */
    node.getMessageDefinition = (nameOrId) => getMessageClass(node.bundle, nameOrId);

    /**
     * @param {string} name  enum export name (e.g. "MavCmd")
     * @returns {?object} the enum object, or undefined
     */
    node.getEnum = (name) => node.bundle.enums.enumsByName[name];

    /**
     * Resolve an enum-name string to its numeric value (pass-through otherwise).
     *
     * @param {*} value
     * @returns {*}
     */
    node.resolveEnumValue = (value) => enumResolver.resolveEnumValue(node.bundle.enums, value);

    /**
     * Normalize a fields object against a message definition (snake_case keys,
     * enum names resolved).
     *
     * @param {string} messageName
     * @param {object} fields
     * @returns {object}
     */
    node.normalizeFields = (messageName, fields) => {
      const clazz = getMessageClass(node.bundle, messageName);
      if (!clazz) {
        return {};
      }
      return normalizer.normalizeFields(node.bundle, clazz, fields);
    };
  }

  // The signing passphrase is a credential so it lives in the encrypted
  // credential store, never in exported flow JSON (issue #15).
  RED.nodes.registerType('mavlink-ai-profile', MavlinkAiProfileNode, {
    credentials: {
      signingPassphrase: { type: 'password' }
    }
  });
};
