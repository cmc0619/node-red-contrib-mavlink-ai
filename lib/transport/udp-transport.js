'use strict';

const dgram = require('dgram');
const { EventEmitter } = require('events');
const { MavlinkError } = require('../util/errors');
const { toInt } = require('../util/validation');

/** Cap on the exponential rebind backoff so retries stay responsive (#149). */
const RECONNECT_MAX_DELAY_MS = 30000;

/** Fraction of the backoff delay added as random jitter to desynchronize retries (#149). */
const RECONNECT_JITTER_FRACTION = 0.3;

/**
 * UDP transport (DESIGN.md §17.1).
 *
 * Modes:
 *   udp-in    listen only
 *   udp-out   send only (to a fixed remote)
 *   udp-peer  listen, learn senders, and reply to them
 *
 * Peer tracking (issue #21): besides the most recent sender, udp-peer keeps a
 * per-sysid endpoint map (sniffed from the datagram's MAVLink header) so that
 * with multiple vehicles on one port, an outbound packet addressed to a
 * specific target_system goes to the endpoint that owns that sysid instead of
 * whichever vehicle spoke last. A manual remote host/port override wins.
 *
 * Trust boundary (#85): receiving a datagram only records the source endpoint
 * as a *candidate*, keyed by the sniffed sysid. Nothing is used for routing
 * until the connection calls {@link UdpTransport#confirmPeer} after the packet
 * has passed CRC/framing, route acceptance, and (when enabled) signature
 * verification. A malformed, route-rejected, or signature-rejected datagram
 * therefore never replaces the fallback peer or redirects a sysid's traffic.
 *
 * Events: 'listening', 'data' (Buffer, rinfo), 'peer' (endpoint, on confirm),
 * 'error'
 */

/**
 * Sniff the source sysid from the first MAVLink frame in a datagram. UDP
 * carries whole packets per datagram, and the sysid sits at a fixed offset
 * behind the magic byte (v2/0xFD: offset 5; v1/0xFE: offset 3).
 *
 * @param {Buffer} buffer
 * @returns {?number} source sysid, or null if the buffer isn't a MAVLink frame
 */
function sniffSysid(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return null;
  }
  if (buffer[0] === 0xfd && buffer.length > 5) {
    return buffer[5];
  }
  if (buffer[0] === 0xfe && buffer.length > 3) {
    return buffer[3];
  }
  return null;
}

/**
 * Validate a resolved UDP destination before handing it to the socket, so a
 * configuration mistake surfaces as a clear project error instead of a lower
 * level runtime failure. Returns a {@link MavlinkError} for an invalid target,
 * or null when the destination is usable.
 *
 * @param {{address: *, port: *}} target
 * @returns {?MavlinkError}
 */
