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

test('factory forwards the reconnect flag to the UDP transport (#149)', () => {
  /**
   * Bind recovery itself is not gated on this flag (the editor hides Reconnect
   * for udp), but the factory still forwards it for API consistency with the
   * connection-oriented transports.
   */
  assert.strictEqual(createTransport({ transport: 'udp-in', reconnect: false }).reconnect, false);
  assert.strictEqual(createTransport({ transport: 'udp-in' }).reconnect, true);
});

test('udp-peer learns peer and round-trips bytes', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  const addr = await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });

  const peer = dgram.createSocket('udp4');
  await new Promise((resolve) => peer.bind(0, '127.0.0.1', resolve));

  // A MAVLink-shaped frame claiming sysid 5 (v2 magic; sysid at offset 5).
  const frame = Buffer.from([0xfd, 1, 0, 0, 0, 5, 1, 0, 0, 0, 42]);
  const received = new Promise((resolve) => transport.on('data', (buf) => resolve(buf)));
  peer.send(frame, addr.port, '127.0.0.1');
  const got = await received;
  assert.deepStrictEqual([...got], [...frame]);

  // Receipt alone is not trust (#85): the connection confirms the peer once
  // the packet passes validation, and only then can the transport reply.
  await assert.rejects(() => transport.send(Buffer.from([9, 9])), (err) => err.code === 'UDP_NO_PEER');
  transport.confirmPeer(5);
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

test('serial fails clearly on an unsupported Node.js runtime (#102)', () => {
  const { loadSerialPort } = require('../../lib/transport/serial-transport');
  const original = Object.getOwnPropertyDescriptor(process, 'version');
  Object.defineProperty(process, 'version', { value: 'v18.19.0', configurable: true });
  try {
    assert.throws(() => loadSerialPort(), (err) => {
      assert.strictEqual(err.code, 'SERIALPORT_UNSUPPORTED_RUNTIME');
      assert.match(err.message, /Serial transport requires Node\.js 20/);
      return true;
    });
  } finally {
    Object.defineProperty(process, 'version', original);
  }
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

  /** Addressed sends go to the owning endpoint, not the last sender. */
  assert.deepStrictEqual(transport._target({ targetSystem: 1 }), { address: '127.0.0.1', port: 11111 });
  assert.deepStrictEqual(transport._target({ targetSystem: 2 }), { address: '127.0.0.1', port: 22222 });
  /** An unknown *specific* sysid falls back to the learned fallback peer. */
  assert.deepStrictEqual(transport._target({ targetSystem: 9 }), { address: '127.0.0.1', port: 22222 });
  /** Broadcast (0) and untargeted sends fan out to every known peer (#148). */
  const bothPeers = [
    { address: '127.0.0.1', port: 11111 },
    { address: '127.0.0.1', port: 22222 }
  ];
  assert.deepStrictEqual(transport._targets({ targetSystem: 0 }), bothPeers);
  assert.deepStrictEqual(transport._targets(), bothPeers);

  // A manual remote override beats everything.
  transport.remoteHost = '10.0.0.1';
  transport.remotePort = 14550;
  assert.deepStrictEqual(transport._target({ targetSystem: 1 }), { address: '10.0.0.1', port: 14550 });
});

test('udp-peer observes candidates but only confirmPeer commits mappings (#21, #85)', async () => {
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

  // Receipt alone commits nothing (#85): no fallback peer, no sysid mapping.
  assert.strictEqual(transport.learnedPeer, null);
  assert.strictEqual(transport.peersBySysid.size, 0);
  assert.strictEqual(transport._target(), null);

  // The connection confirms after validation; only then do mappings appear.
  transport.confirmPeer(1);
  transport.confirmPeer(2);
  assert.strictEqual(transport.peersBySysid.get(1).port, v1.address().port);
  assert.strictEqual(transport.peersBySysid.get(2).port, v2.address().port);
  assert.strictEqual(transport.learnedPeer.port, v2.address().port);

  // Confirming a sysid never observed is a no-op.
  transport.confirmPeer(99);
  assert.strictEqual(transport.peersBySysid.has(99), false);

  await transport.stop();
  await new Promise((r) => v1.close(r));
  await new Promise((r) => v2.close(r));
});

