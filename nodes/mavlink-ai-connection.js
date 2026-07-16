'use strict';

const { EventEmitter } = require('events');
const { MavLinkPacketSignature } = require('node-mavlink');
const { MavlinkCodec, verifyInboundPacket } = require('../lib/protocol/mavlink-codec');
const { LinkState } = require('../lib/protocol/link-state');
const { createTransport } = require('../lib/transport');
const { validateConnectionConfig } = require('../lib/transport/transport-fields');
const { PacketRouter } = require('../lib/routing/packet-router');
const { SubscriptionRegistry } = require('../lib/runtime/subscription-registry');
const { OutboundQueue } = require('../lib/runtime/outbound-queue');
const { LockManager } = require('../lib/runtime/lock-manager');
const { statusPayload } = require('../lib/util/status');
const { toInt, toBool, parseIdListStrict } = require('../lib/util/validation');
const { MavlinkError, toMavlinkError, errorPayload, TRANSPORT_NOT_READY_CODES } = require('../lib/util/errors');

/**
 * Minimum HEARTBEAT interval. HEARTBEAT is a low-rate presence/status message,
 * not a telemetry stream, so intervals below this are clamped (and warned about)
 * to keep an imported/edited flow from silently configuring an aggressive rate
 * that floods the outbound queue. The default remains 1000 ms.
 */
const HEARTBEAT_MIN_INTERVAL_MS = 1000;

/**
 * MAVLink 2 incompatibility flags this implementation understands. The spec
 * requires discarding any inbound frame that sets an incompat flag the receiver
 * doesn't implement. Today only MAVLINK_IFLAG_SIGNED (0x01) is handled (its
 * signature is verified per the default identity's policy); a frame setting any
 * other bit is rejected in onPacket rather than decoded with an unknown framing
 * (#153).
 */
const KNOWN_INCOMPAT_FLAGS = 0x01;

/**
 * Stream key for transports that multiplex a single peer's byte stream (udp,
 * serial, tcp-client). They share one decoder; only tcp-server hands out a
 * per-client `clientId` so each client gets its own stream splitter (#147).
 */
const SHARED_STREAM_KEY = '__shared__';

/**
 * Send-rejection codes the periodic heartbeat treats as normal idle/teardown
 * states (see the heartbeat tick's catch): logged nowhere, retried silently on
 * the next tick. Shared with the Out node (which badges "waiting for link"
 * instead of erroring) via the errors util.
 *
 * @type {Set<string>}
 */
const HEARTBEAT_EXPECTED_IDLE_CODES = TRANSPORT_NOT_READY_CODES;

/**
 * Ceiling on live per-client stream decoders. `peer-disconnect` evicts a
 * client's decoder as soon as its socket closes, but this bounds memory if a
 * burst of short-lived tcp-server clients ever churns faster than eviction
 * (#147). Real deployments have a handful of GCS/bridge clients.
 */
const MAX_STREAM_DECODERS = 256;

/**
 * Upper bound on how long the close handler waits for a transport stop() to
 * settle before signalling Node-RED anyway (issue #140). A socket or server
 * whose close() callback never fires would otherwise leave the deploy hung; a
 * bounded wait turns that into a clean (if slightly delayed) close. Stays well
 * under Node-RED's own close timeout so this fallback wins first.
 */
const CLOSE_STOP_TIMEOUT_MS = 5000;

/**
 * True if a resolved reference is a mavlink-ai-local-identity config node.
 *
 * @param {*} n
 * @returns {boolean}
 */
function isIdentityNode(n) {
  return !!n && typeof n.getIdentity === 'function' && typeof n.getHeartbeatFields === 'function';
}

/**
 * True if a resolved reference is a mavlink-ai-vehicle (Vehicle Profile)
 * config node.
 *
 * @param {*} n
 * @returns {boolean}
 */
function isProfileNode(n) {
  return !!n && typeof n.getDialect === 'function';
}