function validateDestination(target) {
  const { address, port } = target;
  if (typeof address !== 'string' || address.trim() === '') {
    return new MavlinkError(
      'UDP_INVALID_DEST',
      'UDP destination address must be a non-empty string.',
      { address, port }
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return new MavlinkError(
      'UDP_INVALID_DEST',
      'UDP destination port must be an integer in [1, 65535].',
      { address, port }
    );
  }
  return null;
}

/**
 * Enable SO_BROADCAST on a bound socket. Without it, a broadcast destination
 * (e.g. remote host 192.168.1.255 for a SITL/router setup) makes every send
 * fail with EACCES and no hint. Standard MAVLink tooling (pymavlink, MAVProxy)
 * enables it unconditionally; harmless for unicast destinations.
 *
 * @param {import('dgram').Socket} socket
 * @returns {void}
 */
function enableBroadcast(socket) {
  try {
    socket.setBroadcast(true);
  } catch (e) {
    /** Not fatal for unicast use; broadcast sends will fail loudly instead. */
  }
}

/**
 * Whether a sysid is in the ground-station range. MAVLink convention puts GCSs
 * at the top of the sysid space (255 canonical; 250+ in practice) and vehicles
 * at the low end, so this heuristic keeps a GCS from stealing the fallback peer
 * from a vehicle (#148). It only gates the fallback endpoint — per-sysid routing
 * and broadcast fan-out are unaffected.
 *
 * @param {*} sysid
 * @returns {boolean}
 */
function isGcsSysid(sysid) {
  const n = Number(sysid);
  return Number.isFinite(n) && n >= 250;
}

/**
 * De-duplicate peer endpoints by address:port, preserving order, so a broadcast
 * fan-out never sends the same datagram to one endpoint twice (#148).
 *
 * @param {Iterable<{address: string, port: number}>} peers
 * @returns {object[]}
 */
function dedupeEndpoints(peers) {
  const seen = new Set();
  const out = [];
  for (const peer of peers) {
    const key = `${peer.address}:${peer.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(peer);
    }
  }
  return out;
}

class UdpTransport extends EventEmitter {
  constructor(config = {}) {
    super();
    this.mode = config.mode || 'udp-peer';
    this.bindAddress = config.bindAddress || '0.0.0.0';
    // Not `config.bindPort || 14550`: an explicit 0 means "ephemeral port"
    // and must stay 0, not silently turn into the default port.
    this.bindPort = toInt(config.bindPort, 14550);
    this.remoteHost = config.remoteHost || '';
    this.remotePort = toInt(config.remotePort, 0);
    this.reconnect = config.reconnect !== false;
    this.reconnectDelayMs = Number(config.reconnectDelayMs || 2000);
    this.socket = null;
    /** { address, port } — fallback endpoint for a send with no known per-sysid
     * peer. Prefers a vehicle over a GCS-range sysid (see confirmPeer, #148). */
    this.learnedPeer = null;
    /** sysid that owns the current learnedPeer, so a later GCS confirmation
     * can't steal the fallback from a vehicle (#148). */
    this._learnedPeerSysid = null;
    /** sysid -> { address, port } (validated). */
    this.peersBySysid = new Map();
    /**
     * Unvalidated observations (#85): sysid -> endpoint of the latest datagram
     * that *claimed* that sysid. Promoted into learnedPeer/peersBySysid only
     * via confirmPeer(), once the connection has validated a packet from it.
     */
    this._candidatesBySysid = new Map();
    this._closing = false;
    this._reconnectTimer = null;
    /**
     * Grows the backoff delay per consecutive failed bind; reset once the
     * socket successfully starts listening (#149).
     */
    this._reconnectAttempts = 0;
  }

  /**
   * Transport descriptor attached to decoded messages (§14.1 `transport`).
   *
   * @returns {{name: string, type: string, bindAddress: string, bindPort: number,
   *   remoteHost: ?string, remotePort: ?number}}
   */
  get descriptor() {
    return {
      name: this.name,
      type: this.mode,
      bindAddress: this.bindAddress,
      bindPort: this.bindPort,
      remoteHost: this.remoteHost || (this.learnedPeer && this.learnedPeer.address),
      remotePort: this.remotePort || (this.learnedPeer && this.learnedPeer.port)
    };
  }

  /**
   * Open the UDP socket and begin emitting `data`/`peer`/`listening` events.
   * For `udp-out` an ephemeral port is bound for sending only.
   *
   * @returns {void}
   */
  start() {
    this._closing = false;
    // No reuseAddr: with SO_REUSEADDR two UDP sockets (even in different
    // processes) can silently bind the same port — including a port picked by
    // bind(0) — and inbound datagrams are then split between them at random.
    // UDP has no TIME_WAIT, so reuseAddr buys nothing on redeploy; a genuine
    // double-bind should fail loudly with EADDRINUSE instead of quietly
    // stealing half the traffic.
    const socket = dgram.createSocket({ type: 'udp4' });
    this.socket = socket;

    socket.on('error', (err) => {
      this.emit('error', new MavlinkError('UDP_ERROR', err.message, { bindPort: this.bindPort }));
      /**
       * A bind failure (EADDRINUSE — common when a redeploy races the previous
       * socket's release) or a fatal socket error leaves a dead socket. Close it
       * and retry with backoff instead of staying permanently dead until a
       * manual redeploy (#149). Without this the socket that couldn't bind is
       * also never closed, leaking the handle.
       *
       * Not gated on `this.reconnect`: the editor hides the Reconnect control
       * for all udp modes, so a saved flow can carry a stale hidden
       * `reconnect:false` the user can't see or change; gating on it would
       * silently disable bind recovery for exactly those flows. Recovering a
       * failed bind is startup resilience, distinct from the post-drop client
       * reconnect that the toggle governs.
       */
      if (this._closing || this.socket !== socket) {
        return;
      }
      this.socket = null;
      socket.removeAllListeners();
      socket.on('error', () => {});
      try {
        socket.close();
      } catch (e) {
        /** the socket is already unusable — nothing to close */
      }
      this._scheduleReconnect();
    });

    socket.on('message', (buffer, rinfo) => {
      if (this.mode === 'udp-out') {
        return; // send-only: ignore inbound
      }
      if (this.mode === 'udp-peer') {
        // Observe only (#85): remember which endpoint claims this sysid, but
        // trust nothing until the connection validates a packet from it and
        // calls confirmPeer(). Datagrams that don't even sniff as MAVLink
        // can never become a peer.
        const sysid = sniffSysid(buffer);
        if (sysid != null) {
          this._candidatesBySysid.set(sysid, { address: rinfo.address, port: rinfo.port });
        }
      }
      this.emit('data', buffer, rinfo);
    });

    if (this.mode === 'udp-out') {
      // No bind needed for pure send; bind ephemeral so we can send.
      socket.bind(0, () => {
        this._reconnectAttempts = 0;
        enableBroadcast(socket);
        this.emit('listening', { sending: true });
      });
      return;
    }

    socket.on('listening', () => {
      this._reconnectAttempts = 0;
      enableBroadcast(socket);
      this.emit('listening', socket.address());
    });
    socket.bind(this.bindPort, this.bindAddress);
  }

  /**
   * Schedule a rebind attempt after a bind/socket failure, with exponential
   * backoff (capped) plus jitter so repeated failures don't hammer the port or
   * resynchronize across several connections retrying in lockstep (#149).
   *
   * @returns {void}
   */
  _scheduleReconnect() {
    this.emit('reconnecting');
    clearTimeout(this._reconnectTimer);
    const base = Math.min(this.reconnectDelayMs * 2 ** this._reconnectAttempts, RECONNECT_MAX_DELAY_MS);
    const delay = base + Math.floor(Math.random() * base * RECONNECT_JITTER_FRACTION);
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      if (this._closing) {
        return;
      }
      /**
       * A synchronous throw from start() inside a timer callback would be an
       * uncaughtException (process exit). Surface it as a transport error and
       * keep retrying with backoff instead.
       */
      try {
        this.start();
      } catch (err) {
        this.emit('error', new MavlinkError('UDP_ERROR', err && err.message ? err.message : String(err), { bindPort: this.bindPort }));
        this._scheduleReconnect();
      }
    }, delay);
    if (this._reconnectTimer && typeof this._reconnectTimer.unref === 'function') {
      this._reconnectTimer.unref();
    }
  }

  /**
   * Commit a sysid's candidate endpoint as a trusted, routable peer (#85).
   * Called by the connection after an inbound packet from `sysid` has passed
   * framing/CRC, route acceptance, and any signature verification policy.
   * The candidate was recorded when the datagram arrived; a packet only ever
   * confirms the endpoint that claimed its own header sysid.
   *
   * Residual caveat: candidates keep only the *latest* claimant per sysid, so
   * a forged datagram racing a genuine one inside the decode window could
   * still be the endpoint promoted — enable MAVLink 2 signing where endpoint
   * spoofing is a real concern (unsigned/invalid frames never confirm).
   *
   * @param {number} sysid  source system of the validated packet
   * @returns {void}
   */
  confirmPeer(sysid) {
    if (this.mode !== 'udp-peer' || sysid == null) {
      return;
    }
    const peer = this._candidatesBySysid.get(Number(sysid));
    if (!peer) {
      return;
    }
    const sys = Number(sysid);
    this.peersBySysid.set(sys, peer);
    /**
     * Update the fallback endpoint, but don't let a GCS-range sysid steal it
     * from a vehicle (#148): a second GCS on the port would otherwise capture
     * untargeted traffic (including our own heartbeat). Replace when there is no
     * fallback yet, when the same sysid re-confirms (its endpoint moved), or as
     * long as we're not demoting a vehicle fallback to a GCS one.
     */
    const replace =
      !this.learnedPeer ||
      this._learnedPeerSysid === sys ||
      !(isGcsSysid(sys) && !isGcsSysid(this._learnedPeerSysid));
    if (replace) {
      this.learnedPeer = peer;
      this._learnedPeerSysid = sys;
    }
    this.emit('peer', peer);
  }

  /**
   * Resolve a single send target. Retained for the per-sysid unicast case and
   * for callers/tests that ask "is there anywhere to send yet". Broadcast and
   * untargeted sends use {@link UdpTransport#_targets} to fan out (#148).
   *
   * @param {object} [meta]  { targetSystem } for per-sysid routing
   * @returns {object|null}
   */
  _target(meta) {
    const targets = this._targets(meta);
    return targets.length ? targets[0] : null;
  }

  /**
   * Resolve the list of endpoints a send should reach (#148):
   *
   * - a manual remote host/port override is the single destination;
   * - a specific nonzero `target_system` unicasts to that sysid's learned
   *   endpoint (falling back to `learnedPeer` when that sysid isn't known yet);
   * - a broadcast (`target_system` 0) or an untargeted send (no `targetSystem`)
   *   fans out to *every* learned peer — MAVLink routing delivers a broadcast to
   *   all known links, so with two vehicles on one port both must receive it,
   *   and our own heartbeat must reach every vehicle rather than only the last
   *   sender. Falls back to `learnedPeer` while no per-sysid peer is known.
   *
   * Endpoints are de-duplicated by address:port so peers sharing an endpoint
   * aren't sent to twice.
   *
   * @param {object} [meta]  { targetSystem }
   * @returns {object[]} zero or more { address, port }
   */
  _targets(meta) {
    if (this.remoteHost && this.remotePort) {
      return [{ address: this.remoteHost, port: this.remotePort }];
    }
    const targetSystem = meta && meta.targetSystem != null ? Number(meta.targetSystem) : null;
    if (targetSystem != null && targetSystem !== 0) {
      const peer = this.peersBySysid.get(targetSystem);
      if (peer) {
        return [peer];
      }
      return this.learnedPeer ? [this.learnedPeer] : [];
    }
    if (this.peersBySysid.size > 0) {
      return dedupeEndpoints(this.peersBySysid.values());
    }
    return this.learnedPeer ? [this.learnedPeer] : [];
  }

  /**
   * Send a buffer to the resolved target.
   *
   * @param {Buffer} buffer
   * @param {object} [meta]  { targetSystem } routes to that sysid's endpoint
   * @returns {Promise<void>}
   */
  send(buffer, meta) {
    if (this.mode === 'udp-in') {
      return Promise.reject(new MavlinkError('UDP_SEND_DISABLED', 'Transport udp-in is listen-only; cannot send.'));
    }
    const targets = this._targets(meta);
    if (targets.length === 0) {
      /**
       * udp-out never learns peers, so "wait for an inbound packet" would be
       * misleading there — the only fix is configuring the remote endpoint.
       */
      const hint =
        this.mode === 'udp-out'
          ? 'Transport udp-out requires a remote host and a remote port (1-65535).'
          : 'No UDP peer to send to yet. Set a remote host/port or wait for an inbound packet (udp-peer).';
      return Promise.reject(new MavlinkError('UDP_NO_PEER', hint));
    }
    if (!this.socket) {
      return Promise.reject(new MavlinkError('UDP_NOT_STARTED', 'UDP socket is not started.'));
    }
    /**
     * Fan out to every resolved endpoint. A broadcast/untargeted send is
     * best-effort: it resolves as long as one datagram went out and only
     * rejects when *every* endpoint failed, so one dead peer can't fail a
     * broadcast to healthy ones (#148). A unicast has a single endpoint, so
     * this preserves the original one-target success/failure semantics.
     */
    const sends = targets.map((target) => this._sendOne(buffer, target));
    return Promise.allSettled(sends).then((results) => {
      const rejected = results.filter((r) => r.status === 'rejected');
      /**
       * A partial fan-out failure (some peers sent, some failed) still counts
       * as success — the broadcast went out — but a dead/degraded peer would
       * otherwise be invisible. Surface it on a dedicated, non-'error' event so
       * an operator can observe it without an unlistened 'error' throwing.
       */
      if (rejected.length > 0 && rejected.length < results.length) {
        this.emit('sendPartialFailure', {
          failed: rejected.length,
          total: results.length,
          reasons: rejected.map((r) => r.reason)
        });
      }
      if (results.length > rejected.length) {
        return;
      }
      throw results[0].reason;
    });
  }

  /**
   * Send the buffer to one validated endpoint.
   *
   * @param {Buffer} buffer
   * @param {object} target  { address, port }
   * @returns {Promise<void>}
   */
  _sendOne(buffer, target) {
    return new Promise((resolve, reject) => {
      const invalid = validateDestination(target);
      if (invalid) {
        reject(invalid);
        return;
      }
      this.socket.send(buffer, target.port, target.address, (err) => {
        if (err) {
          reject(new MavlinkError('UDP_SEND_FAILED', err.message, target));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Close the socket and clear the learned peer.
   *
   * @returns {Promise<void>} resolves once the socket is closed
   */
  stop() {
    return new Promise((resolve) => {
      this._closing = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this.learnedPeer = null;
      this._learnedPeerSysid = null;
      this.peersBySysid.clear();
      this._candidatesBySysid.clear();
      if (!this.socket) {
        resolve();
        return;
      }
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      /**
       * Keep a no-op 'error' handler through the async close so a late socket
       * error during close() doesn't hit a listener-less emitter and crash the
       * process with an uncaughtException (#149).
       */
      socket.on('error', () => {});
      try {
        socket.close(() => resolve());
      } catch (e) {
        resolve();
      }
    });
  }
}

module.exports = { UdpTransport, sniffSysid, validateDestination };
