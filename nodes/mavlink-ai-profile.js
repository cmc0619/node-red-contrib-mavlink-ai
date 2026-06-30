module.exports = function registerMavlinkAiProfile(RED) {
  function MavlinkAiProfileNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.profileType = config.profileType || "gcs";
    this.dialect = config.dialect || "ardupilotmega";
    this.customDialectPath = config.customDialectPath || "";
    this.mavlinkVersion = config.mavlinkVersion || "auto";
    this.sourceSystemId = Number(config.sourceSystemId || 255);
    this.sourceComponentId = Number(config.sourceComponentId || 190);
    this.defaultTargetSystem = Number(config.defaultTargetSystem || 1);
    this.defaultTargetComponent = Number(config.defaultTargetComponent || 1);
    this.preferredMissionItemType = config.preferredMissionItemType || "MISSION_ITEM_INT";
    this.defaultMissionType = config.defaultMissionType || "mission";
    this.debugProtocol = Boolean(config.debugProtocol);

    this.getDefaults = () => ({
      profileType: this.profileType,
      dialect: this.dialect,
      mavlinkVersion: this.mavlinkVersion,
      sourceSystemId: this.sourceSystemId,
      sourceComponentId: this.sourceComponentId,
      defaultTargetSystem: this.defaultTargetSystem,
      defaultTargetComponent: this.defaultTargetComponent,
      preferredMissionItemType: this.preferredMissionItemType,
      defaultMissionType: this.defaultMissionType,
      debugProtocol: this.debugProtocol
    });
  }

  RED.nodes.registerType("mavlink-ai-profile", MavlinkAiProfileNode);
};
