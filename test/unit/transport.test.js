'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const net = require('net');
const { createTransport } = require('../../lib/transport');
const { UdpTransport, validateDestination } = require('../../lib/transport/udp-transport');
const { TcpTransport } = require('../../lib/transport/tcp-transport');
const { SerialTransport } = require('../../lib/transport/serial-transport');

/** Poll `cond` until it returns truthy or the timeout elapses. */
async function waitFor(cond, timeoutMs = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

test('validateDestination accepts good targets and rejects bad ones (#77)', () => {
  assert.strictEqual(validateDestination({ address: '127.0.0.1', port: 14550 }), null);

  const emptyAddr = validateDestination({ address: '', port: 14550 });
  assert.strictEqual(emptyAddr.code, 'UDP_INVALID_DEST');
  assert.deepStrictEqual(emptyAddr.context, { address: '', port: 14550 });

  assert.strictEqual(validateDestination({ address: null, port: 14550 }).code, 'UDP_INVALID_DEST');
  assert.strictEqual(validateDestination({ address: '127.0.0.1', port: 0 }).code, 'UDP_INVALID_DEST');
  assert.strictEqual(validateDestination({ address: '127.0.0.1', port: 70000 }).code, 'UDP_INVALID_DEST');
  assert.strictEqual(validateDestination({ address: '127.0.0.1', port: 1.5 }).code, 'UDP_INVALID_DEST');
});

test('udp send rejects an out-of-range manual destination before the socket send (#77)', async () => {
  // A truthy-but-invalid manual remote port passes _target's presence check and
  // must be caught by destination validation instead of reaching the socket.
  const transport = new UdpTransport({ mode: 'udp-out', remoteHost: '127.0.0.1', remotePort: 70000 });
  await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });
  await assert.rejects(
    () => transport.send(Buffer.from([1])),
    (err) => err.code === 'UDP_INVALID_DEST' && err.context.port === 70000
  );
  await transport.stop();
});

test('tcp server destroys a client socket after its error and drops it (#78)', async () => {
  const transport = new TcpTransport({ mode: 'tcp-server', host: '127.0.0.1' });
  transport.port = 0; // ephemeral port to avoid fixed-port conflicts in CI
  const errorsSeen = [];
  transport.on('error', (e) => errorsSeen.push(e));
  const addr = await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });

  const client = net.connect(addr.port, '127.0.0.1');
  await new Promise((resolve) => client.on('connect', resolve));
  await waitFor(() => transport.sockets.size === 1);
  const [tracked] = [...transport.sockets];

  const closed = new Promise((resolve) => tracked.on('close', resolve));
  tracked.emit('error', new Error('boom'));
  await closed;

  assert.strictEqual(tracked.destroyed, true);
  assert.strictEqual(transport.sockets.size, 0);
  assert.ok(errorsSeen.some((e) => e.code === 'TCP_ERROR'));

  client.destroy();
  await transport.stop();
});
