module.exports = function registerMavlinkAiCommand(RED) {
  function MavlinkAiCommandNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.profile = RED.nodes.getNode(config.profile);
    this.command = config.command || 'arm';

    this.on('input', (msg, send, done) => {
      const commandMap = {
        arm: { command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 1 },
        disarm: { command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 0 },
        land: { command: 'MAV_CMD_NAV_LAND' },
        rtl: { command: 'MAV_CMD_NAV_RETURN_TO_LAUNCH' },
        request_message: { command: 'MAV_CMD_REQUEST_MESSAGE' },
        set_message_interval: { command: 'MAV_CMD_SET_MESSAGE_INTERVAL' }
      };

      const selected = msg.command || this.command;
      const mapped = commandMap[selected] || { command: selected };
      const incomingFields = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const profileDefaults = this.profile && this.profile.getDefaults ? this.profile.getDefaults() : {};

      msg.topic = 'mavlink/send';
      msg.payload = {
        name: 'COMMAND_LONG',
        profile: this.profile && this.profile.name,
        target_system: incomingFields.target_system || profileDefaults.defaultTargetSystem || 1,
        target_component: incomingFields.target_component || profileDefaults.defaultTargetComponent || 1,
        fields: {
          ...mapped,
          ...incomingFields
        }
      };

      send(msg);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-command', MavlinkAiCommandNode);
};