/**
 * mavlink-ai-connection (DESIGN.md §8, §11, §19; issue #228).
 *
 * The connection config node owns the wire and everything channel-scoped:
 * transport/session, inbound routing, the subscription registry, the outbound
 * queue, heartbeat scheduling, mission locks, MAVLink 2 signing (the shared key,
 * the sign/verify/require policy, and the link id), and the {@link LinkState}
 * carrying sequence / signing-timestamp / replay / detected-version state (#192).
 * All state is scoped to the instance — no module-level singletons.
 *
 * Encoding composes three independently resolved inputs (#228):
 *
 *   Vehicle Profile -> dialect, message definitions, target defaults
 *   Local Identity  -> source ids, heartbeat fields
 *   Connection      -> transport, queue, signing, link id, channel state
 *
 * A connection references exactly one required **default Local Identity**.
 * Additional identities may transmit on this link only through the explicit,
 * disabled-by-default multi-identity binding list — and a Vehicle Profile can
 * never determine or change the local identity.
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
    // Clamp the interval to a safe minimum so an imported/edited flow can't
    // silently configure an aggressive HEARTBEAT rate (e.g. 100 ms / 10 Hz).
    // Warn when clamping so the misconfiguration is visible instead of hidden.
    const requestedHeartbeatMs = toInt(config.heartbeatIntervalMs, HEARTBEAT_MIN_INTERVAL_MS);
    node.heartbeatIntervalMs = Math.max(HEARTBEAT_MIN_INTERVAL_MS, requestedHeartbeatMs);
    if (requestedHeartbeatMs < HEARTBEAT_MIN_INTERVAL_MS) {
      node.warn(
        `heartbeat interval ${requestedHeartbeatMs} ms is below the ${HEARTBEAT_MIN_INTERVAL_MS} ms minimum; clamping to ${HEARTBEAT_MIN_INTERVAL_MS} ms.`
      );
    }
    /**
     * Accept-filter ids are parsed strictly (#193): a typo like "1O" or a
     * mixed "1,2x" must fail the connection closed, not silently widen the
     * accept filter to everything (parseIdList drops bad tokens → []  = accept
     * all). The fatal() below turns an invalid list into an inert connection.
     */
    const acceptedSysids = parseIdListStrict(config.acceptedSysids);
    const acceptedCompids = parseIdListStrict(config.acceptedCompids);
    node.acceptedSysids = acceptedSysids.ids;
    node.acceptedCompids = acceptedCompids.ids;
    node._acceptFilterInvalid =
      acceptedSysids.invalid.length || acceptedCompids.invalid.length
        ? [...acceptedSysids.invalid.map((t) => `sysid '${t}'`), ...acceptedCompids.invalid.map((t) => `compid '${t}'`)]
        : null;
    node.unmatchedPolicy = config.unmatchedPolicy || (node.routingMode === 'routed' ? 'reject' : 'default');

    /**
     * Multi-identity transmission is an explicit opt-in (#228): additional
     * identity bindings are inert unless this is enabled, so a runtime can
     * never stumble into acting as several MAVLink participants.
     */
    node.allowMultipleIdentities = toBool(config.allowMultipleIdentities, false);

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

    /**
     * Per-identity heartbeat timers, keyed by identity config-node id. The
     * default identity's heartbeat comes from the connection's Heartbeat
     * setting; each additional binding opts into its own (#228).
     */
    node._heartbeatTimers = new Map();
    /**
     * Stream decoders keyed by stream identity: `SHARED_STREAM_KEY` for
     * single-peer transports, or a tcp-server client's `clientId` so two
     * clients' interleaved bytes never corrupt each other's framing (#147).
     */
    node._decoders = new Map();
    node._transport = null;
    node._codec = null;
    node._router = null;
    node._queue = null;
    /**
     * Channel/session state for this link (#192): outbound sequence numbers per
     * local identity, monotonic signing timestamps per (identity, link id)
     * stream, inbound replay memory per verification key, and per-peer detected
     * wire versions. Lives exactly as long as the transport/session — it is
     * never reset by a profile or identity edit, only by deactivation.
     */
    node._link = new LinkState();
    /**
     * Whether this connection is live. A connection whose required default
     * profile or default Local Identity is missing/invalid fails closed
     * (#116, #228): it is marked inactive, its transport is released, and new
     * sends reject until a valid configuration is restored on a later deploy.
     */
    node._active = false;
    /** The structured error describing why the connection is inactive, if it is. */
    node._inactiveError = null;
    /**
     * Set by {@link reactivate}: a promise that settles once a restored
     * configuration's transport restart has been attempted. Null until a
     * reactivation.
     *
     * @type {?Promise<void>}
     */
    node._activating = null;
    /**
     * Per-profile codec cache so routed connections decode each packet with the
     * matched profile's dialect (DESIGN.md / RELEASE_SCOPE §4), not the default.
     * Keyed by profile config-node id, but each entry retains the *profile
     * object* it was built from ({ profile, codec }). Node-RED recreates an
     * edited profile as a new object under the same id, so a cache keyed by id
     * alone would keep handing back the codec for the old dialect (#117); the
     * entry is only reused when its profile object is still the resolved one.
     *
     * Codecs are dialect-scoped only (#192): identity, sequence, and signing
     * state are supplied per encode() call, so one cached codec serves every
     * local identity transmitting through this connection.
     */
    node._codecByProfile = new Map();
    /**
     * The set of profile *objects* whose dialects currently feed the decoder's
     * merged CRC table (default + resolved routes). When this set changes across
     * a deploy — a routed profile edited, added, or removed — the decoder must
     * be reset so its splitter CRC table is rebuilt (#117).
     */
    node._activeProfiles = new Set();

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

    // --- required default profile / identity ---------------------------------
    if (node._acceptFilterInvalid) {
      fatal(
        'ACCEPT_FILTER_INVALID',
        `Accepted sysid/compid filter has invalid ids (${node._acceptFilterInvalid.join(', ')}); ` +
          'each must be blank/*/any/all or an integer 0-255. Refusing to start rather than accept everything.'
      );
      registerNoop(node);
      return;
    }

    /**
     * A DEPENDENCY failure — missing/invalid Vehicle Profile or Local Identity,
     * or a codec that can't build from the profile — must not no-op this node:
     * those heal on a later deploy without this connection's own config ever
     * changing (the profile/identity is fixed or re-created under the same id),
     * and a no-op'ed node never installs the flows:started reconcile, staying
     * permanently dead until a manual redeploy (#238). Instead the connection
     * constructs DEACTIVATED with its full runtime API and reconcile listener;
     * reconcileRequiredConfig() then reactivate()s it once the dependency is
     * back. Own-config failures (accept filter, link id, signing, bindings,
     * route table, transport config) still no-op — fixing them means editing
     * this node, which redeploys it anyway. The first failure wins the recorded
     * reason; the reconcile re-checks everything on each deploy regardless.
     */
    let startInactive = null;
    if (!node.profile) {
      fatal('NO_PROFILE', 'Connection has no Vehicle Profile configured.');
      startInactive = { code: 'NO_PROFILE', message: 'Connection has no Vehicle Profile configured.' };
    } else if (!node.profile.isValid()) {
      const err = node.profile.getError();
      const code = (err && err.code) || 'PROFILE_INVALID';
      const message = `Vehicle Profile invalid: ${err && err.message}`;
      fatal(code, message);
      startInactive = { code, message };
    }

    /**
     * The required default Local Identity (#228). Every transmitted message
     * must resolve to exactly one permitted identity; without a default there
     * is nothing safe to resolve to, so the connection fails closed with an
     * actionable error instead of guessing (e.g. from a Vehicle Profile).
     */
    node.localIdentity = config.localIdentity ? RED.nodes.getNode(config.localIdentity) : null;
    if (!isIdentityNode(node.localIdentity)) {
      const legacyHint = config.profile && config.localIdentity === undefined
        ? ' (Flows created before v3 stored the local identity on the profile; that coupling was removed — ' +
          'create a Local Identity carrying the old profile’s Source SysID/CompID and signing settings.)'
        : '';
      const message =
        `Connection '${node.name || node.id}' has no Local Identity. Select one in Connection > Local Identity. ` +
        `If none exists, create a GCS, Companion, or Custom Local Identity first.${legacyHint}`;
      fatal('LOCAL_IDENTITY_REQUIRED', message);
      if (!startInactive) {
        startInactive = { code: 'LOCAL_IDENTITY_REQUIRED', message };
      }
    } else if (!node.localIdentity.isValid()) {
      const err = node.localIdentity.getError();
      const message = `Local Identity '${node.localIdentity.name || node.localIdentity.id}' is invalid: ${err && err.message}`;
      fatal('LOCAL_IDENTITY_INVALID', message);
      if (!startInactive) {
        startInactive = { code: 'LOCAL_IDENTITY_INVALID', message };
      }
    }

    /**
     * The connection-owned signing link id (#192): link ids identify channels,
     * so it lives here — one identity/credential reused on two links no longer
     * silently shares a link id. A uint8; wrapping an out-of-range value would
     * turn a config mistake into a *different* valid link id (#90), so reject.
     */
    node.signingLinkId = 0;
    if (config.signingLinkId !== undefined && config.signingLinkId !== null && config.signingLinkId !== '') {
      const linkId = Number(config.signingLinkId);
      if (!Number.isInteger(linkId) || linkId < 0 || linkId > 255) {
        fatal(
          'SIGNING_BAD_LINK_ID',
          `Signing link ID must be an integer in [0, 255] (got ${JSON.stringify(config.signingLinkId)}).`
        );
        registerNoop(node);
        return;
      }
      node.signingLinkId = linkId;
    }

    /**
     * MAVLink 2 signing lives on the Connection. A MAVLink link has exactly one
     * signing key shared by both endpoints, so the credential is a property of
     * the secured link — not of an identity that may transmit on several links.
     * This lets one identity talk signed on one connection and unsigned on
     * another (a GCS to a mix of secured and open fleets). The passphrase is a
     * Node-RED credential so it is never written into exported flow JSON.
     */
    node.signOutbound = toBool(config.signOutbound, false);
    node.verifyInbound = toBool(config.verifyInbound, false);
    node.requireSignature = toBool(config.requireSignature, false);
    const signingPassphrase = (node.credentials && node.credentials.signingPassphrase) || '';
    if (node.signOutbound && !signingPassphrase) {
      fatal(
        'SIGNING_NO_PASSPHRASE',
        "'Sign outbound' is enabled but no signing passphrase is set — refusing to start rather than send every frame unsigned while the operator believes traffic is authenticated."
      );
      registerNoop(node);
      return;
    }
    /**
     * The 32-byte signing key derived from the passphrase (SHA-256, the same
     * derivation Mission Planner / QGroundControl use), or null when none is set.
     */
    node._signingKey = signingPassphrase ? MavLinkPacketSignature.key(signingPassphrase) : null;

    /**
     * The signing policy for this connection, or null when signing is entirely
     * off. 'Require signature' is fail-closed and meaningless without
     * verification, so it implies inbound verification (#70).
     *
     * @returns {?{key: ?Buffer, signOutbound: boolean, verifyInbound: boolean,
     *   requireSignature: boolean}}
     */
    node.getSigningPolicy = () => {
      const verifyInbound = node.verifyInbound || node.requireSignature;
      if (!node._signingKey && !node.signOutbound && !verifyInbound) {
        return null;
      }
      return {
        key: node._signingKey,
        signOutbound: node.signOutbound,
        verifyInbound,
        requireSignature: node.requireSignature
      };
    };

    /**
     * Additional Local Identity binding specs (#228): the advanced, explicit
     * list of extra identities this connection may transmit as. Each entry
     * references an identity config node and carries per-binding permissions:
     * { identity, allowOutbound (default true), heartbeat (default false),
     * heartbeatIntervalMs (default 1000, clamped) }. References resolve lazily
     * (the identity nodes may register after this connection within a deploy).
     */
    node._identityBindings = [];
    try {
      node._identityBindings = parseIdentityBindings(config.additionalIdentities);
    } catch (err) {
      fatal('ADDITIONAL_IDENTITIES_INVALID', err.message);
      registerNoop(node);
      return;
    }
    if (node._identityBindings.length && !node.allowMultipleIdentities) {
      node.warn(
        `Connection '${node.name || node.id}' lists ${node._identityBindings.length} additional Local Identity ` +
          'binding(s) but multi-identity transmission is disabled; they are inert until ' +
          "'Allow this connection to transmit as multiple local identities' is enabled."
      );
    }

    if (!startInactive) {
      try {
        node._codec = buildCodec(node.profile);
        node._codecByProfile.set(node.profile.id, { profile: node.profile, codec: node._codec });
      } catch (err) {
        fatal('CODEC_INIT_FAILED', err.message);
        /** Profile-derived: a fixed/re-created profile heals this on reconcile. */
        startInactive = { code: 'CODEC_INIT_FAILED', message: err.message };
      }
    }

    // Reject an impossible transport/settings combination loudly at deploy
    // (issue #103): e.g. udp-out or tcp-client with no remote endpoint, or
    // serial with no device path. The editor validates the same rules before
    // deploy, but a flow imported as JSON (or authored before those validators
    // existed) can still carry a blank required field — surface it here instead
    // of only failing later on the first send with a runtime code like
    // UDP_NO_PEER.
    // Validate against the raw config values (not the `node.*` copies): numeric
    // fields like bindPort have a default applied on `node.*` that would mask a
    // user-cleared blank, so a required-but-blank field must be seen pre-default.
    const transportProblems = validateConnectionConfig({
      transport: node.transportType,
      bindAddress: config.bindAddress,
      bindPort: config.bindPort,
      remoteHost: config.remoteHost,
      remotePort: config.remotePort,
      serialPath: config.serialPath,
      serialBaud: config.serialBaud
    });
    if (transportProblems.length) {
      fatal('TRANSPORT_CONFIG_INVALID', transportProblems.map((p) => p.message).join(' '));
      registerNoop(node);
      return;
    }

    /**
     * Build a dialect codec for a Vehicle Profile. Codecs carry no identity or
     * channel state (#192) — just the dialect bundle and the profile's version
     * preference.
     *
     * @param {object} profile  a valid Vehicle Profile config node
     * @returns {MavlinkCodec}
     */
    function buildCodec(profile) {
      return new MavlinkCodec({ bundle: profile.getDialect(), version: profile.mavlinkVersion });
    }

    /**
     * Resolve (and cache) the codec for a resolved profile. The default
     * profile uses the connection codec; any other profile must be a valid
     * profile config node — an invalid dialect or a failed codec build throws
     * instead of silently falling back to the default codec, which would
     * decode/encode with the wrong dialect while claiming the profile.
     *
     * @param {object} profile  a resolved profile config node
     * @returns {MavlinkCodec}
     * @throws {MavlinkError} PROFILE_INVALID | CODEC_INIT_FAILED
     */
    function getCodecForProfile(profile) {
      if (!profile || profile === node.profile) {
        return node._codec;
      }
      /**
       * Reuse the cached codec only when it was built from *this same* profile
       * object. If Node-RED recreated the profile under the same id (an edit) or
       * a different profile now owns the id, the identity check misses and a
       * fresh codec is built for the new dialect instead of decoding/encoding
       * with the stale one (#117).
       */
      if (profile.id && node._codecByProfile.has(profile.id)) {
        const entry = node._codecByProfile.get(profile.id);
        if (entry.profile === profile) {
          return entry.codec;
        }
        node._codecByProfile.delete(profile.id);
      }
      if (!isProfileNode(profile) || !profile.isValid || !profile.isValid()) {
        const detail = profile.getError && profile.getError() ? `: ${profile.getError().message}` : '';
        throw new MavlinkError(
          'PROFILE_INVALID',
          `Vehicle Profile '${profile.name || profile.id}' has no valid dialect${detail}`
        );
      }
      let codec;
      try {
        codec = buildCodec(profile);
      } catch (err) {
        throw new MavlinkError(
          'CODEC_INIT_FAILED',
          `Cannot build codec for Vehicle Profile '${profile.name || profile.id}': ${err.message}`
        );
      }
      if (profile.id) {
        node._codecByProfile.set(profile.id, { profile, codec });
      }
      return codec;
    }

    /**
     * The vehicle-profile reference carried on an outbound message. The
     * canonical field is `vehicleProfile` (#228); `profile` is accepted as a
     * documented deprecated alias for pre-v3 flows. Setting both to different
     * values is a conflict — silently picking one could encode with the wrong
     * dialect while claiming the other.
     *
     * @param {object} message
     * @returns {*} the reference (may be undefined/blank for "use default")
     * @throws {MavlinkError} VEHICLE_PROFILE_CONFLICT
     */
    function vehicleProfileRef(message) {
      const canonical = message.vehicleProfile;
      const legacy = message.profile;
      const has = (v) => v !== undefined && v !== null && v !== '';
      if (has(canonical) && has(legacy) && canonical !== legacy) {
        throw new MavlinkError(
          'VEHICLE_PROFILE_CONFLICT',
          `Outbound message sets both vehicleProfile ('${canonical}') and the deprecated profile alias ('${legacy}') ` +
            'to different values. Set only vehicleProfile.'
        );
      }
      return has(canonical) ? canonical : legacy;
    }

    /**
     * Resolve the effective Vehicle Profile for an outbound message. No
     * reference means the connection's default profile. An explicit reference
     * must resolve to a real, valid profile config node — silently falling
     * back to the default would encode with the wrong dialect, version, and
     * target defaults, which is exactly the failure the reference exists to
     * prevent (#68). It can never influence the local identity (#228).
     *
     * @param {string|object} [profileRef]
     * @returns {object} a valid profile config node
     * @throws {MavlinkError} PROFILE_UNRESOLVED | PROFILE_AMBIGUOUS | PROFILE_INVALID
     */
    function resolveOutboundProfile(profileRef) {
      if (profileRef === undefined || profileRef === null || profileRef === '') {
        return node.profile;
      }
      // resolveProfile() is strict: it returns a real profile config node or
      // throws PROFILE_UNRESOLVED / PROFILE_AMBIGUOUS. The only remaining check
      // here is whether that resolved profile's dialect actually loaded.
      const profile = node.resolveProfile(profileRef);
      if (!profile.isValid()) {
        const err = profile.getError && profile.getError();
        throw new MavlinkError(
          'PROFILE_INVALID',
          `Outbound message names Vehicle Profile '${profile.name || profile.id}' whose dialect failed to load${err ? `: ${err.message}` : '.'}`,
          { profile: profile.name || profile.id }
        );
      }
      return profile;
    }

    // --- local identity resolution (#228) -------------------------------------
    /**
     * Memoized identity name -> config-node id resolutions, mirroring
     * profileByName below: successful unique-name lookups only, re-verified on
     * every use, cleared on every deploy.
     */
    const identityByName = new Map();

    /**
     * Resolve a Local Identity reference to an identity config node. The
     * canonical reference is the config-node id; a plain name is accepted when
     * exactly one identity config node has that name.
     *
     * This resolves *existence* only — whether the identity may transmit on
     * this connection is decided by {@link node.resolveOutboundIdentity}.
     *
     * @param {string|object} ref  config-node id, unique identity name, or an
     *   identity node object
     * @returns {object} an identity config node
     * @throws {MavlinkError} LOCAL_IDENTITY_UNRESOLVED | LOCAL_IDENTITY_AMBIGUOUS
     */
    node.resolveLocalIdentity = (ref) => {
      if (!ref) {
        return node.localIdentity;
      }
      if (typeof ref === 'object') {
        if (isIdentityNode(ref)) {
          return ref;
        }
        throw new MavlinkError(
          'LOCAL_IDENTITY_UNRESOLVED',
          `Local Identity reference ${JSON.stringify(ref && ref.name ? ref.name : ref)} is not a mavlink-ai-local-identity config node.`
        );
      }
      const byId = RED.nodes.getNode(ref);
      if (isIdentityNode(byId)) {
        return byId;
      }
      if (identityByName.has(ref)) {
        const cached = RED.nodes.getNode(identityByName.get(ref));
        if (isIdentityNode(cached) && cached.name === ref) {
          return cached;
        }
        identityByName.delete(ref);
      }
      const matchIds = [];
      if (typeof RED.nodes.eachNode === 'function') {
        RED.nodes.eachNode((n) => {
          if (n.type === 'mavlink-ai-local-identity' && n.name === ref) {
            matchIds.push(n.id);
          }
        });
      } else if (node.localIdentity && node.localIdentity.name === ref) {
        matchIds.push(node.localIdentity.id);
      }
      if (matchIds.length > 1) {
        throw new MavlinkError(
          'LOCAL_IDENTITY_AMBIGUOUS',
          `The requested Local Identity name '${ref}' matches ${matchIds.length} config nodes. ` +
            'Use the config-node ID or rename the identities so each name is unique.'
        );
      }
      const byName = matchIds.length === 1 ? RED.nodes.getNode(matchIds[0]) : null;
      if (isIdentityNode(byName)) {
        identityByName.set(ref, byName.id);
        return byName;
      }
      throw new MavlinkError(
        'LOCAL_IDENTITY_UNRESOLVED',
        `Local Identity '${ref}' does not match any mavlink-ai-local-identity config node (by id or unique name).`
      );
    };

    /**
     * The binding spec attached to an identity on this connection, or null.
     * Binding references resolve lazily so an identity registered later in the
     * same deploy still matches.
     *
     * @param {object} identity  a resolved identity config node
     * @returns {?object} the binding spec
     */
    function bindingFor(identity) {
      for (const spec of node._identityBindings) {
        try {
          const resolved = node.resolveLocalIdentity(spec.identity);
          if (resolved === identity || resolved.id === identity.id) {
            return spec;
          }
        } catch (e) {
          /** An unresolved binding matches nothing; reported by validation. */
        }
      }
      return null;
    }

    /**
     * Resolve the Local Identity an outbound message transmits as (#228).
     *
     * Resolution order — and, critically, what it never does:
     *
     *  1. No explicit reference -> the connection's default Local Identity.
     *  2. An explicit reference resolves strictly (id, unique name, or node) —
     *     never falls back to the default on failure.
     *  3. The resolved identity must be attached to this connection: the
     *     default, or an additional binding with outbound permission while
     *     multi-identity transmission is enabled.
     *  4. The local identity is never derived from a Vehicle Profile.
     *
     * @param {string|object} [ref]  message.localIdentity
     * @returns {object} a valid, attached identity config node
     * @throws {MavlinkError} LOCAL_IDENTITY_UNRESOLVED | LOCAL_IDENTITY_AMBIGUOUS |
     *   LOCAL_IDENTITY_INVALID | LOCAL_IDENTITY_NOT_ATTACHED | MULTI_IDENTITY_DISABLED
     */
    node.resolveOutboundIdentity = (ref) => {
      /**
       * A connection constructed (or deactivated) on a dependency failure keeps
       * its live API with a missing OR invalid default identity (#238).
       * Workflows call this before send() and use the result's source ids for
       * ack matching, so an unusable default must throw the structured stored
       * reason here — never return null (a TypeError that leaks workflow locks)
       * or an invalid identity (fallback source ids that mismatch every ack).
       * The explicit-ref path below also compares against the default, so the
       * guard covers both. An ACTIVE connection always has a valid default
       * (construction and the reconcile guarantee it), so this never fires on a
       * healthy link.
       */
      const dflt = node.localIdentity;
      if (!isIdentityNode(dflt) || (typeof dflt.isValid === 'function' && !dflt.isValid())) {
        const e = node._inactiveError;
        if (e) {
          throw new MavlinkError(e.code, e.message, e.context);
        }
        throw !isIdentityNode(dflt)
          ? new MavlinkError(
              'LOCAL_IDENTITY_REQUIRED',
              `Connection '${node.name || node.id}' has no default Local Identity.`
            )
          : new MavlinkError(
              'LOCAL_IDENTITY_INVALID',
              `Local Identity '${dflt.name || dflt.id}' is invalid.`
            );
      }
      if (ref === undefined || ref === null || ref === '') {
        return node.localIdentity;
      }
      const identity = node.resolveLocalIdentity(ref);
      if (!identity.isValid()) {
        const err = identity.getError && identity.getError();
        throw new MavlinkError(
          'LOCAL_IDENTITY_INVALID',
          `Local Identity '${identity.name || identity.id}' is invalid${err ? `: ${err.message}` : '.'}`
        );
      }
      if (identity === node.localIdentity || identity.id === node.localIdentity.id) {
        return identity;
      }
      if (!node.allowMultipleIdentities) {
        throw new MavlinkError(
          'MULTI_IDENTITY_DISABLED',
          `This message requested a non-default Local Identity, but multi-identity transmission is disabled for ` +
            `Connection '${node.name || node.id}'. Enable Connection > Advanced > Allow multiple local identities ` +
            'only if this Node-RED runtime is intentionally acting as multiple MAVLink participants.'
        );
      }
      const binding = bindingFor(identity);
      if (!binding || binding.allowOutbound === false) {
        throw new MavlinkError(
          'LOCAL_IDENTITY_NOT_ATTACHED',
          `This message requested Local Identity '${identity.describe()}', but Connection '${node.name || node.id}' ` +
            `only permits '${node.localIdentity.describe()}'${describeBindings(node)}. Add the identity under ` +
            'Connection > Advanced > Additional Local Identities, or remove the message identity override.'
        );
      }
      return identity;
    };

    /** @returns {object} the connection's default Local Identity node */
    node.getDefaultIdentity = () => node.localIdentity;

    /** @returns {number} how many additional identity bindings are configured */
    node.identityBindingCount = () => node._identityBindings.length;

    /**
     * Every identity currently attached to this connection: the default plus
     * each resolvable additional binding (when multi-identity is enabled).
     *
     * @returns {Array<{identity: object, binding: ?object}>}
     */
    function attachedIdentities() {
      const out = [{ identity: node.localIdentity, binding: null }];
      if (!node.allowMultipleIdentities) {
        return out;
      }
      const seen = new Set([node.localIdentity.id]);
      for (const spec of node._identityBindings) {
        try {
          const identity = node.resolveLocalIdentity(spec.identity);
          if (!seen.has(identity.id)) {
            seen.add(identity.id);
            out.push({ identity, binding: spec });
          }
        } catch (e) {
          /** Unresolved bindings are reported by validateIdentityBindings. */
        }
      }
      return out;
    }

    /**
     * Validate the attached identity set (#228): every binding must resolve to
     * a valid identity, and no two attached identities may share a source
     * (sysid, compid) — such senders are indistinguishable on the wire, so the
     * configuration fails closed rather than transmitting ambiguously.
     *
     * @param {boolean} [reportProblems=false]  also error-log unresolved or
     *   invalid bindings. Only the flows:started reconcile passes true: at
     *   construction time an identity referenced solely from the binding JSON
     *   may simply not have registered yet within the same deploy, so
     *   reporting then would false-alarm. (Unresolved bindings reject their
     *   own sends regardless.)
     * @returns {?MavlinkError} a LOCAL_IDENTITY_COLLISION error, or null; other
     *   problems are logged loudly but only reject their own sends
     */
    function validateIdentityBindings(reportProblems = false) {
      if (node.allowMultipleIdentities && reportProblems) {
        for (const spec of node._identityBindings) {
          try {
            const identity = node.resolveLocalIdentity(spec.identity);
            if (!identity.isValid()) {
              const err = identity.getError && identity.getError();
              node.error(
                `mavlink-ai-connection '${node.name || node.id}': additional Local Identity ` +
                  `'${identity.name || identity.id}' is invalid${err ? `: ${err.message}` : '.'} ` +
                  'Sends requesting it will be rejected.'
              );
            }
          } catch (err) {
            node.error(
              `mavlink-ai-connection '${node.name || node.id}': additional Local Identity binding ` +
                `'${typeof spec.identity === 'object' ? JSON.stringify(spec.identity) : spec.identity}' ` +
                `does not resolve: ${err.message} Sends requesting it will be rejected.`
            );
          }
        }
      }
      const byWireId = new Map();
      for (const { identity } of attachedIdentities()) {
        if (!identity.isValid || !identity.isValid()) {
          continue;
        }
        const { sysid, compid } = identity.getIdentity();
        const key = `${sysid}:${compid}`;
        const existing = byWireId.get(key);
        if (existing && existing.id !== identity.id) {
          return new MavlinkError(
            'LOCAL_IDENTITY_COLLISION',
            `Connection '${node.name || node.id}' attaches two Local Identities using source SysID ${sysid} / ` +
              `CompID ${compid} ('${existing.name || existing.id}' and '${identity.name || identity.id}'). ` +
              'Those senders are indistinguishable on this link. Remove one binding or assign a unique component ID.'
          );
        }
        byWireId.set(key, identity);
      }
      return null;
    }

    if (!startInactive) {
      /**
       * Binding collisions are own-config and stay fatal — but the check needs
       * a resolved default identity, so when construction is already deferred
       * on a missing/invalid dependency it is skipped here and re-run by
       * reconcileRequiredConfig (with reporting) before any reactivation, which
       * refuses to bring the connection up while a collision exists (#238).
       */
      const collision = validateIdentityBindings();
      if (collision) {
        fatal(collision.code, collision.message);
        registerNoop(node);
        return;
      }
    }

    /**
     * The inbound signature-verification policy: the connection's signing
     * config. The anti-replay memory is link state keyed by the verification
     * key, so a profile/identity rebuild under the same key cannot reset it (#192).
     *
     * @returns {?object} policy for {@link verifyInboundPacket}, or null
     */
    function inboundPolicy() {
      const policy = node.getSigningPolicy();
      if (!policy || !policy.verifyInbound) {
        return null;
      }
      return {
        verifyInbound: true,
        requireSignature: policy.requireSignature,
        key: policy.key,
        replay: policy.key ? node._link.replayTrackerFor(policy.key) : null
      };
    }

    // --- routing -------------------------------------------------------------
    /**
     * Memoized legacy name -> profile config-node *id* resolutions (a name
     * lookup scans all config nodes; packets arrive at wire rate). The cache
     * stores the resolved id, never the profile object: every use re-resolves
     * the id through RED.nodes.getNode() and re-checks the name, so a profile
     * that was deleted, renamed, disabled, or recreated stops resolving to its
     * stale object immediately (#118). Successful lookups only — a profile
     * deployed later must still become resolvable — and the whole cache is
     * cleared on every flows:started so a name that became ambiguous (a second
     * profile now shares it) is re-scanned rather than served from a stale
     * unique result.
     */
    const profileByName = new Map();

    /**
     * Resolve a profile reference to a profile config node. The canonical
     * reference in route entries and internal messages is the profile
     * config-node id; a plain profile name is accepted for backward
     * compatibility when exactly one profile config node has that name.
     *
     * An explicitly requested profile that cannot be resolved throws — never
     * falls back to the default profile (a routed packet must not be decoded
     * or encoded with a dialect other than the one its route names).
     *
     * @param {string|object} ref  config-node id, unique profile name, or a
     *   profile object; blank means the connection's default profile
     * @returns {object} a profile config node
     * @throws {MavlinkError} PROFILE_UNRESOLVED | PROFILE_AMBIGUOUS
     */
    node.resolveProfile = (ref) => {
      if (!ref) {
        return node.profile;
      }
      if (typeof ref === 'object') {
        if (isProfileNode(ref)) {
          return ref;
        }
        throw new MavlinkError(
          'PROFILE_UNRESOLVED',
          `Vehicle Profile reference ${JSON.stringify(ref && ref.name ? ref.name : ref)} is not a mavlink-ai-vehicle config node.`
        );
      }
      const byId = RED.nodes.getNode(ref);
      if (isProfileNode(byId)) {
        return byId;
      }
      /**
       * Legacy name reference (flows authored before route entries carried
       * config-node ids). Resolve only an unambiguous name.
       *
       * A cached id is only trusted after re-resolving it and confirming the
       * currently registered node still carries this name — a deleted or
       * renamed profile must not keep resolving to its old object (#118). A
       * stale entry is dropped so the scan below runs fresh.
       */
      if (profileByName.has(ref)) {
        const cached = RED.nodes.getNode(profileByName.get(ref));
        if (isProfileNode(cached) && cached.name === ref) {
          return cached;
        }
        profileByName.delete(ref);
      }
      const matchIds = [];
      if (typeof RED.nodes.eachNode === 'function') {
        RED.nodes.eachNode((n) => {
          if (n.type === 'mavlink-ai-vehicle' && n.name === ref) {
            matchIds.push(n.id);
          }
        });
      } else if (node.profile && node.profile.name === ref) {
        matchIds.push(node.profile.id);
      }
      if (matchIds.length > 1) {
        throw new MavlinkError(
          'PROFILE_AMBIGUOUS',
          `Vehicle Profile name '${ref}' matches ${matchIds.length} profile config nodes; reference the profile by config-node id.`
        );
      }
      const byName = matchIds.length === 1 ? RED.nodes.getNode(matchIds[0]) : null;
      if (isProfileNode(byName)) {
        profileByName.set(ref, byName.id);
        return byName;
      }
      throw new MavlinkError(
        'PROFILE_UNRESOLVED',
        `Vehicle Profile '${ref}' does not match any mavlink-ai-vehicle config node (by id or unique name).`
      );
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

    /**
     * Routed mode with an empty route table and the default 'reject' policy
     * rejects every inbound packet (#150) — correct fail-closed behavior, but
     * silent per-packet, so it looks like a dead link (no messages, not even
     * heartbeats) with no error. Warn once at deploy so the misconfiguration is
     * diagnosable. (unmatched: 'default' still decodes with the default profile,
     * so it is not warned.)
     */
    if (
      node._router.mode === 'routed' &&
      node._router.routeTable.size === 0 &&
      node._router.unmatched !== 'default'
    ) {
      node.warn(
        'Routing mode is "routed" but no routes are configured and the unmatched policy is "reject": ' +
          'every inbound packet will be rejected (no decoded messages, including heartbeats). Add a route, ' +
          'switch routing mode to "single-profile", or set the unmatched policy to "default".'
      );
    }

    /**
     * Build the merged CRC-extra (magic number) table covering every routed
     * profile's dialect. The splitter validates CRC against this table before
     * routing, so it must know message ids defined only by a routed (e.g.
     * custom XML) dialect — otherwise those packets are dropped silently
     * inside the splitter.
     *
     * Two profiles defining the *same* message id with *different* CRC extras
     * cannot share one splitter: silently keeping either value makes the other
     * dialect's packets fail CRC or decode unpredictably. That configuration
     * is unsupported and fails loudly here (#86) instead of picking a winner.
     * Identical duplicate definitions (e.g. two profiles including common.xml)
     * are fine.
     *
     * @returns {object} msgid -> CRC extra
     * @throws {MavlinkError} DIALECT_CRC_CONFLICT
     */
    function buildMergedMagic() {
      const merged = {};
      const contributor = new Map(); // msgid -> { magic, profile, dialect }
      const conflicts = [];
      for (const profile of node._router.profiles()) {
        const bundle = profile && isProfileNode(profile) ? profile.getDialect() : null;
        if (!bundle || !bundle.valid) {
          continue;
        }
        const label = `profile '${profile.name || profile.id}' (dialect '${bundle.name}')`;
        for (const [id, magic] of Object.entries(bundle.magicNumbers)) {
          if (!(id in merged)) {
            merged[id] = magic;
            contributor.set(id, { magic, label });
          } else if (merged[id] !== magic) {
            const first = contributor.get(id);
            conflicts.push(
              `message id ${id}: ${first.label} CRC extra ${first.magic} vs ${label} CRC extra ${magic}`
            );
          }
        }
      }
      if (conflicts.length) {
        throw new MavlinkError(
          'DIALECT_CRC_CONFLICT',
          `Routed profiles define the same MAVLink message id with different CRC extras and cannot share one connection: ${conflicts.join('; ')}.`,
          { conflicts }
        );
      }
      return merged;
    }

    const ROUTE_ERROR_DETAIL = 'Route table has unresolved profiles';
    // The status the route-validation error replaced, so a later validation
    // pass can restore it instead of guessing at the transport state.
    let statusBeforeRouteError = null;

    /**
     * Validate that every route-table profile reference resolves to a valid
     * profile with a buildable codec, and report every problem loudly. Runs
     * once all flows have started (config nodes may register in any order
     * within a deploy, so constructor-time resolution could falsely fail).
     * Packets matching a broken route are rejected per-packet regardless;
     * this just surfaces the misconfiguration at deploy time instead of
     * waiting for traffic.
     *
     * Re-runs on every deploy: when a partial deploy fixes the routes without
     * recreating this connection node, a clean pass clears the stale error
     * status (restoring whatever status the error replaced) — but only if the
     * current status is still ours, so a transport-driven status set in the
     * meantime is left alone.
     *
     * @returns {void}
     */
    function validateRouteProfiles() {
      const problems = [];
      for (const route of node._router.routeTable.routes) {
        try {
          getCodecForProfile(node.resolveProfile(route.profile));
        } catch (err) {
          problems.push(`route (sysid ${route.sysid}, compid ${route.compid} -> '${route.profile}'): ${err.message}`);
        }
      }
      // The routed profiles must also agree on one splitter CRC table (#86):
      // a message-id CRC conflict is a deploy-time configuration error, not
      // something to discover packet by packet.
      try {
        buildMergedMagic();
      } catch (err) {
        problems.push(err.message);
      }
      if (problems.length) {
        if (node.statusDetail !== ROUTE_ERROR_DETAIL) {
          statusBeforeRouteError = { state: node.statusState, detail: node.statusDetail };
        }
        setStatus('error', ROUTE_ERROR_DETAIL);
        node.error(
          `mavlink-ai-connection '${node.name || node.id}': ROUTE_TABLE_INVALID: ` +
            `${problems.length} problem(s) with routed profiles; ` +
            `matching packets will be rejected, not decoded with the default profile. ${problems.join('; ')}`
        );
      } else if (node.statusState === 'error' && node.statusDetail === ROUTE_ERROR_DETAIL) {
        const previous = statusBeforeRouteError || { state: 'idle', detail: '' };
        statusBeforeRouteError = null;
        setStatus(previous.state, previous.detail);
      }
    }

    /**
     * Rebuild every profile-dependent piece of runtime state around a freshly
     * resolved default profile, WITHOUT restarting the transport/session.
     *
     * Node-RED recreates an edited profile config node but leaves an unchanged
     * connection node running, so after a profile edit (e.g. its dialect) the
     * connection is still holding the *previous* profile object, the codec built
     * from its dialect, the per-profile codec cache, the router's default
     * profile, and a decoder whose splitter CRC table came from the old dialect.
     * Swapping all of it here applies the edit on the next deploy.
     *
     * The {@link LinkState} deliberately survives this rebuild (#192): sequence
     * numbers, signing timestamps, replay memory, and detected peer versions
     * are channel state, not dialect state, so a profile edit no longer resets
     * them.
     *
     * @param {object} newProfile  the freshly resolved, valid default profile
     * @returns {void}
     * @throws {MavlinkError} CODEC_INIT_FAILED  the new dialect can't build a codec
     */
    function rebuildProfileState(newProfile) {
      // Build the new default codec first: if the edited dialect can't produce
      // one, throw before mutating any live state so the connection keeps
      // running with the profile it already had rather than ending up
      // half-swapped between two dialects.
      const codec = buildCodec(newProfile);
      node.profile = newProfile;
      node._codec = codec;
      // Drop every cached profile-dependent artifact so it is rebuilt against
      // the new dialect: the per-profile codec cache (re-seed the default), the
      // memoized legacy name -> profile lookups, and — via _resetDecoder — the
      // packet decoder, whose merged CRC table must now cover the new dialect's
      // message ids. The decoder is recreated lazily on the next packet.
      node._codecByProfile.clear();
      node._codecByProfile.set(newProfile.id, { profile: newProfile, codec });
      profileByName.clear();
      node._router.defaultProfile = newProfile;
      if (typeof node._resetDecoder === 'function') {
        node._resetDecoder();
      }
      // Route/decode problems were logged once per identity against the old
      // dialect; let them re-log against the new one if they persist.
      loggedRouteProblems.clear();
    }

    /**
     * The set of profile *objects* whose dialects currently feed the decoder's
     * merged CRC table: the default profile plus every route-table profile that
     * resolves right now. The router already dedupes and swallows unresolved
     * route references, so this is exactly the effective dialect set.
     *
     * @returns {Set<object>}
     */
    function computeActiveProfiles() {
      const set = new Set();
      for (const p of node._router.profiles()) {
        if (p) {
          set.add(p);
        }
      }
      return set;
    }

    /**
     * Two profile-object sets are equal iff they contain the same object
     * identities. A routed profile edited under the same id resolves to a *new*
     * object, so identity comparison detects the edit that an id comparison
     * would miss.
     *
     * @param {Set<object>} a
     * @param {Set<object>} b
     * @returns {boolean}
     */
    function sameProfileSet(a, b) {
      if (a.size !== b.size) {
        return false;
      }
      for (const p of a) {
        if (!b.has(p)) {
          return false;
        }
      }
      return true;
    }

    /**
     * Destroy and drop every live stream decoder (single shared decoder, or one
     * per tcp-server client). Used on teardown, deactivate, and profile reset so
     * no decoder keeps splitting frames with a stale dialect (#147).
     *
     * @returns {void}
     */
    function destroyDecoders() {
      for (const decoder of node._decoders.values()) {
        decoder.destroy();
      }
      node._decoders.clear();
    }

    /**
     * Tear the connection down to a fail-closed, inactive state (#116, #228).
     * Used when the required default profile or Local Identity has been deleted
     * or become invalid, or the attached identity set collides: the connection
     * must stop decoding and commanding vehicles, and release its transport
     * (UDP/TCP/serial) immediately rather than leaving a socket bound after the
     * configuration that justified it was removed.
     *
     * Subscriptions are intentionally retained so a later deploy that restores a
     * valid configuration can {@link reactivate} and resume delivering to the
     * same subscribers; everything profile/identity-dependent (codecs, decoder,
     * name caches, mission locks) is dropped, and the {@link LinkState} is
     * reset — the link/session itself is ending, so its channel state ends with
     * it.
     *
     * @param {string} code     structured error code (NO_PROFILE | LOCAL_IDENTITY_REQUIRED | ...)
     * @param {string} message  human-readable cause
     * @returns {Promise<void>} resolves once the transport has fully stopped and
     *   its port/handle is released
     */
    function deactivate(code, message) {
      /** Record/refresh the reason but only tear down once. */
      const alreadyInactive = !node._active;
      node._active = false;
      node._inactiveError = new MavlinkError(code, message);
      if (alreadyInactive) {
        return node._deactivating || Promise.resolve();
      }
      stopHeartbeats();
      /** Reject queued outbound work; new sends reject via the _active guard. */
      if (node._queue) {
        node._queue.clear();
      }
      /**
       * Drop every profile/identity-dependent artifact so nothing keeps
       * decoding or commanding with the removed configuration.
       */
      node._codecByProfile.clear();
      node._activeProfiles = new Set();
      profileByName.clear();
      identityByName.clear();
      loggedRouteProblems.clear();
      node.locks.clear();
      destroyDecoders();
      node._link = new LinkState();
      node.statusState = 'error';
      node.statusDetail = message;
      node.emitter.emit('status', node.getStatus());
      node.error(`mavlink-ai-connection '${node.name || node.id}': ${code}: ${message}`);
      /**
       * Release the bound transport so its port/handle is freed immediately —
       * a deleted profile/identity must not leave the socket bound
       * (EADDRINUSE) until Node-RED restarts.
       */
      const transport = node._transport;
      node._transport = null;
      node._deactivating = transport ? Promise.resolve(transport.stop()).catch(() => {}) : Promise.resolve();
      return node._deactivating;
    }

    /**
     * Bring a previously {@link deactivate}d connection back up around freshly
     * resolved, valid default profile and Local Identity (#116, #228). Rebuilds
     * the codec/router state and restarts the transport on the same config so a
     * config node that was deleted and then re-created on a later deploy
     * resumes without recreating this connection node. Waits for any in-flight
     * teardown to finish first so the port is free before it is rebound.
     *
     * @param {object} profile   the restored, valid default Vehicle Profile
     * @param {object} identity  the restored, valid default Local Identity
     * @returns {void}
     */
    function reactivate(profile, identity) {
      let codec;
      try {
        codec = buildCodec(profile);
      } catch (err) {
        /** The restored profile still cannot build a codec: stay inactive. */
        node._inactiveError = toMavlinkError(err, 'CODEC_INIT_FAILED');
        node.error(
          `mavlink-ai-connection '${node.name || node.id}': cannot reactivate with profile ` +
            `'${profile.name || profile.id}': ${node._inactiveError.message}`
        );
        return;
      }
      node.profile = profile;
      node.localIdentity = identity;
      node._codec = codec;
      node._codecByProfile.clear();
      node._codecByProfile.set(profile.id, { profile, codec });
      node._router.defaultProfile = profile;
      profileByName.clear();
      identityByName.clear();
      loggedRouteProblems.clear();
      node._inactiveError = null;
      node._active = true;
      node._activeProfiles = computeActiveProfiles();
      /** Restart the transport once, if it is not already up. */
      const startNow = () => {
        if (node._active && !node._transport) {
          startTransport();
        }
      };
      /**
       * A promise that settles once the transport restart has been attempted,
       * after any in-flight teardown resolves so the port is free before it is
       * rebound. Exposed so callers/tests can await reactivation deterministically
       * instead of guessing at event-loop timing.
       *
       * @type {Promise<void>}
       */
      node._activating = Promise.resolve(node._deactivating).then(startNow, startNow);
    }

    /**
     * Reconcile the connection's required default Vehicle Profile and default
     * Local Identity on every deploy (#116, #228).
     *
     * - Either missing or invalid  -> fail closed: {@link deactivate}.
     * - Both restored after a prior deactivation -> {@link reactivate}.
     * - Profile edited under the same id (a different object) while still
     *   running -> {@link rebuildProfileState} hot-reload, no transport restart.
     * - Identity edited under the same id -> adopt the new object; the
     *   LinkState survives (#192), and heartbeat timers are rebuilt so the new
     *   heartbeat fields apply.
     *
     * @returns {void}
     */
    function reconcileRequiredConfig() {
      const resolvedProfile = RED.nodes.getNode(config.profile);
      const profileOk = isProfileNode(resolvedProfile) && resolvedProfile.isValid && resolvedProfile.isValid();
      if (!profileOk) {
        const code = !isProfileNode(resolvedProfile) ? 'NO_PROFILE' : 'PROFILE_INVALID';
        const err = isProfileNode(resolvedProfile) && resolvedProfile.getError && resolvedProfile.getError();
        const message =
          code === 'NO_PROFILE'
            ? 'Required default Vehicle Profile has been deleted; connection deactivated and transport released.'
            : `Required default Vehicle Profile '${resolvedProfile.name || resolvedProfile.id}' is invalid; ` +
              `connection deactivated and transport released.${err ? ` ${err.message}` : ''}`;
        deactivate(code, message);
        return;
      }

      const resolvedIdentity = config.localIdentity ? RED.nodes.getNode(config.localIdentity) : null;
      if (!isIdentityNode(resolvedIdentity)) {
        deactivate(
          'LOCAL_IDENTITY_REQUIRED',
          `Connection '${node.name || node.id}' has no Local Identity (deleted or never configured); ` +
            'connection deactivated and transport released. Select one in Connection > Local Identity.'
        );
        return;
      }
      if (!resolvedIdentity.isValid()) {
        const err = resolvedIdentity.getError();
        deactivate(
          'LOCAL_IDENTITY_INVALID',
          `Local Identity '${resolvedIdentity.name || resolvedIdentity.id}' is invalid; ` +
            `connection deactivated and transport released.${err ? ` ${err.message}` : ''}`
        );
        return;
      }

      /**
       * Collision check across the freshly resolved attached identity set. Run
       * against the resolved default (not the possibly stale node.localIdentity)
       * by adopting it first when it changed.
       */
      const identityChanged = resolvedIdentity !== node.localIdentity;
      if (node._active) {
        if (identityChanged) {
          node.localIdentity = resolvedIdentity;
          identityByName.clear();
        }
        const collision = validateIdentityBindings(true);
        if (collision) {
          deactivate(collision.code, collision.message);
          return;
        }
        if (resolvedProfile !== node.profile) {
          /** A valid edited profile under the same id: hot-reload in place. */
          try {
            rebuildProfileState(resolvedProfile);
          } catch (err) {
            const e = toMavlinkError(err, 'CODEC_INIT_FAILED');
            deactivate(
              e.code || 'CODEC_INIT_FAILED',
              `Failed to apply edited default Vehicle Profile '${resolvedProfile.name || resolvedProfile.id}': ${e.message}`
            );
            return;
          }
        }
        /**
         * Heartbeat timers capture identity objects and intervals; rebuild them
         * so an edited identity's new heartbeat fields (or a changed binding
         * set) take effect on a running connection.
         */
        restartHeartbeats();
        return;
      }

      /** Inactive: a valid configuration is back after a prior deactivation. */
      node.localIdentity = resolvedIdentity;
      const collision = validateIdentityBindings(true);
      if (collision) {
        node._inactiveError = collision;
        node.error(`mavlink-ai-connection '${node.name || node.id}': ${collision.code}: ${collision.message}`);
        return;
      }
      reactivate(resolvedProfile, resolvedIdentity);
    }

    /**
     * Reconcile the routed (non-default) profile set on every deploy (#117).
     *
     * Route-table profiles are embedded inside serialized JSON, so Node-RED
     * cannot see them as config-node dependencies and never restarts this
     * connection when one changes. Here we evict any cached codec whose profile
     * object is no longer the resolved one for its id (edited/recreated) or that
     * no default/route references anymore (deleted), and reset the decoder when
     * the effective dialect/CRC set changed so its merged splitter table is
     * rebuilt. The transport stays up: a broken *routed* profile rejects only
     * its own packets (via validateRouteProfiles / per-packet routing), it does
     * not fail the whole connection.
     *
     * @returns {void}
     */
    function reconcileRoutedProfiles() {
      const active = computeActiveProfiles();
      const activeById = new Map();
      for (const p of active) {
        if (p && p.id) {
          activeById.set(p.id, p);
        }
      }
      /**
       * Evict stale (object changed) or unreferenced (deleted) codec entries so
       * a deleted profile's codec cannot remain cached and usable.
       */
      for (const [id, entry] of node._codecByProfile) {
        const current = activeById.get(id);
        if (!current || current !== entry.profile) {
          node._codecByProfile.delete(id);
        }
      }
      /**
       * Reset the decoder whenever the merged dialect set changed, so the next
       * packet rebuilds the splitter CRC table from the current profiles.
       */
      if (!sameProfileSet(active, node._activeProfiles)) {
        node._activeProfiles = active;
        if (typeof node._resetDecoder === 'function') {
          node._resetDecoder();
        }
        loggedRouteProblems.clear();
      }
    }

    /**
     * Seed the active-profile set from whatever resolves at construction; the
     * first flows:started reconcile fills in any route profiles that registered
     * after this connection during the same deploy.
     */
    node._activeProfiles = computeActiveProfiles();

    if (RED.events && typeof RED.events.on === 'function') {
      /**
       * Every deploy leaves this connection node in place unless its own config
       * changed, so reconcile all profile/identity dependencies here — Node-RED
       * cannot see the edits/deletions that matter (default profile/identity
       * edits, and route/binding references embedded in serialized JSON) as
       * dependencies of this node.
       *
       * @returns {void}
       */
      const onFlowsStarted = () => {
        /**
         * Re-scan legacy name lookups so a deleted/renamed/now-ambiguous name
         * never resolves to a stale object (#118).
         */
        profileByName.clear();
        identityByName.clear();
        /** Fail closed / reactivate / hot-reload the required config (#116, #228). */
        reconcileRequiredConfig();
        if (!node._active) {
          /** Deactivated: nothing further to validate or decode. */
          return;
        }
        /** Evict stale routed codecs and reset the decoder on dialect changes (#117). */
        reconcileRoutedProfiles();
        validateRouteProfiles();
      };
      RED.events.on('flows:started', onFlowsStarted);
      node.on('close', () => RED.events.removeListener('flows:started', onFlowsStarted));
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
     * Inbound routing maps remote packet identities to Vehicle Profiles for
     * decode/interpretation only — it never selects the local identity used
     * for outbound traffic (#228).
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
     * The rejection for a send attempted while the connection is failed-closed
     * (#116). Carries the deactivation reason (NO_PROFILE /
     * LOCAL_IDENTITY_REQUIRED / ...) so callers see a clear structured error
     * instead of a generic transport miss.
     *
     * @returns {MavlinkError}
     */
    function inactiveRejection() {
      const e = node._inactiveError;
      return e
        ? new MavlinkError(e.code, e.message, e.context)
        : new MavlinkError('CONNECTION_INACTIVE', `Connection '${node.name || node.id}' is inactive.`);
    }

    /**
     * Encode and enqueue a normalized outbound message (§14.2), filling target
     * defaults from the effective Vehicle Profile and stamping the source
     * identity of the resolved Local Identity (#228).
     *
     * @param {object} message  { name, fields, vehicleProfile?, localIdentity?,
     *   target_system?, target_component? } — `profile` is accepted as a
     *   deprecated alias for `vehicleProfile`.
     * @param {object} [options]  { priority, coalesceKey } — coalesceKey lets a
     *   periodic sender (e.g. a heartbeat) supersede its own still-queued copy
     *   rather than accumulate behind a slow transport.
     * @returns {Promise<void>}
     */
    node.send = (message, options = {}) => {
      if (!node._active) {
        return Promise.reject(inactiveRejection());
      }
      if (!message || typeof message !== 'object') {
        return Promise.reject(new MavlinkError('BAD_OUTBOUND', 'Outbound message must be an object.'));
      }
      // The Vehicle Profile named on the message supplies the codec (dialect,
      // version — #68) *and* the target defaults. It never supplies the source
      // identity (#228): that resolves independently below. An explicit
      // reference that can't be resolved rejects rather than silently sending
      // as the default.
      let profile;
      try {
        profile = resolveOutboundProfile(vehicleProfileRef(message));
      } catch (err) {
        return Promise.reject(toMavlinkError(err, 'PROFILE_UNRESOLVED'));
      }
      // Resolve the Local Identity this message transmits as: the explicit
      // message.localIdentity when present (which must be attached and
      // permitted), else the connection's required default. Never derived from
      // the Vehicle Profile; never a fallback from an invalid explicit request.
      let identity;
      try {
        identity = node.resolveOutboundIdentity(message.localIdentity);
      } catch (err) {
        return Promise.reject(toMavlinkError(err, 'LOCAL_IDENTITY_UNRESOLVED'));
      }
      const defaults = profile.getDefaults();
      const fields = message.fields && typeof message.fields === 'object' ? { ...message.fields } : {};
      // Normalize targets once, before encoding and transport routing (#84).
      // A message can carry target ids top-level and inside fields; the two
      // used to be resolved independently (top-level for the udp-peer routing
      // metadata, field-level preserved by the codec), so a conflicting pair
      // sent the packet to one endpoint while the payload addressed another.
      // One location wins when only one is set, defaults fill when neither is,
      // equal values (numeric string == number) are fine, and a disagreement
      // rejects the send instead of picking silently.
      let targetSystem;
      let targetComponent;
      try {
        targetSystem = resolveTargetId('target_system', message.target_system, fields.target_system, defaults.defaultTargetSystem);
        targetComponent = resolveTargetId(
          'target_component',
          message.target_component,
          fields.target_component,
          defaults.defaultTargetComponent
        );
      } catch (err) {
        return Promise.reject(toMavlinkError(err, 'TARGET_CONFLICT'));
      }
      // Stamp the resolved numeric values back into the fields so the encoded
      // payload and the transport routing metadata below cannot diverge.
      if (targetSystem !== undefined && fields.target_system !== undefined) {
        fields.target_system = targetSystem;
      }
      if (targetComponent !== undefined && fields.target_component !== undefined) {
        fields.target_component = targetComponent;
      }
      let codec;
      try {
        codec = getCodecForProfile(profile);
      } catch (err) {
        return Promise.reject(toMavlinkError(err, 'PROFILE_INVALID'));
      }
      /**
       * A message with no target_system field is a broadcast (#148) and must not
       * be framed for one specific peer. The target is gated on `addressesTarget`
       * for *both* the encoder and the routing metadata:
       *   - routing: an addressed packet goes to that sysid's udp-peer endpoint
       *     (#21); a broadcast fans out to every learned peer instead of
       *     unicasting to the profile default.
       *   - encoding: under `mavlinkVersion: 'auto'`, the effective version is
       *     picked from the target sysid's detected version, so passing the
       *     profile default target would frame an untargeted HEARTBEAT as that
       *     peer's version (e.g. v2) and a learned v1-only vehicle would miss
       *     it. With no target the encoder uses the link's detected default.
       * (A genuinely mixed v1/v2 fleet still can't be reached by a single
       * broadcast frame — that's inherent to MAVLink versioning, not this path.)
       */
      const routingTargetSystem = codec.addressesTarget(message.name) ? targetSystem : undefined;
      const { sysid, compid } = identity.getIdentity();
      /**
       * Signing is a link property: every identity on this connection signs with
       * the connection's key, not its own (a link has exactly one signing key).
       */
      const signingPolicy = node.getSigningPolicy();
      const signing =
        signingPolicy && signingPolicy.signOutbound && signingPolicy.key
          ? { key: signingPolicy.key, linkId: node.signingLinkId }
          : null;
      let buffer;
      try {
        buffer = codec.encode(message.name, fields, {
          sysid,
          compid,
          link: node._link,
          signing,
          targetSystem: routingTargetSystem,
          targetComponent,
          /**
           * Exact IEEE-754 bit patterns for float fields (PX4 byte-union
           * params, #146) — see MavlinkCodec#encode.
           */
          exactFloatBits: message.exactFloatBits
        });
      } catch (err) {
        return Promise.reject(toMavlinkError(err, 'ENCODE_FAILED'));
      }
      return node._queue.enqueue(
        buffer,
        options.priority,
        { targetSystem: routingTargetSystem },
        { coalesceKey: options.coalesceKey }
      );
    };

    /**
     * Enqueue a pre-encoded raw buffer for sending.
     *
     * @param {Buffer} buffer
     * @param {object} [options]  { priority }
     * @returns {Promise<void>}
     */
    node.sendRaw = (buffer, options = {}) => {
      if (!node._active) {
        return Promise.reject(inactiveRejection());
      }
      if (!Buffer.isBuffer(buffer)) {
        return Promise.reject(new MavlinkError('BAD_RAW', 'Raw payload must be a Buffer.'));
      }
      return node._queue.enqueue(buffer, options.priority);
    };

    // --- inbound packet handling --------------------------------------------
    // Route/profile problems repeat at packet rate for the same identity; log
    // each distinct (identity, problem) once so it is loud but not a flood.
    const loggedRouteProblems = new Set();

    /**
     * Log a route-resolution problem for a packet identity, once per distinct
     * identity + error.
     *
     * @param {object} header  packet header (sysid/compid)
     * @param {Error} err
     * @returns {void}
     */
    function logRouteProblemOnce(header, err) {
      const key = `${header.sysid}:${header.compid}:${err.message}`;
      if (loggedRouteProblems.has(key)) {
        return;
      }
      loggedRouteProblems.add(key);
      node.error(
        `mavlink-ai-connection '${node.name || node.id}': rejecting packets from ` +
          `sysid ${header.sysid} compid ${header.compid}: ${err.message}`
      );
    }

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
      /**
       * Discard a frame carrying a MAVLink-2 incompatibility flag we don't
       * implement (#153). The spec mandates dropping such a frame: an unknown
       * incompat flag can change how the rest of the frame must be interpreted,
       * so decoding it anyway risks misreading the payload. Only IFLAG_SIGNED
       * (0x01) is understood — its signature is checked below; any other bit set
       * means we cannot safely decode. (v1 frames have no incompat field, so
       * incompatibilityFlags is 0/undefined and this never trips.)
       */
      const incompatFlags = Number(header.incompatibilityFlags) || 0;
      if (incompatFlags & ~KNOWN_INCOMPAT_FLAGS) {
        node.emitter.emit('rejected', {
          sysid: header.sysid,
          compid: header.compid,
          reason: 'incompat-unsupported'
        });
        return;
      }
      /**
       * Read the wire version from the actual first frame byte, not
       * header.magic: node-mavlink's v1 parser never sets header.magic (it
       * stays 0), so a v1 (0xFE) frame would otherwise never be detected (#138).
       * Recorded below on the shared LinkState (#192), only after routing and
       * signature policy accept the packet — an unsigned forged v1 frame
       * passes CRC without any secret, so learning the version here would let
       * it silently downgrade outbound framing for a trusted peer even under
       * requireSignature.
       */
      const wireMagic = packet.buffer && packet.buffer.length ? packet.buffer[0] : header.magic;

      // 1. Route on the framed header (sysid/compid) before decoding. A
      //    matched route whose profile cannot be resolved rejects the packet
      //    (never falls back to the default dialect) and logs once per
      //    identity so the broken route is loud without flooding at wire rate.
      const decision = node._router.route(header.sysid, header.compid);
      if (!decision.accepted) {
        if (decision.error) {
          logRouteProblemOnce(header, decision.error);
        }
        node.emitter.emit('rejected', { sysid: header.sysid, compid: header.compid, reason: decision.reason });
        return;
      }
      const profile = decision.profile || node.profile;
      const transportDescriptor = node._transport ? node._transport.descriptor : { type: node.transportType };

      // 2. Decode with the matched profile's dialect (routed connections may
      //    carry systems on different dialects). A matched profile whose
      //    dialect/codec is unusable rejects the packet, same as above.
      let codec;
      try {
        codec = getCodecForProfile(profile);
      } catch (err) {
        logRouteProblemOnce(header, err);
        node.emitter.emit('rejected', { sysid: header.sysid, compid: header.compid, reason: 'profile-invalid' });
        return;
      }

      /**
       * 3. MAVLink 2 signature verification (issue #15). The verification
       * policy/credential is the connection's own — signing authenticates the
       * link participants, not the vehicle metadata — and the anti-replay memory
       * lives in the LinkState, keyed by the verification key, so it survives
       * profile/identity rebuilds (#192). Verification is a no-op (returns null)
       * unless the connection enables it, so unsigned setups are unaffected. Runs
       * after routing but before decode so an unauthentic frame never reaches
       * subscribers.
       */
      const sigDecision = verifyInboundPacket(packet, inboundPolicy());
      if (sigDecision && !sigDecision.accepted) {
        node.emitter.emit('rejected', {
          sysid: header.sysid,
          compid: header.compid,
          reason: sigDecision.reason
        });
        return;
      }

      // Only now is the sender trusted enough to route replies to (#85): the
      // frame passed CRC in the splitter, its identity passed routing, and it
      // satisfied the signature policy. Tell a udp-peer transport to commit
      // the observed endpoint for this sysid — malformed, route-rejected, or
      // signature-rejected traffic never reaches here, so it can never
      // redirect outbound packets.
      if (node._transport && typeof node._transport.confirmPeer === 'function') {
        node._transport.confirmPeer(header.sysid);
      }

      /**
       * Track the peer's wire version, keyed by its sysid, so an "auto"
       * profile frames outbound packets the way *that* peer speaks — a v1-only
       * vehicle ignores v2 frames, and a mixed fleet must not have one peer's
       * version flip framing for all of them (#69). Recorded once on the
       * connection's LinkState, which every codec on this link shares (#192),
       * and learned at the same trust boundary as confirmPeer (#85): only a
       * packet that passed routing and the signature policy may influence
       * outbound framing.
       */
      node._link.noteInboundMagic(wireMagic, header.sysid);

      // 4. If the matched dialect has no definition for this message id, or
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
          profile_id: profile ? profile.id : undefined,
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
          profile_id: profile ? profile.id : undefined,
          raw: packet.buffer.toString('hex')
        }
      });
      node.emitter.emit('decodeError', { topic: 'mavlink/error', payload });
    }

    // --- heartbeat (#228: one schedule per attached identity) ----------------
    /**
     * The heartbeat schedules currently configured: the default identity's
     * (from the connection's Heartbeat toggle) plus each additional binding
     * that opted in — additional heartbeats are opt-in per binding and require
     * multi-identity transmission to be enabled.
     *
     * @returns {Array<{identity: object, intervalMs: number}>}
     */
    function heartbeatSpecs() {
      const specs = [];
      if (node.heartbeatEnabled) {
        specs.push({ identity: node.localIdentity, intervalMs: node.heartbeatIntervalMs });
      }
      if (node.allowMultipleIdentities) {
        for (const spec of node._identityBindings) {
          if (!spec.heartbeat) {
            continue;
          }
          let identity;
          try {
            identity = node.resolveLocalIdentity(spec.identity);
          } catch (err) {
            node.warn(
              `mavlink-ai-connection '${node.name || node.id}': cannot start heartbeat for additional ` +
                `Local Identity '${spec.identity}': ${err.message}`
            );
            continue;
          }
          if (spec.allowOutbound === false) {
            node.warn(
              `mavlink-ai-connection '${node.name || node.id}': additional Local Identity ` +
                `'${identity.describe()}' has heartbeat enabled but outbound disabled; not sending its heartbeats.`
            );
            continue;
          }
          if (identity.id === node.localIdentity.id) {
            /** The default identity's schedule is the connection's own. */
            continue;
          }
          specs.push({ identity, intervalMs: spec.heartbeatIntervalMs });
        }
      }
      return specs;
    }

    /**
     * Start the periodic HEARTBEAT timers (background priority), one per
     * scheduled identity, each using that identity's own heartbeat fields.
     * No-op for schedules already running.
     *
     * @returns {void}
     */
    function startHeartbeats() {
      const specs = heartbeatSpecs();
      if (!specs.length) {
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
      for (const spec of specs) {
        if (node._heartbeatTimers.has(spec.identity.id)) {
          continue;
        }
        /**
         * Send one heartbeat as this identity; surface failures through the
         * error emitter. Sent at background priority (3) but coalesced *per
         * identity* (#228): if a prior heartbeat is still queued behind
         * slower-draining traffic, this tick supersedes it instead of stacking
         * a second stale copy — and one identity's heartbeat can never replace
         * another's queued heartbeat, because the coalesce key includes the
         * identity. Age promotion in the outbound queue keeps the surviving
         * heartbeat from being starved by that traffic (#150).
         */
        const identity = spec.identity;
        const tick = () => {
          node
            .send(
              {
                name: 'HEARTBEAT',
                fields: identity.getHeartbeatFields(),
                localIdentity: identity.id
              },
              { priority: 3, coalesceKey: `heartbeat:${identity.id}` }
            )
            .catch((err) => {
              /**
               * Expected "no link yet / link down / tearing down" states must
               * not log an error every tick forever — heartbeats resume
               * silently once the link is up. UDP_NO_PEER: udp-peer hasn't
               * learned a peer; TCP_NO_CLIENT / TCP_NOT_CONNECTED /
               * SERIAL_NOT_OPEN: the same "nothing to send to yet" state for
               * the other transports (each already surfaced once through
               * transport status/error events); TRANSPORT_NOT_READY: transport
               * not started; QUEUE_CLEARED: this node is being deactivated or
               * closed — re-emitting that on the emitter after close() has
               * removed its listeners would throw and take the whole process
               * down as an unhandled rejection.
               */
              if (err && HEARTBEAT_EXPECTED_IDLE_CODES.has(err.code)) {
                return;
              }
              node.emitter.emit('error', toMavlinkError(err, 'HEARTBEAT_FAILED'));
            });
        };
        const timer = setInterval(tick, Math.max(HEARTBEAT_MIN_INTERVAL_MS, spec.intervalMs));
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
        node._heartbeatTimers.set(identity.id, timer);
      }
    }

    /**
     * Stop every heartbeat timer.
     *
     * @returns {void}
     */
    function stopHeartbeats() {
      for (const timer of node._heartbeatTimers.values()) {
        clearInterval(timer);
      }
      node._heartbeatTimers.clear();
    }

    /**
     * Rebuild the heartbeat timers against the current identity set — used
     * after a deploy reconcile so edited identities/bindings take effect on a
     * running connection. Only restarts when the transport is up (the
     * listening/connected handlers start them otherwise).
     *
     * @returns {void}
     */
    function restartHeartbeats() {
      stopHeartbeats();
      if (node._transport) {
        startHeartbeats();
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

      // A CRC conflict across routed profiles (#86) is a fatal configuration
      // error for this connection: remember it so it is surfaced once, not
      // re-raised for every inbound datagram.
      let decoderFatal = null;

      /**
       * Return the decoder for one stream, creating it on first use with the
       * merged CRC table covering every routed profile's dialect. Built lazily
       * on first data so route profiles registered after this connection during
       * the same deploy still contribute their tables. A merge conflict makes
       * the connection refuse to decode (an ambiguous splitter table must never
       * pick a winner silently), sets the error status, and throws once.
       *
       * TCP is a byte stream, so each server-mode client needs its own splitter:
       * a shared decoder corrupts framing when client A's half-frame arrives
       * with client B's bytes interleaved between the two `data` events (#147).
       * Single-peer transports pass `SHARED_STREAM_KEY` and reuse one decoder.
       *
       * @param {string|number} streamKey
       * @returns {object} the stream's decoder
       */
      function ensureDecoder(streamKey) {
        if (decoderFatal) {
          throw decoderFatal;
        }
        let decoder = node._decoders.get(streamKey);
        if (!decoder) {
          let magicNumbers;
          try {
            magicNumbers = buildMergedMagic();
          } catch (err) {
            decoderFatal = toMavlinkError(err, 'DIALECT_CRC_CONFLICT');
            setStatus('error', 'Routed dialects have conflicting message CRCs');
            throw decoderFatal;
          }
          decoder = node._codec.createDecoder(
            onPacket,
            (err) => node.emitter.emit('error', toMavlinkError(err, 'DECODE_ERROR')),
            { magicNumbers }
          );
          node._decoders.set(streamKey, decoder);
          /**
           * Backstop against unbounded growth if clients ever churn faster than
           * `peer-disconnect` evicts them: drop the oldest decoder (Map keeps
           * insertion order). The freshly-created one is newest, so it survives;
           * an evicted-but-still-live client simply rebuilds lazily (#147).
           */
          if (node._decoders.size > MAX_STREAM_DECODERS) {
            const oldestKey = node._decoders.keys().next().value;
            const oldest = node._decoders.get(oldestKey);
            node._decoders.delete(oldestKey);
            oldest.destroy();
          }
        }
        return decoder;
      }

      let decoderFatalReported = false;

      /**
       * Let a profile edit (applied on flows:started) drop the decoders built
       * from the *old* dialect and clear the fatal latch, so the next inbound
       * datagram rebuilds them lazily from the new default codec with a merged
       * CRC table covering the new dialect. The transport/session — the bound
       * UDP socket, learned peers, reconnect state — is left untouched.
       */
      node._resetDecoder = () => {
        destroyDecoders();
        decoderFatal = null;
        decoderFatalReported = false;
      };

      node._transport.on('data', (buffer, rinfo) => {
        if (decoderFatal) {
          /** fatal config error already surfaced; don't re-log per datagram */
          return;
        }
        /**
         * tcp-server stamps a per-client `clientId`; every other transport
         * delivers a single peer's stream and shares one decoder (#147).
         */
        const streamKey = rinfo && rinfo.clientId != null ? rinfo.clientId : SHARED_STREAM_KEY;
        let decoder;
        try {
          decoder = ensureDecoder(streamKey);
        } catch (err) {
          if (!decoderFatalReported) {
            decoderFatalReported = true;
            node.emitter.emit('error', toMavlinkError(err, 'DIALECT_CRC_CONFLICT'));
          }
          return;
        }
        try {
          decoder.write(buffer);
        } catch (err) {
          node.emitter.emit('error', toMavlinkError(err, 'DECODE_ERROR'));
        }
      });
      /**
       * When a tcp-server client disconnects, drop its stream decoder so a churn
       * of clients can't leak decoders and any half-buffered frame from the dead
       * link is discarded rather than corrupting a future client that reuses the
       * same `clientId` (it won't — ids are monotonic) (#147).
       */
      node._transport.on('peer-disconnect', (rinfo) => {
        if (!rinfo || rinfo.clientId == null) {
          return;
        }
        const decoder = node._decoders.get(rinfo.clientId);
        if (decoder) {
          node._decoders.delete(rinfo.clientId);
          decoder.destroy();
        }
      });
      node._transport.on('listening', (info) => {
        setStatus(node.transportType.startsWith('udp') ? 'listening' : 'connected', describeListening(node, info));
        startHeartbeats();
      });
      node._transport.on('connected', (info) => {
        setStatus('connected', describeListening(node, info));
        startHeartbeats();
      });
      node._transport.on('reconnecting', () => {
        /**
         * The dropped session may have left a partial frame buffered in the
         * shared stream decoder (tcp-client / serial share one splitter). The
         * next session's bytes would be appended mid-frame and force a lossy
         * resync, garbling the first frames — start the new session with clean
         * framing state instead. Per-client tcp-server decoders are already
         * dropped on 'peer-disconnect'.
         */
        const shared = node._decoders.get(SHARED_STREAM_KEY);
        if (shared) {
          node._decoders.delete(SHARED_STREAM_KEY);
          shared.destroy();
        }
        setStatus('reconnecting', 'Reconnecting...');
      });
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

    if (startInactive) {
      /**
       * A dependency failed at construction (#238): finish as a DEACTIVATED
       * connection — full runtime API, subscriptions registry, and the
       * flows:started reconcile all live — but no codec and no transport.
       * Sends reject with the recorded reason via inactiveRejection(); once
       * the profile/identity is fixed or re-created on a later deploy,
       * reconcileRequiredConfig() reactivate()s this node in place, exactly
       * like a connection whose dependency was deleted mid-flight.
       */
      node._active = false;
      node._inactiveError = new MavlinkError(startInactive.code, startInactive.message);
      setStatus('error', startInactive.message);
    } else {
      /**
       * Construction succeeded: the connection is live. Set this before starting
       * the transport so the 'listening'/'connected' handlers that fire the first
       * heartbeat see an active connection (#116).
       */
      node._active = true;
      startTransport();
    }

    // --- lifecycle (DESIGN.md §19) ------------------------------------------
    node.on('close', function closeConnection(done) {
      /**
       * Node-RED aborts the deploy if a close handler throws synchronously, and
       * hangs it if done() is never called or is called twice (issue #140). So
       * synchronous teardown runs inside try/catch — a throw in decoder.destroy()
       * or any clear() is logged, not propagated — and done() is funnelled
       * through finish(), which fires exactly once no matter which branch (or a
       * stop() that rejects, throws, or never settles) reaches it.
       */
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        done();
      };
      try {
        /**
         * Mark the node dead first: a reactivate() scheduled before this close
         * ran (profile restored, then node removed in the next deploy) would
         * otherwise see `_active` still true once the pending teardown settles
         * and start a fresh transport on a closed node — a bound socket nothing
         * can ever stop, and EADDRINUSE for the replacement node.
         */
        node._active = false;
        stopHeartbeats();
        node.subscriptions.clear();
        node.locks.clear();
        node._codecByProfile.clear();
        if (node._queue) {
          node._queue.clear();
        }
        destroyDecoders();
        node.emitter.removeAllListeners();
        /**
         * Async teardown can still emit on this emitter after the listeners are
         * gone (an in-flight send's callback failing once the socket is
         * destroyed, a transport 'error' re-emitted by the handler above). An
         * 'error' emit with zero listeners throws, which at this point means an
         * unhandled rejection or uncaughtException that kills all of Node-RED —
         * keep a no-op listener for the emitter's remaining lifetime, exactly
         * like the transports do on their sockets in stop() (#149).
         */
        node.emitter.on('error', () => {});
      } catch (err) {
        node.error(`Error tearing down connection on close: ${err && err.message ? err.message : err}`);
      }
      node.statusState = 'closed';
      node.statusDetail = 'Connection closed';

      /**
       * A prior deactivate() nulls _transport but leaves its stop() promise on
       * _deactivating; await whichever is pending so Node-RED does not signal
       * this node closed (and let a replacement bind the same port) while the
       * old socket is still open — the EADDRINUSE this guards against.
       */
      let pending = node._deactivating;
      if (node._transport) {
        const transport = node._transport;
        node._transport = null;
        try {
          pending = transport.stop();
        } catch (err) {
          node.error(`Error stopping transport on close: ${err && err.message ? err.message : err}`);
          pending = null;
        }
      }
      if (pending && typeof pending.then === 'function') {
        const guard = setTimeout(finish, CLOSE_STOP_TIMEOUT_MS);
        if (typeof guard.unref === 'function') {
          guard.unref();
        }
        const done1 = () => {
          clearTimeout(guard);
          finish();
        };
        pending.then(done1, done1);
      } else {
        finish();
      }
    });
  }

  /**
   * The signing passphrase is a credential so it lives in the encrypted
   * credential store, never in exported flow JSON. Declaring it here is what
   * makes the runtime populate node.credentials.signingPassphrase (the editor's
   * credentials block alone is not enough).
   */
  RED.nodes.registerType('mavlink-ai-connection', MavlinkAiConnectionNode, {
    credentials: {
      signingPassphrase: { type: 'password' }
    }
  });
};

