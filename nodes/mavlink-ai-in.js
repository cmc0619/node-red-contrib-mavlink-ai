'use strict';

const { parseList, parseIdList, toInt, toNum, toBool } = require('../lib/util/validation');
const { badgeForState } = require('../lib/util/status');

// Minimum interval between rx-counter badge updates. Status updates travel to
// every open editor over the admin websocket, so pushing one per message at
// telemetry rates (50Hz ATTITUDE) can bog down the editor UI.
const STATUS_UPDATE_MS = 500;

/**
 * mavlink-ai-in (DESIGN.md §13.1).
 *
 * Subscribes to a shared connection and emits decoded MAVLink messages. It does
 * not decode packets itself — the connection decodes once and distributes to
 * matching subscribers (§20). Optional outputs carry raw packet buffers and
 * connection diagnostics (decode errors / routing rejections, issue #22).
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
    // toNum, not toInt: sub-1Hz rates like 0.5 are meaningful and truncation
    // would silently disable the limit.
    node.rateLimitHz = toNum(config.rateLimitHz, 0);
    node.changedOnly = toBool(config.changedOnly, false);
    node.outputRaw = toBool(config.outputRaw, false);
    node.outputErrors = toBool(config.outputErrors, false);

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

    // Output layout: [decoded, raw?, errors?] — the optional outputs keep
    // their relative order, so the errors output index depends on outputRaw.
    const errorIndex = node.outputRaw ? 2 : 1;
    /** Send one message on output `index`, padding the array to match. */
    function sendAt(index, message) {
      const out = [];
      out[index] = message;
      node.send(out);
    }

    let count = 0;
    let lastStatusAt = 0;
    const subId = node.connection.subscribe(filter, (message) => {
      count += 1;
      /**
       * The connection decodes once and hands the SAME message/payload object to
       * every subscriber (§20), so clone before forwarding into the flow (issue
       * #141). Without this, a downstream Change/Function node mutating
       * msg.payload.fields would corrupt the copy that other mavlink-ai-in nodes
       * on this connection already forwarded, and the shared _buffer likewise.
       */
      const decoded = RED.util.cloneMessage({ topic: message.topic, payload: message.payload });
      if (node.outputRaw) {
        const raw = RED.util.cloneMessage({ topic: 'mavlink/raw', payload: message._buffer });
        node.send([decoded, raw]);
      } else {
        node.send(decoded);
      }
      const now = Date.now();
      if (now - lastStatusAt >= STATUS_UPDATE_MS) {
        lastStatusAt = now;
        node.status({ fill: 'green', shape: 'dot', text: `rx ${count}` });
      }
    });

    // Diagnostics output (#22): decode errors already arrive as mavlink/error
    // envelopes; routing rejections are wrapped here. Without this output the
    // connection's structured diagnostics have no consumer a flow can reach.
    let onDecodeError = null;
    let onRejected = null;
    if (node.outputErrors) {
      onDecodeError = (message) =>
        sendAt(errorIndex, RED.util.cloneMessage({ topic: message.topic, payload: message.payload }));
      onRejected = (info) => sendAt(errorIndex, RED.util.cloneMessage({ topic: 'mavlink/rejected', payload: info }));
      node.connection.emitter.on('decodeError', onDecodeError);
      node.connection.emitter.on('rejected', onRejected);
    }

    // Reflect connection status on the node badge.
    /** @param {object} status  connection status payload */
    const onStatus = (status) => node.status(badgeForState(status.state, status.state));
    node.connection.emitter.on('status', onStatus);
    node.status(badgeForState(node.connection.statusState, node.connection.statusState));

    node.on('close', function close(done) {
      /**
       * On a full undeploy the connection config node may already be torn down,
       * so guard every dereference and always signal done() — a throw here would
       * otherwise abort the deploy (issue #140).
       */
      try {
        if (node.connection) {
          node.connection.unsubscribe(subId);
          node.connection.emitter.removeListener('status', onStatus);
          if (onDecodeError) {
            node.connection.emitter.removeListener('decodeError', onDecodeError);
          }
          if (onRejected) {
            node.connection.emitter.removeListener('rejected', onRejected);
          }
        }
      } catch (err) {
        node.error(`Error detaching from connection on close: ${err && err.message ? err.message : err}`);
      }
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-in', MavlinkAiInNode);
};
