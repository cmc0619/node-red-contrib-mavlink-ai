'use strict';

const { loadDialect, getMessageClass } = require('../lib/dialects/dialect-loader');
const enumResolver = require('../lib/protocol/enum-resolver');
const normalizer = require('../lib/protocol/message-normalizer');
const { toBool } = require('../lib/util/validation');
const { MavlinkError } = require('../lib/util/errors');
const { registerEditorApi } = require('../lib/editor-api');

/**
 * mavlink-ai-profile — the target-facing **Vehicle Profile** (issue #228).
 *
 * A Vehicle Profile describes the vehicle being addressed and how its protocol
 * metadata is interpreted: dialect, firmware, MAVLink version preference,
 * default target ids, vehicle family (for mode tables and parameter metadata),
 * and mission preferences.
 *
 * It deliberately owns NOTHING about the local side (#195, #228):
 *
 *  - no source sysid/compid — that is the mavlink-ai-local-identity node;
 *  - no local HEARTBEAT identity — a GCS talking to a Copter must not
 *    advertise itself as a quadrotor;
 *  - no signing credential/policy — that follows the Local Identity, and the
 *    signing link id/channel state follows the Connection (#192).
 *
 * Selecting a Vehicle Profile can therefore never change who this Node-RED
 * runtime is on the wire.
 */

/**
 * Vehicle families understood by the mode-table and parameter-metadata
 * registries (lib/command/flight-modes.js, lib/params/param-def-sources.js).
 */
const VEHICLE_FAMILIES = ['generic', 'copter', 'plane', 'rover', 'boat', 'sub', 'antenna-tracker'];

/**
 * Deterministic legacy `profileType` -> `vehicleFamily` conversion (issue
 * #228 migration). Vehicle-shaped legacy types keep their family; the local
 * *role* types (gcs, companion-computer, generic) carried no target vehicle
 * information, so they map to 'generic'.
 */
const LEGACY_PROFILE_TYPE_TO_FAMILY = {
  gcs: 'generic',
  generic: 'generic',
  'companion-computer': 'generic',
  copter: 'copter',
  plane: 'plane',
  rover: 'rover',
  boat: 'boat',
  sub: 'sub',
  'antenna-tracker': 'antenna-tracker'
};

/**
 * Legacy (pre-v3) config fields that used to make this node also carry the
 * local identity. They are no longer honored here; each maps to where the
 * concept moved so the deprecation warning can say exactly where to look.
 */
const LEGACY_IDENTITY_FIELDS = {
  sourceSystemId: 'Local Identity > Source SysID',
  sourceComponentId: 'Local Identity > Source CompID',
  heartbeatType: 'Local Identity > Heartbeat type',
  heartbeatAutopilot: 'Local Identity > Heartbeat autopilot',
  signOutbound: 'Local Identity > Sign outbound',
  verifyInbound: 'Local Identity > Verify inbound',
  requireSignature: 'Local Identity > Require signature',
  signingLinkId: 'Connection > Signing link ID'
};

