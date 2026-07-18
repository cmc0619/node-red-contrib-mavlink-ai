'use strict';

const { UdpTransport } = require('./udp-transport');
const { TcpTransport } = require('./tcp-transport');
const { SerialTransport } = require('./serial-transport');
const { isBlank } = require('./transport-fields');
const { MavlinkError } = require('../util/errors');

/**
 * Transport factory. Maps a connection config's `transport` protocol —
 * `udp`, `tcp`, or `serial` (#243) — to a concrete transport instance. The
 * TCP *role* is derived here from field presence: a filled remote host/port
 * dials out (client), a filled bind port accepts inbound (server); the
 * presence rules in transport-fields.js guarantee exactly one applies by the
 * time a validated config reaches this factory. Serial is constructed but only
 * pulls in `serialport` when started, so UDP/TCP users never need the optional
 * dependency.
 */
function createTransport(config = {}) {
  const type = config.transport || 'udp';
  let transport;

  switch (type) {
    case 'udp':
      transport = new UdpTransport({
        bindAddress: config.bindAddress,
        bindPort: config.bindPort,
        remoteHost: config.remoteHost,
        remotePort: config.remotePort,
        reconnect: config.reconnect
      });
      break;
    case 'tcp': {
      const role = !isBlank(config.remoteHost) || !isBlank(config.remotePort) ? 'client' : 'server';
      transport = new TcpTransport({
        role,
        host: role === 'server' ? config.bindAddress || '0.0.0.0' : config.remoteHost,
        port: role === 'server' ? config.bindPort : config.remotePort,
        reconnect: config.reconnect
      });
      break;
    }
    case 'serial':
      transport = new SerialTransport({
        serialPath: config.serialPath,
        serialBaud: config.serialBaud,
        serialDataBits: config.serialDataBits,
        serialStopBits: config.serialStopBits,
        serialParity: config.serialParity,
        reconnect: config.reconnect
      });
      break;
    default:
      throw new MavlinkError('UNKNOWN_TRANSPORT', `Unknown transport '${type}'.`, { transport: type });
  }

  transport.name = config.name;
  return transport;
}

module.exports = { createTransport };
