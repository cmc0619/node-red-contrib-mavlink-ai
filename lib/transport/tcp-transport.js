'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { MavlinkError } = require('../util/errors');

/** Cap on the exponential reconnect backoff so retries stay responsive (#149). */
const RECONNECT_MAX_DELAY_MS = 30000;

/** Fraction of the backoff delay added as random jitter to desynchronize retries (#149). */
const RECONNECT_JITTER_FRACTION = 0.3;

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
    /** Grows the backoff delay per consecutive failed connect/listen; reset on success (#149). */
    this._reconnectAttempts = 0;
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
      socket.on('error', (err) => {
        this.emit('error', new MavlinkError('TCP_ERROR', err.message, rinfo));
        // A client that has errored won't recover — tear it down now instead of
        // waiting on an eventual close. destroy() is a no-op once destroyed, and
        // the 'close' handler below still removes it from this.sockets.
        if (!socket.destroyed) {
          socket.destroy();
        }
      });
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    server.on('error', (err) => {
      this.emit('error', new MavlinkError('TCP_ERROR', err.message, { port: this.port }));
      /**
       * A listen failure (EADDRINUSE on redeploy) leaves a dead server that
       * server mode otherwise never retries — reconnect was only ever wired for
       * tcp-client. Close the dead handle and reschedule so a transient port
       * conflict isn't permanent until a manual redeploy (#149).
       *
       * This bind recovery is deliberately NOT gated on `this.reconnect`: the
       * editor hides the Reconnect control for tcp-server (it's a client/serial
       * option), so a saved flow can carry a stale hidden `reconnect:false` the
       * user can't see or change. Gating on it would silently make the recovery
       * unavailable for exactly those flows. Recovering a failed *listen* is
       * startup resilience, distinct from the post-drop client reconnect that
       * the toggle governs.
       */
      if (this._closing || this.server !== server) {
        return;
      }
      this.server = null;
      server.removeAllListeners();
      server.on('error', () => {});
      try {
        server.close();
      } catch (e) {
        /** the server handle is already unusable — nothing to close */
      }
      this._scheduleReconnect();
    });
    server.listen(this.port, this.host, () => {
      this._reconnectAttempts = 0;
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
    socket.on('connect', () => {
      this._reconnectAttempts = 0;
      this.emit('connected', rinfo);
    });
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
   * Schedule a reconnect attempt (client reconnect or server relisten) with
   * exponential backoff (capped) plus jitter, so repeated failures don't hammer
   * the endpoint or resynchronize across connections retrying in lockstep. Calls
   * `start()` so it restarts in the transport's current mode (#149).
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
      if (!this._closing) {
        this.start();
      }
    }, delay);
    if (this._reconnectTimer && typeof this._reconnectTimer.unref === 'function') {
      this._reconnectTimer.unref();
    }
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
      /**
       * After removeAllListeners, keep a no-op 'error' handler on each live
       * handle through the async destroy()/close(): a late socket RST or server
       * error would otherwise hit a listener-less emitter and crash the process
       * with an uncaughtException (#149).
       */
      if (this.client) {
        this.client.removeAllListeners();
        this.client.on('error', () => {});
        this.client.destroy();
        this.client = null;
      }
      for (const socket of this.sockets) {
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.destroy();
      }
      this.sockets.clear();
      if (this.server) {
        const server = this.server;
        this.server = null;
        server.removeAllListeners();
        server.on('error', () => {});
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
