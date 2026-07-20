'use strict';

const { VehicleRegistry } = require('../lib/swarm/vehicle-registry');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { toInt, toBool, parseJsonObjectConfig } = require('../lib/util/validation');
const { badgeForState, truncateStatus } = require('../lib/util/status');
const { safeDetach } = require('../lib/util/node-lifecycle');

/**
 * Messages the registry consumes. HEARTBEAT discovers vehicles; the rest
 * enrich known vehicles with position/status.
 */
const REGISTRY_MESSAGES = ['HEARTBEAT', 'GLOBAL_POSITION_INT', 'LOCAL_POSITION_NED', 'SYS_STATUS'];

/**
 * Change detection runs on a coarse ticker so stale/expiry transitions emit
 * without a per-message cost.
 */
const CHANGE_TICK_MS = 1000;

/**
 * mavlink-ai-swarm (issue #46).
 *
 * Maintains a registry of the active MAVLink systems on a connection,
 * discovered from HEARTBEAT and enriched from position/status telemetry.
 * Emits the vehicle table on membership/stale changes, on a fixed interval,
 * and/or on demand when a message arrives on its input (optionally filtered
 * by group/type/armed/sysids). The output feeds mavlink-ai-fanout directly.
 */
module.exports = function registerMavlinkAiSwarm(RED) {
  function MavlinkAiSwarmNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.connection = null;
    node.staleMs = toInt(config.staleMs, 5000);
    node.expireMs = toInt(config.expireMs, 30000);
    node.emitOnChange = toBool(config.emitOnChange, true);
    node.intervalMs = toInt(config.intervalMs, 0);
    node.includeGcs = toBool(config.includeGcs, false);

    /**
     * Malformed `groups` JSON makes the node invalid instead of silently
     * becoming `{}` and erasing safety grouping — a group-filtered snapshot
     * would otherwise return every vehicle (#204). Blank stays the empty
     * default; imported/API/hand-edited flows bypass the editor validator.
     */
    const parsedGroups = parseJsonObjectConfig(config.groups, 'groups');
    const groups = parsedGroups.value;
    node._configError = parsedGroups.error;
    if (node._configError) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    }

    /** Created on the first successful attach (needs the connection's profile). */
    let registry = null;
    let lastSignature = '';

    /**
     * Emit the current vehicle table.
     *
     * @param {object} [filter]  registry filter (group/type/armed/sysids/...)
     * @param {object} [msg]     incoming message to extend (input-triggered)
     * @returns {void}
     */
    function emitSnapshot(filter, msg) {
      if (!registry) {
        return;
      }
      const vehicles = registry.vehicles(filter || {});
      const out = msg || {};
      out.topic = 'swarm/vehicles';
      out.payload = {
        vehicles,
        sysids: [...new Set(vehicles.map((v) => v.sysid))],
        count: vehicles.length
      };
      node.send(out);
      updateBadge(vehicles);
    }

    /** @param {object[]} [vehicles] */
    function updateBadge(vehicles) {
      if (!registry) {
        return;
      }
      const list = vehicles || registry.vehicles();
      const stale = list.filter((v) => v.stale).length;
      const text = stale ? `${list.length} vehicles (${stale} stale)` : `${list.length} vehicles`;
      node.status({ fill: list.length ? 'green' : 'grey', shape: 'dot', text: truncateStatus(text) });
    }

    /**
     * Membership signature for change detection: which vehicles exist and
     * whether each is stale. Position/telemetry updates don't churn it.
     */
    function signature() {
      return registry
        .vehicles()
        .map((v) => `${v.sysid}/${v.compid}:${v.stale ? 1 : 0}`)
        .join(',');
    }

    function emitIfChanged() {
      if (!registry) {
        return;
      }
      const sig = signature();
      if (sig !== lastSignature) {
        lastSignature = sig;
        emitSnapshot();
      }
    }

    /**
     * The connection instance the subscription/listeners are attached to.
     * `undefined` = attach() has never run (so the first run always proceeds,
     * even when the connection resolves to null); `null` = attached to nothing.
     */
    let attachedTo;
    let subId = null;
    let onStatus = null;

    /** Drop the subscription and status listener from the attached connection. */
    function detach() {
      if (attachedTo) {
        try {
          if (subId != null) {
            attachedTo.unsubscribe(subId);
          }
          if (onStatus) {
            attachedTo.emitter.removeListener('status', onStatus);
          }
        } catch (err) {
          node.error(`Error detaching from connection: ${err && err.message ? err.message : err}`);
        }
      }
      attachedTo = null;
      subId = null;
      onStatus = null;
    }

    /**
     * (Re-)resolve the connection and (re-)subscribe. Re-run on every
     * `flows:started` (#164): a connection config node added/restored/
     * re-created in a later deploy leaves this node in place, so a one-time
     * constructor resolution would leave it dead (stale "missing connection"
     * badge, or a subscription on a destroyed connection object) until the
     * node itself is manually redeployed. The registry survives re-attachment
     * so known vehicles aren't forgotten across a connection redeploy.
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

      if (!registry) {
        const profile = node.connection.profile;
        const bundle = profile && typeof profile.getDialect === 'function' ? profile.getDialect() : null;
        registry = new VehicleRegistry({
          staleMs: node.staleMs,
          expireMs: node.expireMs,
          includeGcs: node.includeGcs,
          enums: bundle && bundle.valid ? bundle.enums : null,
          dialect: bundle && bundle.valid ? bundle.name : 'unknown'
        });
        registry.setGroups(groups);
        /** Exposed for tests/diagnostics. */
        node.registry = registry;
        lastSignature = signature();
      }

      subId = node.connection.subscribe({ messageNames: REGISTRY_MESSAGES }, (message) => {
        const { added } = registry.ingest(message.payload);
        if (added) {
          if (node.emitOnChange) {
            emitIfChanged();
          } else {
            updateBadge();
          }
        }
      });

      onStatus = (status) => node.status(badgeForState(status.state, status.state));
      node.connection.emitter.on('status', onStatus);
      updateBadge();
      attachedTo = node.connection;
    }

    /**
     * With a malformed `groups` config the node fails closed entirely (#204):
     * it does not attach/subscribe and does not start the change/interval
     * emit timers, so it can never auto-emit an ungrouped `swarm/vehicles`
     * snapshot (which bypasses the input handler's guard) — a broken group
     * config must not widen the output to every vehicle. The input handler
     * still answers with INVALID_CONFIG.
     */
    const timers = [];
    if (!node._configError) {
      attach();
      if (RED.events && typeof RED.events.on === 'function') {
        RED.events.on('flows:started', attach);
        node.on('close', function removeAttachWatcher() {
          RED.events.removeListener('flows:started', attach);
        });
      }
      if (node.emitOnChange) {
        timers.push(setInterval(emitIfChanged, CHANGE_TICK_MS));
      }
      if (node.intervalMs > 0) {
        timers.push(setInterval(() => emitSnapshot(), node.intervalMs));
      }
      for (const t of timers) {
        if (typeof t.unref === 'function') {
          t.unref();
        }
      }
    }

    /**
     * Input triggers an on-demand snapshot; payload may carry a registry
     * filter ({ group, type, armed, sysids, includeStale }). A malformed
     * filter yields a structured error message, not a crashed handler.
     */
    node.on('input', (msg, send, done) => {
      if (node._configError) {
        msg.topic = 'mavlink/error';
        msg.payload = errorPayload({
          node: 'mavlink-ai-swarm',
          code: 'INVALID_CONFIG',
          message: `mavlink-ai-swarm: ${node._configError}`
        });
        send(msg);
        return done();
      }
      if (!registry) {
        /**
         * No connection has ever resolved, so there is no registry to query —
         * answer with a structured NO_CONNECTION error instead of silently
         * swallowing the trigger (#154), matching mission/param.
         */
        msg.topic = 'mavlink/error';
        msg.payload = errorPayload({
          node: 'mavlink-ai-swarm',
          code: 'NO_CONNECTION',
          message: 'Swarm node has no connection configured.'
        });
        send(msg);
        return done();
      }
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const filter = {};
      for (const key of ['group', 'type', 'armed', 'sysids', 'includeStale']) {
        if (p[key] !== undefined) {
          filter[key] = p[key];
        }
      }
      let vehicles;
      try {
        vehicles = registry.vehicles(filter);
      } catch (err) {
        const e = toMavlinkError(err, 'BAD_FILTER');
        node.status({ fill: 'red', shape: 'ring', text: truncateStatus(e.code) });
        msg.topic = 'mavlink/error';
        msg.payload = errorPayload({ node: 'mavlink-ai-swarm', code: e.code, message: e.message, context: e.context });
        send(msg);
        return done();
      }
      msg.topic = 'swarm/vehicles';
      msg.payload = {
        vehicles,
        sysids: [...new Set(vehicles.map((v) => v.sysid))],
        count: vehicles.length
      };
      send(msg);
      updateBadge();
      done();
    });

    node.on('close', (done) => {
      safeDetach(node, detach);
      for (const t of timers) {
        clearInterval(t);
      }
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-swarm', MavlinkAiSwarmNode);
};
