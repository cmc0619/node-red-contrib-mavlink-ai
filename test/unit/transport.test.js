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

test('sniffSysid reads the source sysid from v1/v2 frames (#21)', () => {
  const { sniffSysid } = require('../../lib/transport/udp-transport');
  // v2: magic 0xFD, sysid at offset 5.
  assert.strictEqual(sniffSysid(Buffer.from([0xfd, 9, 0, 0, 7, 42, 1, 0, 0, 0])), 42);
  // v1: magic 0xFE, sysid at offset 3.
  assert.strictEqual(sniffSysid(Buffer.from([0xfe, 9, 7, 17, 1, 0])), 17);
  // Not a MAVLink frame / truncated.
  assert.strictEqual(sniffSysid(Buffer.from([0x00, 1, 2, 3])), null);
  assert.strictEqual(sniffSysid(Buffer.from([0xfd, 9])), null);
  assert.strictEqual(sniffSysid('nope'), null);
});

test('udp-peer routes sends to the addressed sysid endpoint (#21)', () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  // Simulate two vehicles having been heard (as the message handler would).
  transport.peersBySysid.set(1, { address: '127.0.0.1', port: 11111 });
  transport.peersBySysid.set(2, { address: '127.0.0.1', port: 22222 });
  transport.learnedPeer = { address: '127.0.0.1', port: 22222 }; // vehicle 2 spoke last

  // Addressed sends go to the owning endpoint, not the last sender.
  assert.deepStrictEqual(transport._target({ targetSystem: 1 }), { address: '127.0.0.1', port: 11111 });
  assert.deepStrictEqual(transport._target({ targetSystem: 2 }), { address: '127.0.0.1', port: 22222 });
  // Unknown sysid / broadcast falls back to the last sender.
  assert.deepStrictEqual(transport._target({ targetSystem: 9 }), { address: '127.0.0.1', port: 22222 });
  assert.deepStrictEqual(transport._target(), { address: '127.0.0.1', port: 22222 });

  // A manual remote override beats everything.
  transport.remoteHost = '10.0.0.1';
  transport.remotePort = 14550;
  assert.deepStrictEqual(transport._target({ targetSystem: 1 }), { address: '10.0.0.1', port: 14550 });
});

test('udp-peer message handler learns per-sysid peers from sniffed frames (#21)', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  const addr = await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });
  const v1 = dgram.createSocket('udp4');
  const v2 = dgram.createSocket('udp4');
  await new Promise((r) => v1.bind(0, '127.0.0.1', r));
  await new Promise((r) => v2.bind(0, '127.0.0.1', r));

  const twoSeen = new Promise((resolve) => {
    let n = 0;
    transport.on('data', () => { n += 1; if (n === 2) resolve(); });
  });
  // Vehicle sysid 1 speaks v2 framing; vehicle sysid 2 speaks v1 framing.
  v1.send(Buffer.from([0xfd, 9, 0, 0, 0, 1, 1, 0, 0, 0]), addr.port, '127.0.0.1');
  v2.send(Buffer.from([0xfe, 9, 0, 2, 1, 0]), addr.port, '127.0.0.1');
  await twoSeen;

  assert.strictEqual(transport.peersBySysid.get(1).port, v1.address().port);
  assert.strictEqual(transport.peersBySysid.get(2).port, v2.address().port);

  await transport.stop();
  await new Promise((r) => v1.close(r));
  await new Promise((r) => v2.close(r));
});
