'use strict';

const { EventEmitter } = require('events');
const { MavlinkCodec } = require('../lib/protocol/mavlink-codec');
const { createTransport } = require('../lib/transport');
const { PacketRouter } = require('../lib/routing/packet-router');
const { SubscriptionRegistry } = require('../lib/runtime/subscription-registry');
const { OutboundQueue } = require('../lib/runtime/outbound-queue');
const { LockManager } = require('../lib/runtime/lock-manager');
const { statusPayload } = require('../lib/util/status');
const { toInt, toBool, parseIdList, firstDefined } = require('../lib/util/validation');
const { MavlinkError, toMavlinkError, errorPayload } = require('../lib/util/errors');

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
    // Floor the interval so an imported/edited flow can't create a tight loop
    // that floods the outbound queue.
    node.heartbeatIntervalMs = Math.max(100, toInt(config.heartbeatIntervalMs, 1000));
    node.acceptedSysids = parseIdList(config.acceptedSysids);
    node.acceptedCompids = parseIdList(config.acceptedCompids);
    node.unmatchedPolicy = config.unmatchedPolicy || (node.routingMode === 'routed' ? 'reject' : 'default');

    node.emitter = new EventEmitter();
    node.emitter.setMaxListeners(0);
    // Default 'error' listener: an EventEmitter throws if an 'error' event is
    // emitted with no listeners. Surface runtime errors through the Node-RED
    // node log so they are observable instead of silently swallowed.
    node.emitter.on('error', (err) => {
      node.error(err && err.message ? err.message : err);
    });
    node.subscriptions = new SubscriptionRegistry();
    node.subscriptions.setErrorHandler((err) =>
      node.emitter.emit('error', toMavlinkError(err, 'SUBSCRIBER_ERROR'))
    );
    node.locks = new LockManager();
    node.statusState = 'idle';
    node.statusDetail = '';

    node._heartbeatTimer = null;
    node._decoder = null;
    node._transport = null;
    node._codec = null;
    node._router = null;
    node._queue = null;
    // Per-profile codec cache so routed connections decode each packet with the
    // matched profile's dialect (DESIGN.md / RELEASE_SCOPE §4), not the default.
    node._codecByProfile = new Map();

    // --- status helpers ------------------------------------------------------
    /**
     * Current connection status payload (§14.4).
     *
     * @returns {object}
     */
    node.getStatus = () =>
      statusPayload({
        node: 'mavlink-ai-connection',
        connection: node.name,
        state: node.statusState,
        transport: node.transportType,
        detail: node.statusDetail
      });

    /**
     * Update the connection state/detail and emit a `status` event.
     *
     * @param {string} state
     * @param {string} [detail]
     * @returns {void}
     */
    function setStatus(state, detail) {
      node.statusState = state;
      node.statusDetail = detail || '';
      node.emitter.emit('status', node.getStatus());
    }

    /**
     * Record a fatal init error and log it via the Node-RED node.
     *
     * @param {string} code
     * @param {string} message
     * @returns {void}
     */
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
      node._codecByProfile.set(node.profile.id, node._codec);
    } catch (err) {
      fatal('CODEC_INIT_FAILED', err.message);
      registerNoop(node);
      return;
    }

    /**
     * Resolve (and cache) the codec for a routed profile. Falls back to the
     * default codec for the default profile, for lightweight name-only route
     * targets, or for any profile whose dialect failed to load.
     *
     * @param {object} profile  resolved profile (config node or { name })
     * @returns {MavlinkCodec}
     */
    function getCodecForProfile(profile) {
      if (!profile || typeof profile.getDialect !== 'function' || !profile.isValid || !profile.isValid()) {
        return node._codec;
      }
      if (profile.id && node._codecByProfile.has(profile.id)) {
        return node._codecByProfile.get(profile.id);
      }
      let codec;
      try {
        codec = new MavlinkCodec(
          Object.assign({ bundle: profile.getDialect() }, profile.getProtocolOptions())
        );
      } catch (err) {
        return node._codec;
      }
      if (profile.id) {
        node._codecByProfile.set(profile.id, codec);
      }
      return codec;
    }

    // --- routing -------------------------------------------------------------
    /**
     * Resolve a route's profile reference (config-node id, name, or object) to
     * a profile. Falls back to a lightweight `{ name }` label for name-only
     * references so routed messages still carry the profile name.
     *
     * @param {string|object} ref
     * @returns {object} a profile node or `{ name }`
     */
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

    try {
      node._router = new PacketRouter({
        mode: node.routingMode,
        defaultProfile: node.profile,
        acceptedSysids: node.acceptedSysids,
        acceptedCompids: node.acceptedCompids,
        unmatched: node.unmatchedPolicy,
        routes: config.routeTable,
        resolveProfile: (ref) => node.resolveProfile(ref)
      });
    } catch (err) {
      fatal('ROUTE_TABLE_INVALID', err.message);
      registerNoop(node);
      return;
    }

    // --- public runtime API (DESIGN.md §12) ---------------------------------
    /**
     * Subscribe to decoded messages. See SubscriptionRegistry for filter shape.
     *
     * @param {object} filter
     * @param {function(object): void} callback
     * @returns {number} subscription id
     */
    node.subscribe = (filter, callback) => node.subscriptions.subscribe(filter, callback);
    /**
     * @param {number} id  subscription id from {@link subscribe}
     * @returns {boolean}
     */
    node.unsubscribe = (id) => node.subscriptions.unsubscribe(id);

    /**
     * Resolve which profile owns a packet identity, or null if rejected.
     *
     * @param {{sysid: number, compid: number}} packetOrHeader
     * @returns {?object}
     */
    node.getProfileForPacket = (packetOrHeader) => {
      const decision = node._router.route(packetOrHeader.sysid, packetOrHeader.compid);
      return decision.accepted ? decision.profile : null;
    };

    /**
     * Acquire a named runtime lock (e.g. mission workflow).
     *
     * @param {string} lockName
     * @param {string} owner
     * @returns {{release: function}}
     */
    node.acquireLock = (lockName, owner) => node.locks.acquire(lockName, owner);
    /**
     * @param {string} lockName
     * @param {string} owner
     * @returns {boolean}
     */
    node.releaseLock = (lockName, owner) => node.locks.release(lockName, owner);

    /**
     * Encode and enqueue a normalized outbound message (§14.2), filling target
     * defaults from the profile.
     *
     * @param {object} message  { name, fields, target_system?, target_component? }
     * @param {object} [options]  { priority }
     * @returns {Promise<void>}
     */
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
      // The addressed sysid rides along so a udp-peer transport can route the
      // packet to that vehicle's endpoint instead of the last sender (#21).
      return node._queue.enqueue(buffer, options.priority, { targetSystem });
    };

    /**
     * Enqueue a pre-encoded raw buffer for sending.
     *
     * @param {Buffer} buffer
     * @param {object} [options]  { priority }
     * @returns {Promise<void>}
     */
    node.sendRaw = (buffer, options = {}) => {
      if (!Buffer.isBuffer(buffer)) {
        return Promise.reject(new MavlinkError('BAD_RAW', 'Raw payload must be a Buffer.'));
      }
      return node._queue.enqueue(buffer, options.priority);
    };

    // --- inbound packet handling --------------------------------------------
    /**
     * Route, decode, and distribute one inbound packet (DESIGN.md §4):
     * route on the header, decode with the matched profile's dialect, then
     * dispatch to subscribers or emit a structured decode error.
     *
     * @param {MavLinkPacket} packet
     * @returns {void}
     */
    function onPacket(packet) {
      const header = packet.header;
      // Track the peer's wire version so an "auto" profile frames outbound
      // packets the way the peer speaks (a v1-only peer ignores v2 frames).
      node._codec.noteInboundMagic(header.magic);

      // 0. MAVLink 2 signature verification (issue #15). Wire authenticity is
      //    checked before routing/decoding: a frame that fails the connection
      //    profile's signing policy is rejected up front. Verification is a
      //    no-op (returns null) unless the profile enables it, so unsigned
      //    setups are unaffected.
      const sigDecision = node._codec.verifyInboundPacket(packet);
      if (sigDecision && !sigDecision.accepted) {
        node.emitter.emit('rejected', {
          sysid: header.sysid,
          compid: header.compid,
          reason: sigDecision.reason
        });
        return;
      }

      // 1. Route on the framed header (sysid/compid) before decoding.
      const decision = node._router.route(header.sysid, header.compid);
      if (!decision.accepted) {
        node.emitter.emit('rejected', { sysid: header.sysid, compid: header.compid, reason: decision.reason });
        return;
      }
      const profile = decision.profile || node.profile;
      const transportDescriptor = node._transport ? node._transport.descriptor : { type: node.transportType };

      // 2. Decode with the matched profile's dialect (routed connections may
      //    carry systems on different dialects).
      const codec = getCodecForProfile(profile);

      // 3. If the matched dialect has no definition for this message id, or
      //    decoding throws, emit a structured decode error with raw metadata
      //    instead of silently passing an undecodable packet.
      if (!codec.bundle.registry[header.msgid]) {
        emitDecodeError(header, codec, profile, packet, 'No message definition for this id in the matched dialect.');
        return;
      }
      let payload;
      try {
        payload = codec.decode(packet, {
          profile: profile ? profile.name : undefined,
          transport: transportDescriptor
        });
      } catch (err) {
        emitDecodeError(header, codec, profile, packet, err.message);
        return;
      }

      // `_buffer` carries the original wire bytes for subscribers that opt into
      // raw output. It is stripped before a decoded message leaves a node, so
      // it never pollutes the §14.1 contract.
      const message = { topic: `mavlink/${payload.name}`, payload, _buffer: packet.buffer };

      node.subscriptions.dispatch(message);
      node.emitter.emit('message', message);
      node.emitter.emit('raw', { topic: 'mavlink/raw', payload: packet.buffer });
    }

    /**
     * Emit a structured `decodeError` event with raw packet metadata when a
     * packet cannot be decoded with the matched dialect (DESIGN.md §4).
     *
     * @param {object} header  packet header (sysid/compid/msgid)
     * @param {MavlinkCodec} codec  the codec that failed
     * @param {object} profile  the matched profile
     * @param {MavLinkPacket} packet
     * @param {string} detail  human-readable cause
     * @returns {void}
     */
    function emitDecodeError(header, codec, profile, packet, detail) {
      const payload = errorPayload({
        node: 'mavlink-ai-connection',
        connection: node.name,
        code: 'DECODE_FAILED',
        message: `Unable to decode message id ${header.msgid} with dialect '${codec.bundle.name}': ${detail}`,
        context: {
          sysid: header.sysid,
          compid: header.compid,
          msgid: header.msgid,
          dialect: codec.bundle.name,
          profile: profile ? profile.name : undefined,
          raw: packet.buffer.toString('hex')
        }
      });
      node.emitter.emit('decodeError', { topic: 'mavlink/error', payload });
    }

    // --- heartbeat -----------------------------------------------------------
    /**
     * Start the periodic HEARTBEAT timer (background priority) using the
     * profile's heartbeat identity. No-op if heartbeat is disabled or running.
     *
     * @returns {void}
     */
    function startHeartbeat() {
      if (!node.heartbeatEnabled || node._heartbeatTimer) {
        return;
      }
      if (node.transportType === 'udp-in') {
        // Listen-only transport: sending can never succeed, so a heartbeat
        // timer would just log an error every tick forever.
        node.warn(
          `mavlink-ai-connection '${node.name || node.id}': heartbeat is enabled but transport udp-in is listen-only; not sending heartbeats.`
        );
        return;
      }
      /** Send one heartbeat; surface failures through the error emitter. */
      const tick = () => {
        node
          .send({ name: 'HEARTBEAT', fields: node.profile.getHeartbeatFields() }, { priority: 3 })
          .catch((err) => {
            // "No peer yet" is a normal udp-peer startup state (nothing has
            // sent to us, so there is nowhere to reply); logging it once per
            // tick until a vehicle appears is pure noise. Heartbeats resume
            // silently once a peer is learned.
            if (err && (err.code === 'UDP_NO_PEER' || err.code === 'TRANSPORT_NOT_READY')) {
              return;
            }
            node.emitter.emit('error', toMavlinkError(err, 'HEARTBEAT_FAILED'));
          });
      };
      node._heartbeatTimer = setInterval(tick, node.heartbeatIntervalMs);
      if (typeof node._heartbeatTimer.unref === 'function') {
        node._heartbeatTimer.unref();
      }
    }

    /**
     * Stop the heartbeat timer.
     *
     * @returns {void}
     */
    function stopHeartbeat() {
      if (node._heartbeatTimer) {
        clearInterval(node._heartbeatTimer);
        node._heartbeatTimer = null;
      }
    }

    // --- transport startup ---------------------------------------------------
    node._queue = new OutboundQueue(
      (buf, meta) => {
        // Guard against a failed/torn-down transport so sends reject cleanly
        // instead of throwing a TypeError on a null transport.
        if (!node._transport) {
          return Promise.reject(new MavlinkError('TRANSPORT_NOT_READY', 'Transport is not started.'));
        }
        return node._transport.send(buf, meta);
      },
      { enabled: toBool(config.outboundQueue, true) }
    );

    /**
     * Create the transport, wire its events to the decoder/status/heartbeat,
     * and start it.
     *
     * @returns {void}
     */
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
        node._transport = null;
        return;
      }

      // The splitter validates CRC against a magic-number table before routing,
      // so it must cover every routed profile's dialect — not just the default.
      // Otherwise message ids defined only by a routed (e.g. custom XML) dialect
      // are dropped silently inside the splitter. First profile wins on
      // conflicting ids: the default dialect keeps canonical CRCs and routed
      // custom dialects contribute only their new message ids (two dialects
      // redefining the same id with different layouts cannot share a splitter).
      // Built lazily on first data so route profiles registered after this
      // connection during the same deploy still contribute their tables.
      function buildMergedMagic() {
        const merged = {};
        for (const profile of node._router.profiles()) {
          const bundle = profile && typeof profile.getDialect === 'function' ? profile.getDialect() : null;
          if (!bundle || !bundle.valid) {
            continue;
          }
          for (const [id, magic] of Object.entries(bundle.magicNumbers)) {
            if (!(id in merged)) {
              merged[id] = magic;
            }
          }
        }
        return merged;
      }

      /** Create the decoder on first use, with the merged CRC table. */
      function ensureDecoder() {
        if (!node._decoder) {
          node._decoder = node._codec.createDecoder(
            onPacket,
            (err) => node.emitter.emit('error', toMavlinkError(err, 'DECODE_ERROR')),
            { magicNumbers: buildMergedMagic() }
          );
        }
        return node._decoder;
      }

      node._transport.on('data', (buffer) => {
        try {
          ensureDecoder().write(buffer);
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
        node._transport = null;
      }
    }

    startTransport();

    // --- lifecycle (DESIGN.md §19) ------------------------------------------
    node.on('close', function closeConnection(done) {
      stopHeartbeat();
      node.subscriptions.clear();
      node.locks.clear();
      node._codecByProfile.clear();
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

/**
 * Build a human-readable status detail describing what the transport bound to
 * or connected to.
 *
 * @param {object} node  the connection node
 * @param {object} info  transport listening/connected info
 * @returns {string}
 */
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
