const { EventEmitter } = require('events');

module.exports = function registerMavlinkAiConnection(RED) {
  function MavlinkAiConnectionNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.profile = RED.nodes.getNode(config.profile);
    this.transport = config.transport || 'udp-peer';
    this.routingMode = config.routingMode || 'single-profile';
    this.bindAddress = config.bindAddress || '0.0.0.0';
    this.bindPort = Number(config.bindPort || 14550);
    this.remoteHost = config.remoteHost || '';
    this.remotePort = Number(config.remotePort || 14550);
    this.serialPath = config.serialPath || '';
    this.serialBaud = Number(config.serialBaud || 57600);
    this.reconnect = config.reconnect !== false;
    this.heartbeat = Boolean(config.heartbeat);
    this.heartbeatIntervalMs = Number(config.heartbeatIntervalMs || 1000);

    this.emitter = new EventEmitter();
    this.statusState = 'not-implemented';

    this.getStatus = () => ({
      node: 'mavlink-ai-connection',
      connection: this.name,
      state: this.statusState,
      transport: this.transport,
      detail: 'Connection runtime is not implemented yet.'
    });

    this.subscribe = (filter, callback) => {
      this.emitter.on('message', callback);
      return () => this.emitter.off('message', callback);
    };

    this.send = async () => {
      throw new Error('mavlink-ai-connection send() is not implemented yet.');
    };

    this.sendRaw = async () => {
      throw new Error('mavlink-ai-connection sendRaw() is not implemented yet.');
    };

    this.on('close', function closeConnection(done) {
      this.emitter.removeAllListeners();
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-connection', MavlinkAiConnectionNode);
};
