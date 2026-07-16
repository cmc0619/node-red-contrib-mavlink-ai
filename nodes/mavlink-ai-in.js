'use strict';

const { parseList, parseIdList, toNum, toBool } = require('../lib/util/validation');
const { badgeForState } = require('../lib/util/status');
const { safeDetach } = require('../lib/util/node-lifecycle');

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
    node.connection = null;
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
    /** True while the connection reports a usable link, so the rx badge and the
     * connection-state badge stop overwriting each other (one badge, one truth):
     * connected -> rx counter; anything else -> the connection state. */
    let linkUp = false;

    /**
     * The connection instance the subscription/listeners are attached to.
     * `undefined` = attach() has never run (so the first run always proceeds,
     * even when the connection resolves to null); `null` = attached to nothing.
     */
    let attachedTo;
    let subId = null;
    let onDecodeError = null;
    let onRejected = null;
    let onStatus = null;

    /** Drop the subscription and listeners from the attached connection. */
    function detach() {
      if (attachedTo) {
        try {
          if (subId != null) {
            attachedTo.unsubscribe(subId);
          }
          if (onStatus) {
            attachedTo.emitter.removeListener('status', onStatus);
          }
          if (onDecodeError) {
            attachedTo.emitter.removeListener('decodeError', onDecodeError);
          }
          if (onRejected) {
            attachedTo.emitter.removeListener('rejected', onRejected);
          }
        } catch (err) {
          node.error(`Error detaching from connection: ${err && err.message ? err.message : err}`);
        }
      }
      attachedTo = null;
      subId = null;
      onStatus = null;
      onDecodeError = null;
      onRejected = null;
    }

    /**
     * (Re-)resolve the connection and (re-)subscribe. Re-run on every
     * `flows:started` (#164): a connection config node added/restored/
     * re-created in a later deploy leaves this node in place, so a one-time
     * constructor subscription would leave it dead (stale "missing connection"
     * badge, or a subscription on a destroyed connection object) until the
     * node itself is manually redeployed.
     */
    function attach() {
      const conn = RED.nodes.getNode(config.connection) || null;
      if (conn === attachedTo && conn === node.connection) {
        return;
      }
      detach();
      node.connection = conn;
      if (!node.connection) {
        node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
        return;
      }

      subId = node.connection.subscribe(filter, (message) => {
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
        if (linkUp && now - lastStatusAt >= STATUS_UPDATE_MS) {
          lastStatusAt = now;
          node.status({ fill: 'green', shape: 'dot', text: `rx ${count}` });
        }
      });

      // Diagnostics output (#22): decode errors already arrive as mavlink/error
      // envelopes; routing rejections are wrapped here. Without this output the
      // connection's structured diagnostics have no consumer a flow can reach.
      if (node.outputErrors) {
        onDecodeError = (message) =>
          sendAt(errorIndex, RED.util.cloneMessage({ topic: message.topic, payload: message.payload }));
        onRejected = (info) => sendAt(errorIndex, RED.util.cloneMessage({ topic: 'mavlink/rejected', payload: info }));
        node.connection.emitter.on('decodeError', onDecodeError);
        node.connection.emitter.on('rejected', onRejected);
      }

      /**
       * One badge, one meaning: while the link is up the badge carries the rx
       * counter; on any other state it carries the connection state. Without
       * the split the two writers fought and the badge flickered between "rx N"
       * and "connected" at telemetry rates.
       *
       * @param {string} state  connection status state
       */
      const showState = (state) => {
        linkUp = state === 'connected' || state === 'listening';
        if (!linkUp) {
          node.status(badgeForState(state, state));
        } else if (count === 0) {
          node.status(badgeForState(state, state));
        }
      };
      onStatus = (status) => showState(status.state);
      node.connection.emitter.on('status', onStatus);
      showState(node.connection.statusState);
      attachedTo = node.connection;
    }

    attach();
    if (RED.events && typeof RED.events.on === 'function') {
      RED.events.on('flows:started', attach);
      node.on('close', function removeAttachWatcher() {
        RED.events.removeListener('flows:started', attach);
      });
    }

    node.on('close', function close(done) {
      safeDetach(node, detach);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-in', MavlinkAiInNode);
};
