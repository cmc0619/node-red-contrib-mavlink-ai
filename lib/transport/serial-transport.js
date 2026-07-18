'use strict';

const { EventEmitter } = require('events');
const { MavlinkError } = require('../util/errors');
const { boundedWrite, DEFAULT_WRITE_TIMEOUT_MS } = require('./bounded-write');
const { scheduleReconnect } = require('./reconnect-backoff');

/**
 * Serial transport (DESIGN.md §17.2, §18).
 *
 * `serialport` is an OPTIONAL dependency. It must never be required at module
 * load time, and UDP/TCP users must be able to run without it installed. It is
 * lazy-loaded only when a serial transport is actually started.
 */

/**
 * Lowest Node.js major the bundled `serialport` (v13) supports. Below this the
 * package either won't install or its native binding fails to load with an
 * opaque error, so a serial transport on an older runtime must fail with a
 * clear message instead (issue #102).
 */
const SERIALPORT_MIN_NODE_MAJOR = 20;

/**
 * Parse the running Node.js major version.
 *
 * @returns {number} e.g. 22, or NaN if it can't be determined
 */
function nodeMajor() {
  const m = /^v?(\d+)\./.exec(process.version || '');
  return m ? Number(m[1]) : NaN;
}

function loadSerialPort() {
  const major = nodeMajor();
  if (Number.isFinite(major) && major < SERIALPORT_MIN_NODE_MAJOR) {
    throw new MavlinkError(
      'SERIALPORT_UNSUPPORTED_RUNTIME',
      `Serial transport requires Node.js ${SERIALPORT_MIN_NODE_MAJOR}+ (optional dependency 'serialport'); ` +
        `this process is Node ${process.version}. Upgrade Node.js or select a UDP/TCP transport.`
    );
  }
  try {
    return require('serialport');
  } catch {
    throw new MavlinkError(
      'SERIALPORT_MISSING',
      "Serial transport requires optional dependency 'serialport'. " +
        'Install it (npm install serialport) or select a UDP/TCP transport.'
    );
  }
}

class SerialTransport extends EventEmitter {
  constructor(config = {}) {
    super();
    this.path = config.serialPath || config.path || '';
    this.baudRate = Number(config.serialBaud || config.baudRate || 57600);
    this.dataBits = Number(config.serialDataBits || config.dataBits || 8);
    this.stopBits = Number(config.serialStopBits || config.stopBits || 1);
    this.parity = config.serialParity || config.parity || 'none';
    this.reconnect = config.reconnect !== false;
    this.reconnectDelayMs = Number(config.reconnectDelayMs || 2000);
    /** Completion deadline per write (#237): a dead device whose write callback
     * never fires must not hold the shared outbound drain loop open forever. */
    this.writeTimeoutMs = Number(config.writeTimeoutMs || DEFAULT_WRITE_TIMEOUT_MS);
    this.port = null;
    this._reconnectTimer = null;
    /** Grows the backoff delay per consecutive failed reopen; reset on a successful open (#149). */
    this._reconnectAttempts = 0;
    this._closing = false;
  }

  /**
   * Transport descriptor attached to decoded messages (§14.1 `transport`).
   *
   * @returns {{name: string, type: string, path: string, baudRate: number}}
   */
  get descriptor() {
    return { name: this.name, type: 'serial', path: this.path, baudRate: this.baudRate };
  }

  /**
   * Open the serial port (lazy-loading `serialport`) and emit transport events.
   * Emits a clear `SERIAL_NO_PATH` error when no device path is configured.
   *
   * @returns {void}
   */
  start() {
    this._closing = false;
    if (!this.path) {
      this.emit('error', new MavlinkError('SERIAL_NO_PATH', 'Serial transport requires a device path.'));
      return;
    }
    const { SerialPort } = loadSerialPort();
    const port = new SerialPort(
      {
        path: this.path,
        baudRate: this.baudRate,
        dataBits: this.dataBits,
        stopBits: this.stopBits,
        parity: this.parity,
        autoOpen: false
      }
    );
    this.port = port;

    port.on('data', (buffer) => this.emit('data', buffer, { path: this.path }));
    port.on('error', (err) =>
      this.emit('error', new MavlinkError('SERIAL_ERROR', err.message, { path: this.path }))
    );
    port.on('close', () => {
      if (!this._closing && this.reconnect) {
        this._scheduleReconnect();
      } else {
        this.emit('close');
      }
    });

    port.open((err) => {
      // stop() may have run (and cleared this.port) while the open was in
      // flight. Ignore late completions and close the stray handle.
      if (this._closing || this.port !== port) {
        if (!err && port.isOpen) {
          try {
            port.close(() => {});
          } catch {
            /* best-effort */
          }
        }
        return;
      }
      if (err) {
        this.emit('error', new MavlinkError('SERIAL_OPEN_FAILED', err.message, { path: this.path }));
        if (!this._closing && this.reconnect) {
          this._scheduleReconnect();
        }
        return;
      }
      this._reconnectAttempts = 0;
      this.emit('connected', { path: this.path, baudRate: this.baudRate });
    });
  }

  /**
   * Schedule a reopen attempt via the shared backoff + jitter policy (#149,
   * see reconnect-backoff). start() can throw synchronously here (serialport
   * constructor validation, loadSerialPort() edge cases) — the shared helper
   * surfaces that as a transport error and keeps retrying.
   *
   * @returns {void}
   */
  _scheduleReconnect() {
    scheduleReconnect(this, 'SERIAL_ERROR', () => ({ path: this.path }));
  }

  /**
   * Write a buffer to the open serial port.
   *
   * @param {Buffer} buffer
   * @returns {Promise<void>}
   */
  send(buffer) {
    if (!this.port || !this.port.isOpen) {
      return Promise.reject(new MavlinkError('SERIAL_NOT_OPEN', 'Serial port is not open.'));
    }
    /**
     * Bounded write (#237): a dead device the kernel still lists can accept
     * write() and never invoke the callback — without a deadline that one
     * stalled write blocks the single outbound drain loop until the queue
     * fills and every later send (heartbeats included) rejects.
     */
    const port = this.port;
    return boundedWrite({
      write: (cb) => port.write(buffer, cb),
      timeoutMs: this.writeTimeoutMs,
      timeoutError: () => new MavlinkError('SERIAL_SEND_TIMEOUT', `Serial write did not complete within ${this.writeTimeoutMs} ms.`),
      wrapError: (err) => new MavlinkError('SERIAL_SEND_FAILED', err.message)
    });
  }

  /**
   * Close the serial port and cancel any pending reconnect.
   *
   * @returns {Promise<void>} resolves once the port is closed
   */
  stop() {
    return new Promise((resolve) => {
      this._closing = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      if (!this.port) {
        resolve();
        return;
      }
      const port = this.port;
      this.port = null;
      port.removeAllListeners();
      /**
       * Keep a no-op 'error' handler through the async close: serialport can
       * emit a device error while close() is in flight, and a listener-less
       * EventEmitter turns that into a process-killing uncaughtException (#149).
       */
      port.on('error', () => {});
      try {
        if (port.isOpen) {
          port.close(() => resolve());
        } else {
          resolve();
        }
      } catch {
        resolve();
      }
    });
  }
}

module.exports = { SerialTransport, loadSerialPort };
