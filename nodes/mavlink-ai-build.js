module.exports = function registerMavlinkAiBuild(RED) {
  function MavlinkAiBuildNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.profile = RED.nodes.getNode(config.profile);
    this.messageName = config.messageName || 'HEARTBEAT';

    this.on('input', (msg, send, done) => {
      msg.topic = 'mavlink/send';
      msg.payload = {
        name: msg.messageName || this.messageName,
        profile: this.profile && this.profile.name,
        fields: msg.payload && typeof msg.payload === 'object' ? msg.payload : {}
      };
      send(msg);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-build', MavlinkAiBuildNode);
};