test('udp-peer broadcast (target_system 0) fans out to every learned peer (#148)', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  const addr = await new Promise((resolve) => { transport.on('listening', resolve); transport.start(); });

  const v1 = dgram.createSocket('udp4');
  const v2 = dgram.createSocket('udp4');
  await new Promise((r) => v1.bind(0, '127.0.0.1', r));
  await new Promise((r) => v2.bind(0, '127.0.0.1', r));

  const got1 = new Promise((resolve) => v1.on('message', resolve));
  const got2 = new Promise((resolve) => v2.on('message', resolve));

  const twoSeen = new Promise((resolve) => { let n = 0; transport.on('data', () => { if (++n === 2) resolve(); }); });
  v1.send(Buffer.from([0xfd, 9, 0, 0, 0, 1, 1, 0, 0, 0]), addr.port, '127.0.0.1');
  v2.send(Buffer.from([0xfe, 9, 0, 2, 1, 0]), addr.port, '127.0.0.1');
  await twoSeen;
  transport.confirmPeer(1);
  transport.confirmPeer(2);

  /** A broadcast must reach both vehicles, not only the last sender. */
  await transport.send(Buffer.from([1, 2, 3]), { targetSystem: 0 });
  const [m1, m2] = await Promise.all([got1, got2]);
  assert.deepStrictEqual([...m1], [1, 2, 3]);
  assert.deepStrictEqual([...m2], [1, 2, 3]);

  await transport.stop();
  await new Promise((r) => v1.close(r));
  await new Promise((r) => v2.close(r));
});

test('a later GCS confirmation does not steal the fallback; untargeted sends still reach the vehicle (#148)', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  const addr = await new Promise((resolve) => { transport.on('listening', resolve); transport.start(); });

  const vehicle = dgram.createSocket('udp4');
  const gcs = dgram.createSocket('udp4');
  await new Promise((r) => vehicle.bind(0, '127.0.0.1', r));
  await new Promise((r) => gcs.bind(0, '127.0.0.1', r));

  const gotVehicle = new Promise((resolve) => vehicle.on('message', resolve));

  const twoSeen = new Promise((resolve) => { let n = 0; transport.on('data', () => { if (++n === 2) resolve(); }); });
  /** Vehicle sysid 1 speaks first; a GCS at sysid 255 confirms later. */
  vehicle.send(Buffer.from([0xfd, 9, 0, 0, 0, 1, 1, 0, 0, 0]), addr.port, '127.0.0.1');
  gcs.send(Buffer.from([0xfd, 9, 0, 0, 0, 255, 1, 0, 0, 0]), addr.port, '127.0.0.1');
  await twoSeen;

  transport.confirmPeer(1);
  transport.confirmPeer(255);

  assert.strictEqual(transport.learnedPeer.port, vehicle.address().port, 'GCS did not steal the fallback');

  /** An untargeted send fans out to all peers, so the vehicle still gets it. */
  await transport.send(Buffer.from([7]), {});
  const m = await gotVehicle;
  assert.deepStrictEqual([...m], [7]);

  await transport.stop();
  await new Promise((r) => vehicle.close(r));
  await new Promise((r) => gcs.close(r));
});

test('non-MAVLink datagrams never become peer candidates (#85)', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  const addr = await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });
  const noise = dgram.createSocket('udp4');
  await new Promise((r) => noise.bind(0, '127.0.0.1', r));
  const seen = new Promise((resolve) => transport.on('data', resolve));
  noise.send(Buffer.from('definitely not mavlink'), addr.port, '127.0.0.1');
  await seen;

  assert.strictEqual(transport._candidatesBySysid.size, 0);
  transport.confirmPeer(1);
  assert.strictEqual(transport.learnedPeer, null);
  assert.strictEqual(transport.peersBySysid.size, 0);

  await transport.stop();
  await new Promise((r) => noise.close(r));
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

