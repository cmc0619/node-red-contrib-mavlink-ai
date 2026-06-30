module.exports = function registerMavlinkAiOut(RED) {
  function MavlinkAiOutNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.connection = RED.nodes.getNode(config.connection);

    if (!this.connection) {
      this.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
      return;
    }

    this.status({ fill: 'yellow', shape: 'ring', text: 'not implemented' });

    this.on('input', async (msg, send, done) => {
      try {
        if (msg.topic === 'mavlink/raw' || Buffer.isBuffer(msg.payload)) {
          await this.connection.sendRaw(msg.payload, { msg });
        } else {
          await this.connection.send(msg.payload, { msg });
        }
        done();
      } catch (err) {
        done(err);
      }
    });
  }

  RED.nodes.registerType('mavlink-ai-out', MavlinkAiOutNode);
};
