'use strict';

const { loadDialect, getMessageClass } = require('../lib/dialects/dialect-loader');
const enumResolver = require('../lib/protocol/enum-resolver');
const normalizer = require('../lib/protocol/message-normalizer');
const { toInt, toBool } = require('../lib/util/validation');

/**
 * mavlink-ai-profile (DESIGN.md §6, §7).
 *
 * A profile owns MAVLink identity and protocol defaults: dialect, version,
 * source/target ids, mission preferences, heartbeat identity. It does NOT own
 * sockets, timers, or peer state — that is the connection's job.
 */

// Map profile vehicle type to a sensible default heartbeat MAV_TYPE.
const HEARTBEAT_TYPE_BY_PROFILE = {
  gcs: 'MAV_TYPE_GCS',
  generic: 'MAV_TYPE_GENERIC',
  copter: 'MAV_TYPE_QUADROTOR',
  plane: 'MAV_TYPE_FIXED_WING',
  rover: 'MAV_TYPE_GROUND_ROVER',
  boat: 'MAV_TYPE_SURFACE_BOAT',
  sub: 'MAV_TYPE_SUBMARINE',
  'antenna-tracker': 'MAV_TYPE_ANTENNA_TRACKER'
};

module.exports = function registerMavlinkAiProfile(RED) {
  function MavlinkAiProfileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.profileType = config.profileType || 'gcs';
    node.dialect = config.dialect || 'ardupilotmega';
    node.customDialectPath = config.customDialectPath || '';
    node.mavlinkVersion = config.mavlinkVersion || 'auto';
    node.sourceSystemId = toInt(config.sourceSystemId, 255);
    node.sourceComponentId = toInt(config.sourceComponentId, 190);
    node.defaultTargetSystem = toInt(config.defaultTargetSystem, 1);
    node.defaultTargetComponent = toInt(config.defaultTargetComponent, 1);
    node.preferredMissionItemType = config.preferredMissionItemType || 'MISSION_ITEM_INT';
    node.defaultMissionType = config.defaultMissionType || 'mission';
    node.heartbeatType = config.heartbeatType || '';
    node.heartbeatAutopilot = config.heartbeatAutopilot || 'MAV_AUTOPILOT_INVALID';
    node.debugProtocol = toBool(config.debugProtocol, false);

    // Load the dialect at construction. On failure mark invalid and report a
    // useful error — never silently fall back to a different dialect (§15).
    node.bundle = loadDialect(node.dialect, { customDialectPath: node.customDialectPath });
    if (!node.bundle.valid) {
      node.error(
        `MAVLink profile '${node.name || node.id}' dialect load failed: ${node.bundle.error.message}`
      );
    }

    node.isValid = () => node.bundle.valid;
    node.getError = () => node.bundle.error;
    node.getDialect = () => node.bundle;

    node.getDefaults = () => ({
      profileType: node.profileType,
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

    node.getProtocolOptions = () => ({
      version: node.mavlinkVersion,
      sysid: node.sourceSystemId,
      compid: node.sourceComponentId
    });

    // Heartbeat identity values (§22). Identity is profile-owned; whether/how
    // often to send is connection-owned.
    node.getHeartbeatFields = () => ({
      type: node.heartbeatType || HEARTBEAT_TYPE_BY_PROFILE[node.profileType] || 'MAV_TYPE_GENERIC',
      autopilot: node.heartbeatAutopilot || 'MAV_AUTOPILOT_INVALID',
      base_mode: 0,
      custom_mode: 0,
      system_status: 'MAV_STATE_ACTIVE'
    });

    node.getMessageDefinition = (nameOrId) => getMessageClass(node.bundle, nameOrId);

    node.getEnum = (name) => node.bundle.enums.enumsByName[name];

    node.resolveEnumValue = (value) => enumResolver.resolveEnumValue(node.bundle.enums, value);

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
