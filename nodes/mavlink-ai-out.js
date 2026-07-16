'use strict';

const { badgeForState } = require('../lib/util/status');
const { safeDetach } = require('../lib/util/node-lifecycle');
const { TRANSPORT_WAITING_CODES } = require('../lib/util/errors');
const { clampPriority } = require('../lib/runtime/send-priority');

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
    node.connection = null;

    /**
     * The connection instance the status listener is currently attached to.
     * `undefined` = attach() has never run (so the first run always proceeds,
     * even when the connection resolves to null); `null` = attached to nothing.
     */
    let attachedTo;
    let onStatus = null;

    /** Detach the status listener from the previously attached connection. */
    function detach() {
      if (attachedTo && onStatus) {
        try {
          attachedTo.emitter.removeListener('status', onStatus);
        } catch (err) {
          node.error(`Error detaching from connection: ${err && err.message ? err.message : err}`);
        }
      }
      attachedTo = null;
      onStatus = null;
    }

    /**
     * (Re-)resolve the connection reference and attach the status listener.
     * Re-run on every `flows:started` (#164): a connection config node
     * added/restored/re-created in a later deploy leaves this node in place, so
     * a one-time constructor resolution would keep a dangling null/stale
     * reference (dead node, stale "missing connection" badge) until the node
     * itself is manually redeployed.
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
      node.status(badgeForState(node.connection.statusState, node.connection.statusState));
      /** @param {object} status  connection status payload */
      onStatus = (status) => node.status(badgeForState(status.state, status.state));
      node.connection.emitter.on('status', onStatus);
      attachedTo = node.connection;
    }

    attach();
    if (RED.events && typeof RED.events.on === 'function') {
      RED.events.on('flows:started', attach);
      node.on('close', function removeAttachWatcher() {
        RED.events.removeListener('flows:started', attach);
      });
    }

    let sent = 0;
    node.on('input', async (msg, send, done) => {
      /**
       * A missing connection must fail loudly, not swallow messages: with no
       * handler registered the message would vanish with nothing for a Catch
       * node to see (the swarm node got this guard in #154).
       */
      if (!node.connection) {
        node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
        return done(new Error('NO_CONNECTION: mavlink-ai-out has no connection configured/resolved.'));
      }
      /**
       * Error/status envelopes (e.g. from an upstream build/command node) are
       * not outbound MAVLink messages — don't try to encode and send them.
       */
      if (msg.topic === 'mavlink/error' || msg.topic === 'mavlink/status') {
        return done();
      }
      try {
        /**
         * Advanced explicit priority override (#241): msg.priority picks the
         * outbound queue band, clamped to the valid range (0 critical .. 3
         * background); absent or non-numeric means the queue default. The
         * command node stamps it on critical build-only commands.
         */
        const priority = clampPriority(msg.priority);
        if (msg.topic === 'mavlink/raw' || Buffer.isBuffer(msg.payload)) {
          await node.connection.sendRaw(msg.payload, { priority });
        } else {
          await node.connection.send(msg.payload, { priority });
        }
        sent += 1;
        node._notReadyWarned = false;
        node.status({ fill: 'green', shape: 'dot', text: `tx ${sent}` });
        done();
      } catch (err) {
        /**
         * A transport that is passively waiting for the other side — a udp-peer
         * that hasn't learned a peer, a TCP server with no client connected yet —
         * is a normal transient state, not a send failure. Badge it "waiting for
         * link" and warn once (re-armed on the next successful send) instead of
         * spamming the error output / Catch nodes on every send (#83 follow-up).
         * Codes that may never recover (a not-connected client with reconnect
         * off, a failed transport start) fall through to done(err) below.
         */
        if (err && TRANSPORT_WAITING_CODES.has(err.code)) {
          node.status({ fill: 'yellow', shape: 'ring', text: 'waiting for link' });
          if (!node._notReadyWarned) {
            node._notReadyWarned = true;
            node.warn(`Holding output — ${err.message}`);
          }
          return done();
        }
        /** This node has no outputs; real failures surface via done(err) so a
         * Catch node can handle them. */
        node._notReadyWarned = false;
        node.status({ fill: 'red', shape: 'ring', text: err.code || 'send error' });
        done(err);
      }
    });

    node.on('close', function close(done) {
      safeDetach(node, detach);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-out', MavlinkAiOutNode);
};
