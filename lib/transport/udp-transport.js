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
 *   udp-peer  listen, learn the most recent sender, and reply to it
 *
 * Peer tracking is per-connection by default: the last valid datagram source
 * becomes the reply target unless a manual remote host/port override is set.
 *
 * Events: 'listening', 'data' (Buffer, rinfo), 'peer' (rinfo), 'error', 'close'
 */
class UdpTransport extends EventEmitter {
  constructor(config = {}) {
    super();
    this.mode = config.mode || 'udp-peer';
    this.bindAddress = config.bindAddress || '0.0.0.0';
    this.bindPort = Number(config.bindPort || 14550);
    this.remoteHost = config.remoteHost || '';
    this.remotePort = Number(config.remotePort || 0);
    this.socket = null;
    this.learnedPeer = null; // { address, port }
    this._closing = false;
  }

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
   * Resolve the current send target: manual override wins, otherwise the
   * learned peer (udp-peer), otherwise null.
   */
  _target() {
    if (this.remoteHost && this.remotePort) {
      return { address: this.remoteHost, port: this.remotePort };
    }
    if (this.learnedPeer) {
      return this.learnedPeer;
    }
    return null;
  }

  /**
   * Send a buffer to the resolved target.
   * @returns {Promise<void>}
   */
  send(buffer) {
    return new Promise((resolve, reject) => {
      if (this.mode === 'udp-in') {
        reject(new MavlinkError('UDP_SEND_DISABLED', 'Transport udp-in is listen-only; cannot send.'));
        return;
      }
      const target = this._target();
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
      this.socket.send(buffer, target.port, target.address, (err) => {
        if (err) {
          reject(new MavlinkError('UDP_SEND_FAILED', err.message, target));
        } else {
          resolve();
        }
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      this._closing = true;
      this.learnedPeer = null;
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

module.exports = { UdpTransport };
