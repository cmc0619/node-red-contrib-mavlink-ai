'use strict';

const { EventEmitter } = require('events');
const { MavlinkCodec } = require('../lib/protocol/mavlink-codec');
const { createTransport } = require('../lib/transport');
const { PacketRouter } = require('../lib/routing/packet-router');
const { SubscriptionRegistry } = require('../lib/runtime/subscription-registry');
const { OutboundQueue } = require('../lib/runtime/outbound-queue');
const { LockManager } = require('../lib/runtime/lock-manager');
const { statusPayload } = require('../lib/util/status');
const { toInt, toBool, parseIdList } = require('../lib/util/validation');
const { MavlinkError, toMavlinkError } = require('../lib/util/errors');

/**
 * mavlink-ai-connection (DESIGN.md §8, §11, §19).
 *
 * The connection config node owns the wire: transport/session, the codec built
 * from its default profile's dialect, inbound routing, the subscription
 * registry, the outbound queue, the heartbeat timer, and mission locks. All
 * state is scoped to the instance — no module-level singletons.
 */
module.exports = function registerMavlinkAiConnection(RED) {
  function MavlinkAiConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.profile = RED.nodes.getNode(config.profile);
    node.transportType = config.transport || 'udp-peer';
    node.routingMode = config.routingMode || 'single-profile';
    node.bindAddress = config.bindAddress || '0.0.0.0';
    node.bindPort = toInt(config.bindPort, 14550);
    node.remoteHost = config.remoteHost || '';
    node.remotePort = toInt(config.remotePort, 14550);
    node.serialPath = config.serialPath || '';
    node.serialBaud = toInt(config.serialBaud, 57600);
    node.reconnect = toBool(config.reconnect, true);
    node.heartbeatEnabled = toBool(config.heartbeat, false);
    node.heartbeatIntervalMs = toInt(config.heartbeatIntervalMs, 1000);
    node.acceptedSysids = parseIdList(config.acceptedSysids);
    node.acceptedCompids = parseIdList(config.acceptedCompids);
    node.unmatchedPolicy = config.unmatchedPolicy || (node.routingMode === 'routed' ? 'reject' : 'default');

    node.emitter = new EventEmitter();
    node.emitter.setMaxListeners(0);
    node.subscriptions = new SubscriptionRegistry();
    node.locks = new LockManager();
    node.statusState = 'idle';
    node.statusDetail = '';

    node._heartbeatTimer = null;
    node._decoder = null;
    node._transport = null;
    node._codec = null;
    node._router = null;
    node._queue = null;

    // --- status helpers ------------------------------------------------------
    node.getStatus = () =>
      statusPayload({
        node: 'mavlink-ai-connection',
        connection: node.name,
        state: node.statusState,
        transport: node.transportType,
        detail: node.statusDetail
      });

    function setStatus(state, detail) {
      node.statusState = state;
      node.statusDetail = detail || '';
      node.emitter.emit('status', node.getStatus());
    }

    function fatal(code, message) {
      node.statusState = 'error';
      node.statusDetail = message;
      node.error(`mavlink-ai-connection '${node.name || node.id}': ${code}: ${message}`);
    }

    // --- profile / codec setup ----------------------------------------------
    if (!node.profile) {
      fatal('NO_PROFILE', 'Connection has no profile configured.');
      registerNoop(node);
      return;
    }
    if (!node.profile.isValid()) {
      const err = node.profile.getError();
      fatal('DIALECT_INVALID', `Profile dialect invalid: ${err && err.message}`);
      registerNoop(node);
      return;
    }

    try {
      node._codec = new MavlinkCodec(
        Object.assign({ bundle: node.profile.getDialect() }, node.profile.getProtocolOptions())
      );
    } catch (err) {
      fatal('CODEC_INIT_FAILED', err.message);
      registerNoop(node);
      return;
    }

    // --- routing -------------------------------------------------------------
    node.resolveProfile = (ref) => {
      if (!ref) {
        return node.profile;
      }
      if (typeof ref === 'object') {
        return ref;
      }
      // A route may reference a profile config-node id or, when authored as
      // JSON, a plain profile name. Prefer a real node; otherwise surface the
      // name as a lightweight label so routed messages still carry it.
      const byId = RED.nodes.getNode(ref);
      if (byId) {
        return byId;
      }
      if (node.profile && node.profile.name === ref) {
        return node.profile;
      }
      return { name: ref };
    };

    node._router = new PacketRouter({
      mode: node.routingMode,
      defaultProfile: node.profile,
      acceptedSysids: node.acceptedSysids,
      acceptedCompids: node.acceptedCompids,
      unmatched: node.unmatchedPolicy,
      routes: config.routeTable,
      resolveProfile: (ref) => node.resolveProfile(ref)
    });

    // --- public runtime API (DESIGN.md §12) ---------------------------------
    node.subscribe = (filter, callback) => node.subscriptions.subscribe(filter, callback);
    node.unsubscribe = (id) => node.subscriptions.unsubscribe(id);

    node.getProfileForPacket = (packetOrHeader) => {
      const decision = node._router.route(packetOrHeader.sysid, packetOrHeader.compid);
      return decision.accepted ? decision.profile : null;
    };

    node.acquireLock = (lockName, owner) => node.locks.acquire(lockName, owner);
    node.releaseLock = (lockName, owner) => node.locks.release(lockName, owner);

    node.send = (message, options = {}) => {
      if (!message || typeof message !== 'object') {
        return Promise.reject(new MavlinkError('BAD_OUTBOUND', 'Outbound message must be an object.'));
      }
      const defaults = node.profile.getDefaults();
      const fields = message.fields && typeof message.fields === 'object' ? message.fields : {};
      const targetSystem = firstDefined(message.target_system, fields.target_system, defaults.defaultTargetSystem);
      const targetComponent = firstDefined(
        message.target_component,
        fields.target_component,
        defaults.defaultTargetComponent
      );
      let buffer;
      try {
        buffer = node._codec.encode(message.name, fields, { targetSystem, targetComponent });
      } catch (err) {
        return Promise.reject(toMavlinkError(err, 'ENCODE_FAILED'));
      }
      return node._queue.enqueue(buffer, options.priority);
    };

    node.sendRaw = (buffer, options = {}) => {
      if (!Buffer.isBuffer(buffer)) {
        return Promise.reject(new MavlinkError('BAD_RAW', 'Raw payload must be a Buffer.'));
      }
      return node._queue.enqueue(buffer, options.priority);
    };

    // --- inbound packet handling --------------------------------------------
    function onPacket(packet) {
      const header = packet.header;
      const decision = node._router.route(header.sysid, header.compid);
      if (!decision.accepted) {
        node.emitter.emit('rejected', { sysid: header.sysid, compid: header.compid, reason: decision.reason });
        return;
      }
      const profile = decision.profile || node.profile;
      const transportDescriptor = node._transport ? node._transport.descriptor : { type: node.transportType };
      const payload = node._codec.decode(packet, {
        profile: profile ? profile.name : undefined,
        transport: transportDescriptor
      });
      // `_buffer` carries the original wire bytes for subscribers that opt into
      // raw output. It is stripped before a decoded message leaves a node, so
      // it never pollutes the §14.1 contract.
      const message = { topic: `mavlink/${payload.name}`, payload, _buffer: packet.buffer };

      node.subscriptions.dispatch(message);
      node.emitter.emit('message', message);
      node.emitter.emit('raw', { topic: 'mavlink/raw', payload: packet.buffer });
    }

    // --- heartbeat -----------------------------------------------------------
    function startHeartbeat() {
      if (!node.heartbeatEnabled || node._heartbeatTimer) {
        return;
      }
      const tick = () => {
        node
          .send({ name: 'HEARTBEAT', fields: node.profile.getHeartbeatFields() }, { priority: 3 })
          .catch((err) => node.emitter.emit('error', toMavlinkError(err, 'HEARTBEAT_FAILED')));
      };
      node._heartbeatTimer = setInterval(tick, node.heartbeatIntervalMs);
      if (typeof node._heartbeatTimer.unref === 'function') {
        node._heartbeatTimer.unref();
      }
    }

    function stopHeartbeat() {
      if (node._heartbeatTimer) {
        clearInterval(node._heartbeatTimer);
        node._heartbeatTimer = null;
      }
    }

    // --- transport startup ---------------------------------------------------
    node._queue = new OutboundQueue((buf) => node._transport.send(buf), {
      enabled: toBool(config.outboundQueue, true)
    });

    function startTransport() {
      try {
        node._transport = createTransport({
          name: node.name,
          transport: node.transportType,
          bindAddress: node.bindAddress,
          bindPort: node.bindPort,
          remoteHost: node.remoteHost,
          remotePort: node.remotePort,
          serialPath: node.serialPath,
          serialBaud: node.serialBaud,
          reconnect: node.reconnect
        });
      } catch (err) {
        fatal('TRANSPORT_INIT_FAILED', err.message);
        return;
      }

      node._decoder = node._codec.createDecoder(onPacket, (err) =>
        node.emitter.emit('error', toMavlinkError(err, 'DECODE_ERROR'))
      );

      node._transport.on('data', (buffer) => {
        try {
          node._decoder.write(buffer);
        } catch (err) {
          node.emitter.emit('error', toMavlinkError(err, 'DECODE_ERROR'));
        }
      });
      node._transport.on('listening', (info) => {
        setStatus(node.transportType.startsWith('udp') ? 'listening' : 'connected', describeListening(node, info));
        startHeartbeat();
      });
      node._transport.on('connected', (info) => {
        setStatus('connected', describeListening(node, info));
        startHeartbeat();
      });
      node._transport.on('reconnecting', () => setStatus('reconnecting', 'Reconnecting...'));
      node._transport.on('error', (err) => {
        const e = toMavlinkError(err, 'TRANSPORT_ERROR');
        setStatus('error', e.message);
        node.emitter.emit('error', e);
      });
      node._transport.on('close', () => setStatus('closed', 'Transport closed'));

      setStatus('connecting', 'Starting transport');
      try {
        node._transport.start();
      } catch (err) {
        fatal('TRANSPORT_START_FAILED', err.message);
      }
    }

    startTransport();

    // --- lifecycle (DESIGN.md §19) ------------------------------------------
    node.on('close', function closeConnection(done) {
      stopHeartbeat();
      node.subscriptions.clear();
      node.locks.clear();
      if (node._queue) {
        node._queue.clear();
      }
      if (node._decoder) {
        node._decoder.destroy();
        node._decoder = null;
      }
      node.emitter.removeAllListeners();
      node.statusState = 'closed';
      node.statusDetail = 'Connection closed';
      if (node._transport) {
        const transport = node._transport;
        node._transport = null;
        transport
          .stop()
          .then(() => done())
          .catch(() => done());
      } else {
        done();
      }
    });
  }

  RED.nodes.registerType('mavlink-ai-connection', MavlinkAiConnectionNode);
};