test('udp stop() keeps an error handler so a late socket error does not crash (#149)', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });
  const socket = transport.socket;
  await transport.stop();
  /** Without the swallow handler this unhandled 'error' would throw and crash. */
  assert.doesNotThrow(() => socket.emit('error', new Error('late close error')));
});

test('tcp stop() keeps an error handler so a late server error does not crash (#149)', async () => {
  const transport = new TcpTransport({ mode: 'tcp-server', host: '127.0.0.1' });
  transport.port = 0;
  const server = await new Promise((resolve) => {
    transport.on('listening', () => resolve(transport.server));
    transport.start();
  });
  await transport.stop();
  assert.doesNotThrow(() => server.emit('error', new Error('late close error')));
});

test('udp bind failure is not terminal: it retries and binds once the port frees (#149)', async (t) => {
  /** Occupy a fixed port so the transport's first bind hits EADDRINUSE. */
  const blocker = dgram.createSocket({ type: 'udp4' });
  const port = await new Promise((resolve) => blocker.bind(0, '127.0.0.1', () => resolve(blocker.address().port)));

  /**
   * reconnect:false on purpose — the editor hides the Reconnect control for all
   * udp modes, so bind recovery must not be gated on that hidden flag (#149).
   */
  const transport = new UdpTransport({ mode: 'udp-in', bindAddress: '127.0.0.1', bindPort: port, reconnect: false, reconnectDelayMs: 15 });
  /** The reconnect timer is unref'd (must not hold the process open); keep the test's loop alive so it can fire. */
  const keepAlive = setInterval(() => {}, 5);
  t.after(() => {
    clearInterval(keepAlive);
    return transport.stop();
  });
  const errors = [];
  transport.on('error', (e) => errors.push(e));

  /** First bind fails → a retry is scheduled (not terminal). */
  const reconnecting = new Promise((resolve) => transport.once('reconnecting', resolve));
  transport.start();
  await reconnecting;
  assert.ok(errors.some((e) => e.code === 'UDP_ERROR'), 'the bind failure was surfaced');

  /** Free the port; a subsequent retry must succeed and bind. */
  await new Promise((resolve) => blocker.close(resolve));
  const addr = await new Promise((resolve) => transport.on('listening', resolve));
  assert.strictEqual(addr.port, port);
});

test('tcp-server listen failure is not terminal: it retries and listens once the port frees (#149)', async (t) => {
  /** Occupy a fixed port so the transport's first listen hits EADDRINUSE. */
  const blocker = net.createServer();
  const port = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));

  /**
   * reconnect:false on purpose — the editor hides the Reconnect control for
   * tcp-server, so bind recovery must not be gated on that hidden flag (#149).
   */
  const transport = new TcpTransport({ mode: 'tcp-server', host: '127.0.0.1', port, reconnect: false, reconnectDelayMs: 15 });
  /** The reconnect timer is unref'd; keep the test's loop alive so it can fire. */
  const keepAlive = setInterval(() => {}, 5);
  t.after(() => {
    clearInterval(keepAlive);
    return transport.stop();
  });
  const errors = [];
  transport.on('error', (e) => errors.push(e));

  /** First listen fails → a retry is scheduled (server mode was previously terminal). */
  const reconnecting = new Promise((resolve) => transport.once('reconnecting', resolve));
  transport.start();
  await reconnecting;
  assert.ok(errors.some((e) => e.code === 'TCP_ERROR'), 'the listen failure was surfaced');

  /** Free the port; a subsequent retry must succeed and listen. */
  await new Promise((resolve) => blocker.close(resolve));
  const addr = await new Promise((resolve) => transport.on('listening', resolve));
  assert.strictEqual(addr.port, port);
});

