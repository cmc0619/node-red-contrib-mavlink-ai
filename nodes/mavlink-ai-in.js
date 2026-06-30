module.exports = function registerMavlinkAiIn(RED) {
  function MavlinkAiInNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.connection = RED.nodes.getNode(config.connection);
    this.messageFilter = config.messageFilter || '';
    this.outputRaw = Boolean(config.outputRaw);

    if (!this.connection) {
      this.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
      return;
    }

    this.status({ fill: 'yellow', shape: 'ring', text: 'not implemented' });

    const unsubscribe = this.connection.subscribe(
      { messageFilter: this.messageFilter, outputRaw: this.outputRaw },
      (msg) => this.send(msg)
    );

    this.on('close', function close(done) {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-in', MavlinkAiInNode);
};