// --- helpers ----------------------------------------------------------------

/**
 * Parse the additional-identity binding list (#228). Accepts an array (tests,
 * programmatic configs) or the JSON string the editor persists. Each entry:
 * { identity: <config-node id or unique name>, allowOutbound?: boolean,
 * heartbeat?: boolean, heartbeatIntervalMs?: number }.
 *
 * @param {*} raw
 * @returns {Array<object>} normalized binding specs
 * @throws {MavlinkError} ADDITIONAL_IDENTITIES_INVALID
 */
function parseIdentityBindings(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  let entries = raw;
  if (typeof raw === 'string') {
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      throw new MavlinkError(
        'ADDITIONAL_IDENTITIES_INVALID',
        `Additional Local Identities is not valid JSON: ${err.message}`
      );
    }
  }
  if (!Array.isArray(entries)) {
    throw new MavlinkError('ADDITIONAL_IDENTITIES_INVALID', 'Additional Local Identities must be a list.');
  }
  return entries.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || !entry.identity) {
      throw new MavlinkError(
        'ADDITIONAL_IDENTITIES_INVALID',
        `Additional Local Identity binding ${i + 1} must be an object naming an 'identity'.`
      );
    }
    const intervalMs = Number(entry.heartbeatIntervalMs);
    return {
      identity: entry.identity,
      allowOutbound: entry.allowOutbound !== false,
      heartbeat: entry.heartbeat === true,
      heartbeatIntervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : HEARTBEAT_MIN_INTERVAL_MS
    };
  });
}

