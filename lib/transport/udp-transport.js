'use strict';

const dgram = require('dgram');
const { EventEmitter } = require('events');
const { MavlinkError } = require('../util/errors');

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
 * Events: 'listening', 'data' (Buffer, rinfo), 'peer' (rinfo), 'error', 'close'
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

class UdpTransport extends EventEmitter {
  constructor(config = {}) {
    super();
    this.mode = config.mode || 'udp-peer';
    this.bindAddress = config.bindAddress || '0.0.0.0';
    this.bindPort = Number(config.bindPort || 14550);
    this.remoteHost = config.remoteHost || '';
    this.remotePort = Number(config.remotePort || 0);
    this.socket = null;
    this.learnedPeer = null; // { address, port } — most recent sender
    this.peersBySysid = new Map(); // sysid -> { address, port }
    this._closing = false;
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
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      this.emit('error', new MavlinkError('UDP_ERROR', err.message, { bindPort: this.bindPort }));
    });

    socket.on('message', (buffer, rinfo) => {
      if (this.mode === 'udp-out') {
        return; // send-only: ignore inbound
      }
      if (this.mode === 'udp-peer') {
        this.learnedPeer = { address: rinfo.address, port: rinfo.port };
        const sysid = sniffSysid(buffer);
        if (sysid != null) {
          this.peersBySysid.set(sysid, { address: rinfo.address, port: rinfo.port });
        }
        this.emit('peer', rinfo);
      }
      this.emit('data', buffer, rinfo);
    });

    if (this.mode === 'udp-out') {
      // No bind needed for pure send; bind ephemeral so we can send.
      socket.bind(0, () => {
        this.emit('listening', { sending: true });
      });
      return;
    }

    socket.on('listening', () => {
      this.emit('listening', socket.address());
    });
    socket.bind(this.bindPort, this.bindAddress);
  }

  /**
   * Resolve the current send target: manual override wins, then the endpoint
   * that owns the addressed target_system, then the most recent sender.
   *
   * @param {object} [meta]  { targetSystem } for per-sysid routing
   */
  _target(meta) {
    if (this.remoteHost && this.remotePort) {
      return { address: this.remoteHost, port: this.remotePort };
    }
    if (meta && meta.targetSystem != null) {
      const peer = this.peersBySysid.get(Number(meta.targetSystem));
      if (peer) {
        return peer;
      }
    }
    if (this.learnedPeer) {
      return this.learnedPeer;
    }
    return null;
  }

  /**
   * Send a buffer to the resolved target.
   *
   * @param {Buffer} buffer
   * @param {object} [meta]  { targetSystem } routes to that sysid's endpoint
   * @returns {Promise<void>}
   */
  send(buffer, meta) {
    return new Promise((resolve, reject) => {
      if (this.mode === 'udp-in') {
        reject(new MavlinkError('UDP_SEND_DISABLED', 'Transport udp-in is listen-only; cannot send.'));
        return;
      }
      const target = this._target(meta);
      if (!target) {
        reject(
          new MavlinkError(
            'UDP_NO_PEER',
            'No UDP peer to send to yet. Set a remote host/port or wait for an inbound packet (udp-peer).'
          )
        );
        return;
      }
      if (!this.socket) {
        reject(new MavlinkError('UDP_NOT_STARTED', 'UDP socket is not started.'));
        return;
      }
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
      this.learnedPeer = null;
      this.peersBySysid.clear();
      if (!this.socket) {
        resolve();
        return;
      }
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      try {
        socket.close(() => resolve());
      } catch (e) {
        resolve();
      }
    });
  }
}

module.exports = { UdpTransport, sniffSysid, validateDestination };
