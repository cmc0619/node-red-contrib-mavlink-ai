module.exports = function registerMavlinkAiFilter(RED) {
  function MavlinkAiFilterNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.messageNames = (config.messageNames || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    this.sysid = config.sysid === '' || config.sysid == null ? null : Number(config.sysid);
    this.compid = config.compid === '' || config.compid == null ? null : Number(config.compid);

    this.on('input', (msg, send, done) => {
      const payload = msg.payload || {};
      const name = payload.name;

      if (this.messageNames.length && !this.messageNames.includes(name)) {
        done();
        return;
      }

      if (this.sysid != null && Number(payload.sysid) !== this.sysid) {
        done();
        return;
      }

      if (this.compid != null && Number(payload.compid) !== this.compid) {
        done();
        return;
      }

      send(msg);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-filter', MavlinkAiFilterNode);
};