// --- helpers ----------------------------------------------------------------

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) {
      return v;
    }
  }
  return undefined;
}

function describeListening(node, info) {
  if (node.transportType.startsWith('udp') || node.transportType === 'tcp-server') {
    return `Listening on ${node.bindAddress}:${node.bindPort}`;
  }
  if (node.transportType === 'serial') {
    return `Serial ${node.serialPath} @ ${node.serialBaud}`;
  }
  return `Connected to ${node.remoteHost}:${node.remotePort}`;
}

/**
 * Replace the runtime API with safe no-ops when the connection failed to
 * initialise, so regular nodes referencing it degrade gracefully instead of
 * throwing on every call.
 */
function registerNoop(node) {
  const rejected = (name) => () =>
    Promise.reject(new MavlinkError('CONNECTION_INVALID', `Connection '${node.name}' is not initialised (${name}).`));
  node.subscribe = () => -1;
  node.unsubscribe = () => false;
  node.resolveProfile = () => node.profile || null;
  node.getProfileForPacket = () => null;
  node.acquireLock = () => {
    throw new MavlinkError('CONNECTION_INVALID', `Connection '${node.name}' is not initialised.`);
  };
  node.releaseLock = () => false;
  node.send = rejected('send');
  node.sendRaw = rejected('sendRaw');
  node.on('close', (done) => done());
}