/**
 * Human-readable list of a connection's additional identity bindings for the
 * LOCAL_IDENTITY_NOT_ATTACHED error, or '' when there are none.
 *
 * @param {object} node
 * @returns {string}
 */
function describeBindings(node) {
  if (!node._identityBindings.length) {
    return '';
  }
  const labels = node._identityBindings.map((spec) => {
    try {
      const identity = node.resolveLocalIdentity(spec.identity);
      return `'${identity.describe()}'${spec.allowOutbound === false ? ' (outbound disabled)' : ''}`;
    } catch (e) {
      return `'${spec.identity}' (unresolved)`;
    }
  });
  return ` and additional binding(s) ${labels.join(', ')}`;
}

/**
 * Resolve one outbound target id from its two possible locations (#84):
 * top-level `message.target_system` / `message.target_component` and the
 * field-level copy inside `message.fields`. Numeric strings and numbers that
 * represent the same id are equal; a real disagreement throws so the packet
 * can never be routed to one system while addressing another. When neither
 * location is set the profile default applies.
 *
 * @param {string} name  'target_system' | 'target_component' (for the error)
 * @param {*} topLevel   message-level value
 * @param {*} fieldLevel value inside message.fields
 * @param {*} fallback   profile default
 * @returns {number|undefined} the resolved numeric id
 * @throws {MavlinkError} TARGET_CONFLICT | BAD_TARGET
 */
