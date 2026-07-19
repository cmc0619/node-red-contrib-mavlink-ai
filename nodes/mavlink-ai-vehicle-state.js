'use strict';

const { VehicleStateEngine, diffVehicleState } = require('../lib/state/vehicle-state');

/** Messages the engine ingests (capabilities come from the #233 cache, not here). */
const STATE_MESSAGES = [
  'HEARTBEAT', 'EXTENDED_SYS_STATE', 'SYS_STATUS', 'BATTERY_STATUS',
  'GPS_RAW_INT', 'GLOBAL_POSITION_INT', 'HOME_POSITION', 'STATUSTEXT'
];

/** Parse a comma/space id list to a Set of numbers; blank = empty (all). */
function parseSysids(raw) {
  return new Set(
    String(raw || '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n))
  );
}

module.exports = function (RED) {
  function VehicleStateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const allow = parseSysids(config.sysids);
    node.staleMs = Number(config.staleMs) > 0 ? Number(config.staleMs) : 5000;
    const statustextBuffer = Number(config.statustextBuffer) > 0 ? Number(config.statustextBuffer) : 20;
    const intervalMs = Number(config.intervalSeconds) > 0 ? Number(config.intervalSeconds) * 1000 : 0;

    let engine = null;
    let lastSnapshots = new Map();
    let attachedTo;
    let subId = null;
    let onStatus = null;
    const timers = [];

    const wanted = (sysid) => allow.size === 0 || allow.has(sysid);

    function badge() {
      if (!engine) {
        return;
      }
      const snaps = engine.snapshots().filter((s) => wanted(s.sysid));
      const connected = snaps.filter((s) => s.connected).length;
      node.status({ fill: snaps.length ? 'green' : 'grey', shape: 'dot', text: `${snaps.length} vehicles · ${connected} connected` });
    }

    /** Attach capabilities from the connection's #233 cache (engine never parses it). */
    function withCaps(snap) {
      let caps = null;
      if (node.connection && typeof node.connection.getVehicleCapabilities === 'function') {
        caps = node.connection.getVehicleCapabilities(snap.sysid, 1);
      }
      return Object.assign({}, snap, { capabilities: caps === undefined ? null : caps });
    }

    function emitTransitions(sysid) {
      const next = engine.snapshot(sysid);
      if (!next || !wanted(sysid)) {
        return;
      }
      const prev = lastSnapshots.get(sysid) || null;
      const events = diffVehicleState(prev, next, Date.now());
      lastSnapshots.set(sysid, next);
      for (const ev of events) {
        node.send([{ topic: 'vehicle/transition', payload: Object.assign({ contract: 'vehicle-state/1' }, ev) }, null, null]);
      }
      badge();
    }

    /**
     * Emit a snapshot on output 2. `emit` defaults to `node.send` for
     * autonomous callers (the interval ticker); the input handler passes its
     * own `send` so the reply is attributed to the triggering message.
     */
    function emitSnapshot(sysid, emit) {
      const doSend = emit || node.send;
      const targets = sysid !== undefined ? [sysid] : engine.sysids();
      for (const id of targets) {
        const snap = engine.snapshot(id);
        if (snap && wanted(id)) {
          doSend([null, { topic: 'vehicle/state', payload: withCaps(snap) }, null]);
        }
      }
    }

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
          node.error(`Error detaching: ${err && err.message ? err.message : err}`);
        }
      }
      attachedTo = null;
      subId = null;
      onStatus = null;
    }

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
      if (!engine) {
        const profile = node.connection.profile;
        const bundle = profile && typeof profile.getDialect === 'function' ? profile.getDialect() : null;
        engine = new VehicleStateEngine({
          staleMs: node.staleMs,
          statustextBuffer,
          enums: bundle && bundle.valid ? bundle.enums : null
        });
        node.engine = engine;
      }
      subId = node.connection.subscribe({ messageNames: STATE_MESSAGES }, (message) => {
        const res = engine.ingest(message.payload);
        if (!res) {
          return;
        }
        if (message.payload.name === 'STATUSTEXT' && wanted(res.sysid)) {
          const snap = engine.snapshot(res.sysid);
          const st = snap.statustext[snap.statustext.length - 1];
          node.send([null, null, { topic: 'vehicle/statustext', payload: Object.assign({ sysid: res.sysid, contract: 'vehicle-state/1' }, st) }]);
        }
        emitTransitions(res.sysid);
      });
      onStatus = () => badge();
      node.connection.emitter.on('status', onStatus);
      badge();
      attachedTo = node.connection;
    }

    attach();
    if (RED.events && typeof RED.events.on === 'function') {
      RED.events.on('flows:started', attach);
      node.on('close', () => RED.events.removeListener('flows:started', attach));
    }
    if (intervalMs > 0) {
      const t = setInterval(() => engine && emitSnapshot(), intervalMs);
      if (typeof t.unref === 'function') {
        t.unref();
      }
      timers.push(t);
    }

    node.on('input', (msg, send, done) => {
      const command = msg.command || (msg.payload && msg.payload.command);
      if (command === 'snapshot') {
        if (engine) {
          emitSnapshot(msg.sysid !== undefined ? Number(msg.sysid) : undefined, send);
        }
      }
      done();
    });

    node.on('close', (done) => {
      for (const t of timers) {
        clearInterval(t);
      }
      detach();
      engine = null;
      lastSnapshots = new Map();
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-vehicle-state', VehicleStateNode);
};