test('tcp-server stamps a distinct clientId per client and emits peer-disconnect on close (#147)', async (t) => {
  const transport = new TcpTransport({ mode: 'tcp-server', host: '127.0.0.1' });
  transport.port = 0;
  const addr = await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });
  t.after(() => transport.stop());

  const seen = [];
  transport.on('data', (buf, rinfo) => seen.push(rinfo));

  const c1 = net.connect(addr.port, '127.0.0.1');
  await new Promise((r) => c1.on('connect', r));
  const c2 = net.connect(addr.port, '127.0.0.1');
  await new Promise((r) => c2.on('connect', r));
  await waitFor(() => transport.sockets.size === 2);

  c1.write(Buffer.from([0x01]));
  c2.write(Buffer.from([0x02]));
  await waitFor(() => new Set(seen.map((r) => r.clientId)).size === 2);

  const ids = [...new Set(seen.map((r) => r.clientId))];
  assert.ok(
    ids.every((id) => Number.isInteger(id)) && ids[0] !== ids[1],
    'each client stream carries a distinct integer clientId'
  );

  /** Closing one client fires peer-disconnect for that exact client's stream. */
  const disconnect = new Promise((resolve) => transport.once('peer-disconnect', resolve));
  c1.destroy();
  const gone = await disconnect;
  assert.ok(ids.includes(gone.clientId), 'peer-disconnect carries the disconnected client id');

  c2.destroy();
});

test('tcp-server broadcast is not blocked by a stalled client, which is kicked (#147)', async (t) => {
  /** Short write timeout so the stalled client is dropped quickly. */
  const transport = new TcpTransport({ mode: 'tcp-server', writeTimeoutMs: 30 });
  /** send()'s per-client timeout is unref'd; keep the loop alive so it fires. */
  const keepAlive = setInterval(() => {}, 5);
  t.after(() => clearInterval(keepAlive));
  const errors = [];
  transport.on('error', (e) => errors.push(e));

  const healthy = {
    destroyed: false,
    writableLength: 0,
    written: 0,
    write(buf, cb) {
      this.written += 1;
      setImmediate(() => cb());
    },
    destroy() {
      this.destroyed = true;
    }
  };
  /** A client whose write callback never fires — a dead radio the kernel keeps alive. */
  const stalled = {
    destroyed: false,
    writableLength: 0,
    write() {},
    destroy() {
      this.destroyed = true;
    }
  };
  transport.sockets.add(healthy);
  transport.sockets.add(stalled);

  await transport.send(Buffer.from([1, 2, 3]));

  assert.strictEqual(healthy.written, 1, 'the healthy client received the broadcast');
  assert.strictEqual(stalled.destroyed, true, 'the stalled client was kicked');
  assert.ok(errors.some((e) => e.code === 'TCP_SEND_TIMEOUT'), 'the stall was surfaced');
});

test('tcp-server drops a client already backed up past the backlog cap without waiting (#147)', async () => {
  const transport = new TcpTransport({ mode: 'tcp-server' });
  const errors = [];
  transport.on('error', (e) => errors.push(e));

  const healthy = {
    destroyed: false,
    writableLength: 0,
    written: 0,
    write(buf, cb) {
      this.written += 1;
      setImmediate(() => cb());
    },
    destroy() {
      this.destroyed = true;
    }
  };
  /** Backlog over the 1 MiB cap: dropped immediately, not after the write timeout. */
  const backedUp = {
    destroyed: false,
    writableLength: (1 << 20) + 1,
    write() {
      throw new Error('write must not be attempted on a client over the backlog cap');
    },
    destroy() {
      this.destroyed = true;
    }
  };
  transport.sockets.add(healthy);
  transport.sockets.add(backedUp);

  await transport.send(Buffer.from([9]));

  assert.strictEqual(healthy.written, 1, 'the healthy client still got the bytes');
  assert.strictEqual(backedUp.destroyed, true, 'the backed-up client was dropped');
  assert.ok(errors.some((e) => e.code === 'TCP_CLIENT_BACKPRESSURE'), 'backpressure was surfaced');
});
