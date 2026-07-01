'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { MavlinkError } = require('../util/errors');

/**
 * TCP transport (DESIGN.md §17.3). Secondary to UDP/serial.
 *
 * Modes:
 *   tcp-client  connect out to host:port
 *   tcp-server  listen on host:port, fan out to connected clients
 *
 * Events: 'listening'|'connected', 'data' (Buffer, rinfo), 'error', 'close'
 */
class TcpTransport extends EventEmitter {
  constructor(config = {}) {
    super();
    this.mode = config.mode || 'tcp-client';
    this.host = config.host || '127.0.0.1';
    this.port = Number(config.port || 5760);
    this.reconnect = config.reconnect !== false;
    this.reconnectDelayMs = Number(config.reconnectDelayMs || 2000);
    this.client = null;
    this.server = null;
    this.sockets = new Set();
    this._reconnectTimer = null;
    this._closing = false;
  }

  /**
   * Transport descriptor attached to decoded messages (§14.1 `transport`).
   *
   * @returns {{name: string, type: string, remoteHost: string, remotePort: number}}
   */
  get descriptor() {
    return { name: this.name, type: this.mode, remoteHost: this.host, remotePort: this.port };
  }

  /**
   * Start the transport in client or server mode based on `this.mode`.
   *
   * @returns {void}
   */
  start() {
    this._closing = false;
    if (this.mode === 'tcp-server') {
      this._startServer();
    } else {
      this._startClient();
    }
  }

  /**
   * Listen for inbound TCP connections and fan their data out as `data` events.
   *
   * @returns {void}
   */
  _startServer() {
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      const rinfo = { address: socket.remoteAddress, port: socket.remotePort };
      socket.on('data', (buffer) => this.emit('data', buffer, rinfo));
      socket.on('error', (err) =>
        this.emit('error', new MavlinkError('TCP_ERROR', err.message, rinfo))
      );
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    server.on('error', (err) =>
      this.emit('error', new MavlinkError('TCP_ERROR', err.message, { port: this.port }))
    );
    server.listen(this.port, this.host, () => {
      this.emit('listening', server.address());
    });
  }

  /**
   * Connect out to the configured host/port, with optional auto-reconnect.
   *
   * @returns {void}
   */
  _startClient() {
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.client = socket;
    const rinfo = { address: this.host, port: this.port };
    socket.on('connect', () => this.emit('connected', rinfo));
    socket.on('data', (buffer) => this.emit('data', buffer, rinfo));
    socket.on('error', (err) =>
      this.emit('error', new MavlinkError('TCP_ERROR', err.message, rinfo))
    );
    socket.on('close', () => {
      this.client = null;
      if (!this._closing && this.reconnect) {
        this._scheduleReconnect();
      } else {
        this.emit('close');
      }
    });
  }

  /**
   * Schedule a client reconnect attempt after `reconnectDelayMs`.
   *
   * @returns {void}
   */
  _scheduleReconnect() {
    this.emit('reconnecting');
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this._closing) {
        this._startClient();
      }
    }, this.reconnectDelayMs);
  }

  /**
   * Send a buffer: to all connected clients (server mode) or to the upstream
   * connection (client mode).
   *
   * @param {Buffer} buffer
   * @returns {Promise<void>}
   */
  send(buffer) {
    return new Promise((resolve, reject) => {
      if (this.mode === 'tcp-server') {
        if (this.sockets.size === 0) {
          reject(new MavlinkError('TCP_NO_CLIENT', 'No connected TCP clients to send to.'));
          return;
        }
        // Resolve once every client write has flushed. Don't fail the whole
        // broadcast just because one client errored (the others already got the
        // bytes, and a caller retrying non-idempotent commands would resend to
        // clients that already received them). Only reject if every write fails.
        Promise.allSettled(
          [...this.sockets].map(
            (socket) =>
              new Promise((res, rej) => {
                socket.write(buffer, (err) => (err ? rej(new MavlinkError('TCP_SEND_FAILED', err.message)) : res()));
              })
          )
        ).then((results) => {
          const failures = results.filter((r) => r.status === 'rejected');
          failures.forEach((f) => this.emit('error', f.reason));
          if (failures.length === results.length) {
            reject(new MavlinkError('TCP_SEND_FAILED', 'All client writes failed.'));
          } else {
            resolve();
          }
        });
        return;
      }
      if (!this.client || this.client.destroyed) {
        reject(new MavlinkError('TCP_NOT_CONNECTED', 'TCP client is not connected.'));
        return;
      }
      this.client.write(buffer, (err) => {
        if (err) {
          reject(new MavlinkError('TCP_SEND_FAILED', err.message));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Tear down client/server sockets and cancel any pending reconnect.
   *
   * @returns {Promise<void>} resolves once everything is closed
   */
  stop() {
    return new Promise((resolve) => {
      this._closing = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      const done = () => resolve();
      if (this.client) {
        this.client.removeAllListeners();
        this.client.destroy();
        this.client = null;
      }
      for (const socket of this.sockets) {
        socket.removeAllListeners();
        socket.destroy();
      }
      this.sockets.clear();
      if (this.server) {
        const server = this.server;
        this.server = null;
        server.removeAllListeners();
        try {
          server.close(() => done());
          return;
        } catch (e) {
          /* fall through */
        }
      }
      done();
    });
  }
}

module.exports = { TcpTransport };
