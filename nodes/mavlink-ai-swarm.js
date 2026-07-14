'use strict';

const { VehicleRegistry } = require('../lib/swarm/vehicle-registry');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { toInt, toBool } = require('../lib/util/validation');
const { badgeForState } = require('../lib/util/status');
const { safeDetach } = require('../lib/util/node-lifecycle');

// Messages the registry consumes. HEARTBEAT discovers vehicles; the rest
// enrich known vehicles with position/status.
const REGISTRY_MESSAGES = ['HEARTBEAT', 'GLOBAL_POSITION_INT', 'LOCAL_POSITION_NED', 'SYS_STATUS'];

// Change detection runs on a coarse ticker so stale/expiry transitions emit
// without a per-message cost.
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
    node.connection = RED.nodes.getNode(config.connection);
    node.staleMs = toInt(config.staleMs, 5000);
    node.expireMs = toInt(config.expireMs, 30000);
    node.emitOnChange = toBool(config.emitOnChange, true);
    node.intervalMs = toInt(config.intervalMs, 0);
    node.includeGcs = toBool(config.includeGcs, false);

    let groups = {};
    if (config.groups) {
      try {
        groups = JSON.parse(config.groups);
      } catch (e) {
        node.warn(`mavlink-ai-swarm: invalid groups JSON, ignoring (${e.message})`);
      }
    }

    if (!node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
      return;
    }

    const profile = node.connection.profile;
    const bundle = profile && typeof profile.getDialect === 'function' ? profile.getDialect() : null;
    const registry = new VehicleRegistry({
      staleMs: node.staleMs,
      expireMs: node.expireMs,
      includeGcs: node.includeGcs,
      enums: bundle && bundle.valid ? bundle.enums : null
    });
    registry.setGroups(groups);
    node.registry = registry; // exposed for tests/diagnostics

    /**
     * Emit the current vehicle table.
     *
     * @param {object} [filter]  registry filter (group/type/armed/sysids/...)
     * @param {object} [msg]     incoming message to extend (input-triggered)
     * @returns {void}
     */
    function emitSnapshot(filter, msg) {
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
      const list = vehicles || registry.vehicles();
      const stale = list.filter((v) => v.stale).length;
      const text = stale ? `${list.length} vehicles (${stale} stale)` : `${list.length} vehicles`;
      node.status({ fill: list.length ? 'green' : 'grey', shape: 'dot', text });
    }

    // Membership signature for change detection: which vehicles exist and
    // whether each is stale. Position/telemetry updates don't churn it.
    function signature() {
      return registry
        .vehicles()
        .map((v) => `${v.sysid}/${v.compid}:${v.stale ? 1 : 0}`)
        .join(',');
    }

    let lastSignature = signature();
    function emitIfChanged() {
      const sig = signature();
      if (sig !== lastSignature) {
        lastSignature = sig;
        emitSnapshot();
      }
    }

    const subId = node.connection.subscribe({ messageNames: REGISTRY_MESSAGES }, (message) => {
      const { added } = registry.ingest(message.payload);
      if (added) {
        if (node.emitOnChange) {
          emitIfChanged();
        } else {
          updateBadge();
        }
      }
    });

    const timers = [];
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

    // Input triggers an on-demand snapshot; payload may carry a registry
    // filter ({ group, type, armed, sysids, includeStale }). A malformed
    // filter yields a structured error message, not a crashed handler.
    node.on('input', (msg, send, done) => {
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
        node.status({ fill: 'red', shape: 'ring', text: e.code });
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

    const onStatus = (status) => node.status(badgeForState(status.state, status.state));
    node.connection.emitter.on('status', onStatus);
    updateBadge();

    node.on('close', (done) => {
      safeDetach(node, () => {
        node.connection.unsubscribe(subId);
        node.connection.emitter.removeListener('status', onStatus);
      });
      for (const t of timers) {
        clearInterval(t);
      }
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-swarm', MavlinkAiSwarmNode);
};
