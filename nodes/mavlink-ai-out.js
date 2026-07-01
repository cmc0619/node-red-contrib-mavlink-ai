'use strict';

const { errorPayload } = require('../lib/util/errors');
const { badgeForState } = require('../lib/util/status');

/**
 * mavlink-ai-out (DESIGN.md §13.2).
 *
 * Sends what it is given through a shared connection — a normalized outbound
 * message object (topic mavlink/send) or a raw Buffer (topic mavlink/raw). It
 * does not build high-level commands itself.
 */
module.exports = function registerMavlinkAiOut(RED) {
  function MavlinkAiOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.connection = RED.nodes.getNode(config.connection);

    if (!node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
      return;
    }

    node.status(badgeForState(node.connection.statusState, node.connection.statusState));
    /** @param {object} status  connection status payload */
    const onStatus = (status) => node.status(badgeForState(status.state, status.state));
    node.connection.emitter.on('status', onStatus);

    let sent = 0;
    node.on('input', async (msg, send, done) => {
      // Error/status envelopes (e.g. from an upstream build/command node) are
      // not outbound MAVLink messages — don't try to encode and send them.
      if (msg.topic === 'mavlink/error' || msg.topic === 'mavlink/status') {
        return done();
      }
      try {
        if (msg.topic === 'mavlink/raw' || Buffer.isBuffer(msg.payload)) {
          await node.connection.sendRaw(msg.payload, { msg });
        } else {
          await node.connection.send(msg.payload, { msg });
        }
        sent += 1;
        node.status({ fill: 'green', shape: 'dot', text: `tx ${sent}` });
        done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: err.code || 'send error' });
        msg.payload = errorPayload({
          node: 'mavlink-ai-out',
          connection: node.connection.name,
          code: err.code || 'SEND_FAILED',
          message: err.message,
          context: err.context
        });
        msg.topic = 'mavlink/error';
        done(err);
      }
    });

    node.on('close', function close(done) {
      node.connection.emitter.removeListener('status', onStatus);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-out', MavlinkAiOutNode);
};
