'use strict';

const { EventEmitter } = require('events');
const { MavlinkError } = require('../util/errors');

/**
 * Serial transport (DESIGN.md §17.2, §18).
 *
 * `serialport` is an OPTIONAL dependency. It must never be required at module
 * load time, and UDP/TCP users must be able to run without it installed. It is
 * lazy-loaded only when a serial transport is actually started.
 */
function loadSerialPort() {
  try {
    // eslint-disable-next-line global-require
    return require('serialport');
  } catch (err) {
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
    this.port = null;
    this._reconnectTimer = null;
    this._closing = false;
  }

  get descriptor() {
    return { name: this.name, type: 'serial', path: this.path, baudRate: this.baudRate };
  }

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
      if (err) {
        this.emit('error', new MavlinkError('SERIAL_OPEN_FAILED', err.message, { path: this.path }));
        if (!this._closing && this.reconnect) {
          this._scheduleReconnect();
        }
        return;
      }
      this.emit('connected', { path: this.path, baudRate: this.baudRate });
    });
  }

  _scheduleReconnect() {
    this.emit('reconnecting');
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this._closing) {
        this.start();
      }
    }, this.reconnectDelayMs);
  }

  send(buffer) {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        reject(new MavlinkError('SERIAL_NOT_OPEN', 'Serial port is not open.'));
        return;
      }
      this.port.write(buffer, (err) => {
        if (err) {
          reject(new MavlinkError('SERIAL_SEND_FAILED', err.message));
        } else {
          resolve();
        }
      });
    });
  }

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
      try {
        if (port.isOpen) {
          port.close(() => resolve());
        } else {
          resolve();
        }
      } catch (e) {
        resolve();
      }
    });
  }
}

module.exports = { SerialTransport, loadSerialPort };
