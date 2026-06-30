module.exports = function registerMavlinkAiMission(RED) {
  function MavlinkAiMissionNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.connection = RED.nodes.getNode(config.connection);
    this.action = config.action || 'download';
    this.timeoutMs = Number(config.timeoutMs || 3000);
    this.maxRetries = Number(config.maxRetries || 3);

    this.on('input', (msg, send, done) => {
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      send([
        null,
        {
          topic: 'mission/progress',
          payload: {
            state: 'not-implemented',
            action: payload.action || this.action,
            timeoutMs: this.timeoutMs,
            maxRetries: this.maxRetries
          }
        },
        {
          topic: 'mavlink/error',
          payload: {
            node: 'mavlink-ai-mission',
            code: 'NOT_IMPLEMENTED',
            message: 'Mission workflow state machine is not implemented yet.'
          }
        }
      ]);

      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-mission', MavlinkAiMissionNode);
};
