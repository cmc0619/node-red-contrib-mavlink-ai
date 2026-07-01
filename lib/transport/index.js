'use strict';

const { UdpTransport } = require('./udp-transport');
const { TcpTransport } = require('./tcp-transport');
const { SerialTransport } = require('./serial-transport');
const { MavlinkError } = require('../util/errors');

/**
 * Transport factory. Maps a connection config's `transport` field to a concrete
 * transport instance. Serial is constructed but only pulls in `serialport` when
 * started, so UDP/TCP users never need the optional dependency.
 */
function createTransport(config = {}) {
  const type = config.transport || 'udp-peer';
  let transport;

  switch (type) {
    case 'udp-in':
    case 'udp-out':
    case 'udp-peer':
      transport = new UdpTransport({
        mode: type,
        bindAddress: config.bindAddress,
        bindPort: config.bindPort,
        remoteHost: config.remoteHost,
        remotePort: config.remotePort
      });
      break;
    case 'tcp-client':
    case 'tcp-server':
      transport = new TcpTransport({
        mode: type,
        host: type === 'tcp-server' ? config.bindAddress || '0.0.0.0' : config.remoteHost || config.tcpHost,
        port: type === 'tcp-server' ? config.bindPort : config.remotePort || config.tcpPort,
        reconnect: config.reconnect
      });
      break;
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
