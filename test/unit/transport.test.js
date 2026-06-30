'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const { createTransport } = require('../../lib/transport');
const { UdpTransport } = require('../../lib/transport/udp-transport');
const { TcpTransport } = require('../../lib/transport/tcp-transport');
const { SerialTransport } = require('../../lib/transport/serial-transport');

test('factory maps transport types (no serialport required for udp/tcp)', () => {
  assert.ok(createTransport({ transport: 'udp-peer' }) instanceof UdpTransport);
  assert.ok(createTransport({ transport: 'tcp-client' }) instanceof TcpTransport);
  assert.ok(createTransport({ transport: 'serial' }) instanceof SerialTransport);
});

test('udp-peer learns peer and round-trips bytes', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  const addr = await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });

  const peer = dgram.createSocket('udp4');
  await new Promise((resolve) => peer.bind(0, '127.0.0.1', resolve));

  const received = new Promise((resolve) => transport.on('data', (buf) => resolve(buf)));
  peer.send(Buffer.from([1, 2, 3]), addr.port, '127.0.0.1');
  const got = await received;
  assert.deepStrictEqual([...got], [1, 2, 3]);

  // After learning the peer, the transport can reply to it.
  const replyReceived = new Promise((resolve) => peer.on('message', (buf) => resolve(buf)));
  await transport.send(Buffer.from([9, 9]));
  const reply = await replyReceived;
  assert.deepStrictEqual([...reply], [9, 9]);

  await transport.stop();
  await new Promise((resolve) => peer.close(resolve));
});

test('udp-peer send before any peer rejects clearly', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });
  await assert.rejects(
    () => transport.send(Buffer.from([1])),
    (err) => err.code === 'UDP_NO_PEER'
  );
  await transport.stop();
});

test('serial start without a path errors clearly (does not need serialport)', async () => {
  const transport = new SerialTransport({ serialPath: '' });
  const err = await new Promise((resolve) => {
    transport.on('error', resolve);
    transport.start();
  });
  assert.strictEqual(err.code, 'SERIAL_NO_PATH');
});