function resolveTargetId(name, topLevel, fieldLevel, fallback) {
  /** Coerce a supplied value to a number, rejecting non-numeric input. */
  const coerce = (value, where) => {
    // Blank means "not set" (a common shape for an empty Node-RED field) and
    // falls through to the other location / profile default — Number('') is
    // 0, which would silently address the broadcast target instead.
    if (value === undefined || value === null || String(value).trim() === '') {
      return undefined;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new MavlinkError('BAD_TARGET', `${name} (${where}) must be numeric (got ${JSON.stringify(value)}).`, {
        field: name,
        value
      });
    }
    return n;
  };
  const top = coerce(topLevel, 'top-level');
  const field = coerce(fieldLevel, 'fields');
  if (top !== undefined && field !== undefined && top !== field) {
    throw new MavlinkError(
      'TARGET_CONFLICT',
      `Conflicting ${name}: top-level ${top} != fields.${name} ${field}. Set one location, or make them agree.`,
      { field: name, top_level: top, field_level: field }
    );
  }
  const chosen = top !== undefined ? top : field;
  if (chosen !== undefined) {
    return chosen;
  }
  return coerce(fallback, 'profile default');
}

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
  node.resolveLocalIdentity = () => node.localIdentity || null;
  node.resolveOutboundIdentity = () => {
    throw new MavlinkError('CONNECTION_INVALID', `Connection '${node.name}' is not initialised.`);
  };
  node.getDefaultIdentity = () => node.localIdentity || null;
  node.identityBindingCount = () => 0;
  node.getProfileForPacket = () => null;
  node.acquireLock = () => {
    throw new MavlinkError('CONNECTION_INVALID', `Connection '${node.name}' is not initialised.`);
  };
  node.releaseLock = () => false;
  node.send = rejected('send');
  node.sendRaw = rejected('sendRaw');
  node.on('close', (done) => done());
}
