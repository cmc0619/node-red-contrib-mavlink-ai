'use strict';

const { parseList, parseIdList, toInt, toBool } = require('../lib/util/validation');
const { badgeForState } = require('../lib/util/status');

/**
 * mavlink-ai-in (DESIGN.md §13.1).
 *
 * Subscribes to a shared connection and emits decoded MAVLink messages. It does
 * not decode packets itself — the connection decodes once and distributes to
 * matching subscribers (§20). Output 2 (optional) carries raw packet buffers.
 */
module.exports = function registerMavlinkAiIn(RED) {
  function MavlinkAiInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.connection = RED.nodes.getNode(config.connection);
    node.messageNames = parseList(config.messageNames);
    node.messageIds = parseIdList(config.messageIds);
    node.sysid = config.sysid === '' || config.sysid == null ? '*' : toInt(config.sysid, '*');
    node.compid = config.compid === '' || config.compid == null ? '*' : toInt(config.compid, '*');
    node.profileFilter = config.profileFilter || '';
    node.rateLimitHz = toInt(config.rateLimitHz, 0);
    node.changedOnly = toBool(config.changedOnly, false);
    node.outputRaw = toBool(config.outputRaw, false);

    if (!node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
      return;
    }

    const filter = {
      messageNames: node.messageNames,
      messageIds: node.messageIds,
      sysid: node.sysid,
      compid: node.compid,
      profile: node.profileFilter || undefined,
      rateLimitHz: node.rateLimitHz,
      changedOnly: node.changedOnly
    };

    let count = 0;
    const subId = node.connection.subscribe(filter, (message) => {
      count += 1;
      const decoded = { topic: message.topic, payload: message.payload };
      if (node.outputRaw) {
        const raw = { topic: 'mavlink/raw', payload: message._buffer };
        node.send([decoded, raw]);
      } else {
        node.send(decoded);
      }
      node.status({ fill: 'green', shape: 'dot', text: `rx ${count}` });
    });

    // Reflect connection status on the node badge.
    const onStatus = (status) => node.status(badgeForState(status.state, status.state));
    node.connection.emitter.on('status', onStatus);
    node.status(badgeForState(node.connection.statusState, node.connection.statusState));

    node.on('close', function close(done) {
      node.connection.unsubscribe(subId);
      node.connection.emitter.removeListener('status', onStatus);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-in', MavlinkAiInNode);
};
