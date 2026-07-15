'use strict';

const { EventEmitter } = require('events');
const { MavlinkCodec } = require('../lib/protocol/mavlink-codec');
const { createTransport } = require('../lib/transport');
const { validateConnectionConfig } = require('../lib/transport/transport-fields');
const { PacketRouter } = require('../lib/routing/packet-router');
const { SubscriptionRegistry } = require('../lib/runtime/subscription-registry');
const { OutboundQueue } = require('../lib/runtime/outbound-queue');
const { LockManager } = require('../lib/runtime/lock-manager');
const { statusPayload } = require('../lib/util/status');
const { toInt, toBool, parseIdList, firstDefined } = require('../lib/util/validation');
const { MavlinkError, toMavlinkError, errorPayload } = require('../lib/util/errors');

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
 * signature is verified per profile policy); a frame setting any other bit is
 * rejected in onPacket rather than decoded with an unknown framing (#153).
 */
const KNOWN_INCOMPAT_FLAGS = 0x01;

/**
 * Stream key for transports that multiplex a single peer's byte stream (udp,
 * serial, tcp-client). They share one decoder; only tcp-server hands out a
 * per-client `clientId` so each client gets its own stream splitter (#147).
 */
const SHARED_STREAM_KEY = '__shared__';

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
     * Whether this connection is live. A connection whose required default
     * profile is missing/invalid fails closed (#116): it is marked inactive,
     * its transport is released, and new sends reject until a valid default
     * profile is restored on a later deploy.
     */
    node._active = false;
    /** The structured error describing why the connection is inactive, if it is. */
    node._inactiveError = null;
    /**
     * Set by {@link reactivate}: a promise that settles once a restored default
     * profile's transport restart has been attempted. Null until a reactivation.
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

    // --- profile / codec setup ----------------------------------------------
    if (!node.profile) {
      fatal('NO_PROFILE', 'Connection has no profile configured.');
      registerNoop(node);
      return;
    }
    if (!node.profile.isValid()) {
      const err = node.profile.getError();
      fatal((err && err.code) || 'PROFILE_INVALID', `Profile invalid: ${err && err.message}`);
      registerNoop(node);
      return;
    }

    try {
      node._codec = new MavlinkCodec(
        Object.assign({ bundle: node.profile.getDialect() }, node.profile.getProtocolOptions())
      );
      node._codecByProfile.set(node.profile.id, { profile: node.profile, codec: node._codec });
    } catch (err) {
      fatal('CODEC_INIT_FAILED', err.message);
      registerNoop(node);
      return;
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
     * Resolve (and cache) the codec for a resolved profile. The default
     * profile uses the connection codec; any other profile must be a valid
     * profile config node — an invalid dialect or a failed codec build throws
     * instead of silently falling back to the default codec, which would
     * decode/sign/encode with the wrong dialect while claiming the profile.
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
      if (typeof profile.getDialect !== 'function' || !profile.isValid || !profile.isValid()) {
        const detail = profile.getError && profile.getError() ? `: ${profile.getError().message}` : '';
        throw new MavlinkError(
          'PROFILE_INVALID',
          `Profile '${profile.name || profile.id}' has no valid dialect${detail}`
        );
      }
      let codec;
      try {
        codec = new MavlinkCodec(
          Object.assign({ bundle: profile.getDialect() }, profile.getProtocolOptions())
        );
      } catch (err) {
        throw new MavlinkError(
          'CODEC_INIT_FAILED',
          `Cannot build codec for profile '${profile.name || profile.id}': ${err.message}`
        );
      }
      if (profile.id) {
        node._codecByProfile.set(profile.id, { profile, codec });
      }
      return codec;
    }

    /**
     * Resolve the effective profile for an outbound message. No reference means
     * the connection's default profile. An explicit reference must resolve to a
     * real, valid profile config node — silently falling back to the default
     * would encode with the wrong dialect, source identity, version, signing,
     * and target defaults, which is exactly the failure the reference exists to
     * prevent (#68).
     *
     * @param {string|object} [profileRef]  message.profile (config-node id,
     *   legacy unique name, or profile object)
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
          `Outbound message names profile '${profile.name || profile.id}' whose dialect failed to load${err ? `: ${err.message}` : '.'}`,
          { profile: profile.name || profile.id }
        );
      }
      return profile;
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
     * falls back to the default profile (a routed packet must not be decoded,
     * signature-checked, or encoded with a dialect other than the one its
     * route names).
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
        if (typeof ref.getDialect === 'function') {
          return ref;
        }
        throw new MavlinkError(
          'PROFILE_UNRESOLVED',
          `Profile reference ${JSON.stringify(ref && ref.name ? ref.name : ref)} is not a mavlink-ai-profile config node.`
        );
      }
      const byId = RED.nodes.getNode(ref);
      if (byId && typeof byId.getDialect === 'function') {
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
        if (cached && typeof cached.getDialect === 'function' && cached.name === ref) {
          return cached;
        }
        profileByName.delete(ref);
      }
      const matchIds = [];
      if (typeof RED.nodes.eachNode === 'function') {
        RED.nodes.eachNode((n) => {
          if (n.type === 'mavlink-ai-profile' && n.name === ref) {
            matchIds.push(n.id);
          }
        });
      } else if (node.profile && node.profile.name === ref) {
        matchIds.push(node.profile.id);
      }
      if (matchIds.length > 1) {
        throw new MavlinkError(
          'PROFILE_AMBIGUOUS',
          `Profile name '${ref}' matches ${matchIds.length} profile config nodes; reference the profile by config-node id.`
        );
      }
      const byName = matchIds.length === 1 ? RED.nodes.getNode(matchIds[0]) : null;
      if (byName && typeof byName.getDialect === 'function') {
        profileByName.set(ref, byName.id);
        return byName;
      }
      throw new MavlinkError(
        'PROFILE_UNRESOLVED',
        `Profile '${ref}' does not match any mavlink-ai-profile config node (by id or unique name).`
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
        const bundle = profile && typeof profile.getDialect === 'function' ? profile.getDialect() : null;
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
     * That stale state is why an already-running connection kept decoding with
     * the pre-edit dialect (message 441 rejected as 'common') until Node-RED was
     * restarted. Swapping all of it here applies the edit on the next deploy.
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
      const codec = new MavlinkCodec(
        Object.assign({ bundle: newProfile.getDialect() }, newProfile.getProtocolOptions())
      );
      // The transport/session and its learned peers stay up across this rebuild,
      // so carry over the per-peer wire versions the old codec detected (#69):
      // otherwise an `auto` profile would frame the next send to an already-known
      // v1-only vehicle as v2 (which it ignores) until another inbound frame
      // re-teaches the version.
      if (node._codec) {
        codec.adoptDetectedVersions(node._codec);
      }
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
     * Tear the connection down to a fail-closed, inactive state (#116). Used
     * when the required default profile has been deleted or become invalid: the
     * connection must stop decoding and commanding vehicles, and release its
     * transport (UDP/TCP/serial) immediately rather than leaving a socket bound
     * after the configuration that justified it was removed.
     *
     * Subscriptions are intentionally retained so a later deploy that restores a
     * valid profile can {@link reactivate} and resume delivering to the same
     * subscribers; everything profile-dependent (codecs, decoder, name cache,
     * mission locks) is dropped.
     *
     * @param {string} code     structured error code (NO_PROFILE | PROFILE_INVALID | ...)
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
      stopHeartbeat();
      /** Reject queued outbound work; new sends reject via the _active guard. */
      if (node._queue) {
        node._queue.clear();
      }
      /**
       * Drop every profile-dependent artifact so nothing keeps decoding or
       * commanding with the removed profile.
       */
      node._codecByProfile.clear();
      node._activeProfiles = new Set();
      profileByName.clear();
      loggedRouteProblems.clear();
      node.locks.clear();
      destroyDecoders();
      node.statusState = 'error';
      node.statusDetail = message;
      node.emitter.emit('status', node.getStatus());
      node.error(`mavlink-ai-connection '${node.name || node.id}': ${code}: ${message}`);
      /**
       * Release the bound transport so its port/handle is freed immediately —
       * a deleted profile must not leave the socket bound (EADDRINUSE) until
       * Node-RED restarts.
       */
      const transport = node._transport;
      node._transport = null;
      node._deactivating = transport ? Promise.resolve(transport.stop()).catch(() => {}) : Promise.resolve();
      return node._deactivating;
    }

    /**
     * Bring a previously {@link deactivate}d connection back up around a freshly
     * resolved, valid default profile (#116). Rebuilds the codec/router state and
     * restarts the transport on the same config so a profile that was deleted and
     * then re-created on a later deploy resumes without recreating this config
     * node. Waits for any in-flight teardown to finish first so the port is free
     * before it is rebound.
     *
     * @param {object} profile  the restored, valid default profile config node
     * @returns {void}
     */
    function reactivate(profile) {
      let codec;
      try {
        codec = new MavlinkCodec(
          Object.assign({ bundle: profile.getDialect() }, profile.getProtocolOptions())
        );
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
      node._codec = codec;
      node._codecByProfile.clear();
      node._codecByProfile.set(profile.id, { profile, codec });
      node._router.defaultProfile = profile;
      profileByName.clear();
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
     * Reconcile the connection's required default profile on every deploy (#116).
     *
     * - Missing or invalid  -> fail closed: {@link deactivate}.
     * - Restored after a prior deactivation -> {@link reactivate}.
     * - Edited under the same id (a different object) while still running ->
     *   {@link rebuildProfileState} hot-reload, no transport restart.
     *
     * @returns {void}
     */
    function reconcileDefaultProfile() {
      const resolved = RED.nodes.getNode(config.profile);
      const isProfileNode = resolved && typeof resolved.getDialect === 'function';
      const valid = isProfileNode && resolved.isValid && resolved.isValid();
      if (!valid) {
        const code = !isProfileNode ? 'NO_PROFILE' : 'PROFILE_INVALID';
        const err = isProfileNode && resolved.getError && resolved.getError();
        const message =
          code === 'NO_PROFILE'
            ? 'Required default profile has been deleted; connection deactivated and transport released.'
            : `Required default profile '${resolved.name || resolved.id}' is invalid; ` +
              `connection deactivated and transport released.${err ? ` ${err.message}` : ''}`;
        deactivate(code, message);
        return;
      }
      if (!node._active) {
        /** A valid default profile is back after a prior deactivation. */
        reactivate(resolved);
        return;
      }
      if (resolved !== node.profile) {
        /** A valid edited profile under the same id: hot-reload in place. */
        try {
          rebuildProfileState(resolved);
        } catch (err) {
          const e = toMavlinkError(err, 'CODEC_INIT_FAILED');
          deactivate(
            e.code || 'CODEC_INIT_FAILED',
            `Failed to apply edited default profile '${resolved.name || resolved.id}': ${e.message}`
          );
        }
      }
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
       * changed, so reconcile all profile dependencies here — Node-RED cannot
       * see the profile edits/deletions that matter (default edits, and route
       * profiles embedded in serialized JSON) as dependencies of this node.
       *
       * @returns {void}
       */
      const onFlowsStarted = () => {
        /**
         * Re-scan legacy name lookups so a deleted/renamed/now-ambiguous name
         * never resolves to a stale object (#118).
         */
        profileByName.clear();
        /** Fail closed / reactivate / hot-reload the required default profile (#116). */
        reconcileDefaultProfile();
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
     * defaults from the effective profile (message.profile, or the connection
     * default).
     *
     * @param {object} message  { name, fields, profile?, target_system?, target_component? }
     * @param {object} [options]  { priority, coalesceKey } — coalesceKey lets a
     *   periodic sender (e.g. the heartbeat) supersede its own still-queued copy
     *   rather than accumulate behind a slow transport.
     * @returns {Promise<void>}
     */
    /**
     * The rejection for a send attempted while the connection is failed-closed
     * (#116). Carries the deactivation reason (NO_PROFILE / PROFILE_INVALID) so
     * callers see a clear structured error instead of a generic transport miss.
     *
     * @returns {MavlinkError}
     */
    function inactiveRejection() {
      const e = node._inactiveError;
      return e
        ? new MavlinkError(e.code, e.message, e.context)
        : new MavlinkError('CONNECTION_INACTIVE', `Connection '${node.name || node.id}' is inactive.`);
    }

    node.send = (message, options = {}) => {
      if (!node._active) {
        return Promise.reject(inactiveRejection());
      }
      if (!message || typeof message !== 'object') {
        return Promise.reject(new MavlinkError('BAD_OUTBOUND', 'Outbound message must be an object.'));
      }
      // The profile named on the message is the effective profile for the whole
      // send: it supplies the codec (dialect, source identity, version, signing
      // — #68) *and* the target defaults, so a send addressed through a
      // non-default profile doesn't inherit the default profile's targets. An
      // explicit profile that can't be resolved rejects rather than silently
      // sending as the default.
      let profile;
      try {
        profile = resolveOutboundProfile(message.profile);
      } catch (err) {
        return Promise.reject(toMavlinkError(err, 'PROFILE_UNRESOLVED'));
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
       *   - encoding: under `mavlinkVersion: 'auto'`, `effectiveVersion` picks
       *     the wire version from the target sysid, so passing the profile
       *     default target would frame an untargeted HEARTBEAT as that peer's
       *     version (e.g. v2) and a learned v1-only vehicle would miss it. With
       *     no target the encoder uses the connection's own detected default.
       * (A genuinely mixed v1/v2 fleet still can't be reached by a single
       * broadcast frame — that's inherent to MAVLink versioning, not this path.)
       */
      const routingTargetSystem = codec.addressesTarget(message.name) ? targetSystem : undefined;
      let buffer;
      try {
        buffer = codec.encode(message.name, fields, { targetSystem: routingTargetSystem, targetComponent });
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
      // Track the peer's wire version, keyed by its sysid, so an "auto" profile
      // frames outbound packets the way *that* peer speaks — a v1-only vehicle
      // ignores v2 frames, and a mixed fleet must not have one peer's version
      // flip framing for all of them (#69). Noted on the default codec (which
      // encodes outbound) here; the matched profile's codec is updated below.
      /**
       * Read the wire version from the actual first frame byte, not
       * header.magic: node-mavlink's v1 parser never sets header.magic (it
       * stays 0), so a v1 (0xFE) frame would otherwise never be detected (#138).
       */
      const wireMagic = packet.buffer && packet.buffer.length ? packet.buffer[0] : header.magic;
      node._codec.noteInboundMagic(wireMagic, header.sysid);

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
      // Give the matched profile's codec the same per-peer version observation,
      // so a send that encodes with that profile's codec frames to the peer's
      // version too (#69). No-op when it is the default codec (already noted).
      if (codec !== node._codec) {
        codec.noteInboundMagic(wireMagic, header.sysid);
      }

      // 3. MAVLink 2 signature verification (issue #15), using the *matched
      //    profile's* codec so a routed system is checked against its own
      //    signing policy/key rather than the default profile's. Verification
      //    is a no-op (returns null) unless that profile enables it, so
      //    unsigned setups are unaffected. Runs after routing but before decode
      //    so an unauthentic frame never reaches subscribers.
      const sigDecision = codec.verifyInboundPacket(packet);
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
      // satisfied the matched profile's signature policy. Tell a udp-peer
      // transport to commit the observed endpoint for this sysid — malformed,
      // route-rejected, or signature-rejected traffic never reaches here, so
      // it can never redirect outbound packets.
      if (node._transport && typeof node._transport.confirmPeer === 'function') {
        node._transport.confirmPeer(header.sysid);
      }

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
          .send(
            { name: 'HEARTBEAT', fields: node.profile.getHeartbeatFields() },
            // Background priority, but coalesced: if a prior heartbeat is still
            // queued behind slower-draining traffic, this tick supersedes it
            // instead of stacking a second stale copy (#150). Age promotion in
            // the queue keeps the surviving heartbeat from being starved.
            { priority: 3, coalesceKey: 'heartbeat' }
          )
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

    /**
     * Construction succeeded: the connection is live. Set this before starting
     * the transport so the 'listening'/'connected' handlers that fire the first
     * heartbeat see an active connection (#116).
     */
    node._active = true;
    startTransport();

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
        stopHeartbeat();
        node.subscriptions.clear();
        node.locks.clear();
        node._codecByProfile.clear();
        if (node._queue) {
          node._queue.clear();
        }
        destroyDecoders();
        node.emitter.removeAllListeners();
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

  RED.nodes.registerType('mavlink-ai-connection', MavlinkAiConnectionNode);
};

// --- helpers ----------------------------------------------------------------

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
  node.getProfileForPacket = () => null;
  node.acquireLock = () => {
    throw new MavlinkError('CONNECTION_INVALID', `Connection '${node.name}' is not initialised.`);
  };
  node.releaseLock = () => false;
  node.send = rejected('send');
  node.sendRaw = rejected('sendRaw');
  node.on('close', (done) => done());
}
