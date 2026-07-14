'use strict';

const { parseList, parseIdList, toNum, toBool } = require('../lib/util/validation');
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
    /**
     * Accept comma-separated id lists ("1,2,3") like the filter node, not just a
     * single id (#154). parseIdList treats blank/"any"/"*" as no constraint and
     * drops non-numeric entries, so a stray "1,2" no longer silently narrows to
     * sysid 1.
     */
    node.sysids = parseIdList(config.sysid);
    node.compids = parseIdList(config.compid);
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
      sysids: node.sysids,
      compids: node.compids,
      profile: node.profileFilter || undefined,
      rateLimitHz: node.rateLimitHz,
      changedOnly: node.changedOnly
    };

    /**
     * The visible output ports come from the editor-synced `outputs` property,
     * but the raw/error port indices are derived from outputRaw/outputErrors. A
     * hand-edited or imported flow can disagree (e.g. outputRaw:true, outputs:1),
     * silently dropping raw/error messages. Warn so the mismatch is visible (#154).
     */
    const expectedOutputs = 1 + (node.outputRaw ? 1 : 0) + (node.outputErrors ? 1 : 0);
    const declaredOutputs = Number(config.outputs);
    if (Number.isFinite(declaredOutputs) && declaredOutputs !== expectedOutputs) {
      node.warn(
        `output count mismatch: raw/errors settings imply ${expectedOutputs} output(s) but the node declares ${declaredOutputs}; ` +
          'some messages may be dropped. Re-open the node and redeploy to resync.'
      );
    }

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
      const decoded = { topic: message.topic, payload: message.payload };
      if (node.outputRaw) {
        const raw = { topic: 'mavlink/raw', payload: message._buffer };
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
      onDecodeError = (message) => sendAt(errorIndex, { topic: message.topic, payload: message.payload });
      onRejected = (info) => sendAt(errorIndex, { topic: 'mavlink/rejected', payload: info });
      node.connection.emitter.on('decodeError', onDecodeError);
      node.connection.emitter.on('rejected', onRejected);
    }

    // Reflect connection status on the node badge.
    /** @param {object} status  connection status payload */
    const onStatus = (status) => node.status(badgeForState(status.state, status.state));
    node.connection.emitter.on('status', onStatus);
    node.status(badgeForState(node.connection.statusState, node.connection.statusState));

    node.on('close', function close(done) {
      node.connection.unsubscribe(subId);
      node.connection.emitter.removeListener('status', onStatus);
      if (onDecodeError) {
        node.connection.emitter.removeListener('decodeError', onDecodeError);
      }
      if (onRejected) {
        node.connection.emitter.removeListener('rejected', onRejected);
      }
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-in', MavlinkAiInNode);
};