module.exports = function registerMavlinkAiProfile(RED) {
  // Serve the loader's dialect list to the profile editor's dialect dropdown
  // (issue #4), so the UI discovers bundled dialects instead of hard-coding them.
  registerEditorApi(RED);

  function MavlinkAiProfileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    /**
     * Target vehicle family, used for ArduPilot mode tables and parameter
     * metadata. Legacy flows stored a combined `profileType`; convert it
     * deterministically and say so, rather than guessing silently (#228).
     */
    if (config.vehicleFamily) {
      node.vehicleFamily = VEHICLE_FAMILIES.includes(config.vehicleFamily) ? config.vehicleFamily : 'generic';
    } else if (config.profileType) {
      node.vehicleFamily = LEGACY_PROFILE_TYPE_TO_FAMILY[config.profileType] || 'generic';
      node.warn(
        `MAVLink profile '${node.name || node.id}': legacy 'profileType: ${config.profileType}' converted to ` +
          `vehicle family '${node.vehicleFamily}'. Profiles are now target-facing Vehicle Profiles; re-save this ` +
          `profile in the editor to persist the conversion.`
      );
    } else {
      node.vehicleFamily = 'generic';
    }
    // Firmware abstraction hook (RELEASE_SCOPE §8). Exposed from day one so the
    // code has a place to branch on firmware instead of hard-coding ArduPilot
    // assumptions into generic paths. Behavior is mostly generic for now.
    node.firmware = config.firmware || 'generic';
    node.dialect = config.dialect || 'ardupilotmega';
    node.customDialectPath = config.customDialectPath || '';
    node.mavlinkVersion = config.mavlinkVersion || 'auto';

    // Target ids are uint8s on the wire (#90). Validate here — not just in the
    // editor — so imported/API-created flows get the same enforcement.
    const targetProblems = [];
    /**
     * Validate one uint8 target config value, collecting the problem instead
     * of throwing so every bad field is reported at once.
     *
     * @param {*} value  raw config value
     * @param {string} field  readable field name
     * @param {number} fallback  default when blank
     * @returns {number}
     */
    function targetUint8(value, field, fallback) {
      if (value === undefined || value === null || value === '') {
        return fallback;
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 255) {
        targetProblems.push(`${field} must be an integer in [0, 255] (got ${JSON.stringify(value)})`);
        return fallback;
      }
      return n;
    }
    node.defaultTargetSystem = targetUint8(config.defaultTargetSystem, 'Default target system', 1);
    node.defaultTargetComponent = targetUint8(config.defaultTargetComponent, 'Default target component', 1);
    node.preferredMissionItemType = config.preferredMissionItemType || 'MISSION_ITEM_INT';
    node.defaultMissionType = config.defaultMissionType || 'mission';
    node.debugProtocol = toBool(config.debugProtocol, false);

    /**
     * Legacy local-identity fields on this node are no longer honored (#228):
     * the profile must never determine local source identity, heartbeat role,
     * or signing. Warn once, explicitly, naming each field and where the
     * concept now lives — a legacy flow fails closed at the Connection (which
     * now requires a Local Identity) rather than transmitting with ids pulled
     * from a vehicle profile.
     */
    const legacyFields = Object.keys(LEGACY_IDENTITY_FIELDS).filter(
      (f) => config[f] !== undefined && config[f] !== null && config[f] !== '' && config[f] !== false && Number(config[f]) !== 0
    );
    if (legacyFields.length) {
      node.warn(
        `MAVLink profile '${node.name || node.id}': this Vehicle Profile no longer owns local identity/signing. ` +
          `Ignored legacy field(s): ${legacyFields
            .map((f) => `'${f}' (moved to ${LEGACY_IDENTITY_FIELDS[f]})`)
            .join(', ')}. Create a mavlink-ai-local-identity config node and select it on the Connection.`
      );
    }

    node._configError = targetProblems.length
      ? new MavlinkError('PROFILE_CONFIG_INVALID', `Invalid Vehicle Profile configuration: ${targetProblems.join('; ')}.`, {
          problems: targetProblems
        })
      : null;
    if (node._configError) {
      node.error(`MAVLink profile '${node.name || node.id}': ${node._configError.message}`);
    }

    // Load the dialect at construction. On failure mark invalid and report a
    // useful error — never silently fall back to a different dialect (§15).
    node.bundle = loadDialect(node.dialect, { customDialectPath: node.customDialectPath });
    if (!node.bundle.valid) {
      node.error(
        `MAVLink profile '${node.name || node.id}' dialect load failed: ${node.bundle.error.message}`
      );
    }

    /** @returns {boolean} whether the dialect loaded and the config is valid */
    node.isValid = () => node.bundle.valid && !node._configError;
    /** @returns {?object} structured dialect-load/config error, or null */
    node.getError = () => (node.bundle.valid ? node._configError : node.bundle.error);
    /** @returns {DialectBundle} the loaded dialect bundle */
    node.getDialect = () => node.bundle;

    /**
     * Profile defaults consumed by connection/flow nodes (targets, mission,
     * vehicle family, firmware, debug). Contains no local identity (#228).
     *
     * @returns {object}
     */
    node.getDefaults = () => ({
      vehicleFamily: node.vehicleFamily,
      firmware: node.firmware,
      dialect: node.dialect,
      mavlinkVersion: node.mavlinkVersion,
      defaultTargetSystem: node.defaultTargetSystem,
      defaultTargetComponent: node.defaultTargetComponent,
      preferredMissionItemType: node.preferredMissionItemType,
      defaultMissionType: node.defaultMissionType,
      debugProtocol: node.debugProtocol
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

  RED.nodes.registerType('mavlink-ai-profile', MavlinkAiProfileNode);
};
