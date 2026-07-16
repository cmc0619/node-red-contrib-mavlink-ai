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
  // the packet passes validation — with that packet's own source endpoint
  // (#239) — and only then can the transport reply.
  await assert.rejects(() => transport.send(Buffer.from([9, 9])), (err) => err.code === 'UDP_NO_PEER');
  transport.confirmPeer(5, { address: '127.0.0.1', port: peer.address().port });
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

test('udp-out with no remote rejects with UDP_NO_REMOTE, not the transient UDP_NO_PEER', async () => {
  /**
   * udp-out never learns a peer, so an empty target set is a permanent
   * misconfiguration — a distinct code so a fire-and-forget sender surfaces it
   * instead of quietly waiting for a peer that can never appear.
   */
  const transport = new UdpTransport({ mode: 'udp-out', bindAddress: '127.0.0.1', bindPort: 0 });
  await new Promise((resolve) => {
    transport.on('listening', resolve);
    transport.start();
  });
  await assert.rejects(
    () => transport.send(Buffer.from([1])),
    (err) => err.code === 'UDP_NO_REMOTE'
  );
  await transport.stop();
});

test('udp-peer send before bind completes rejects UDP_NOT_STARTED, not UDP_NO_PEER', async () => {
  /**
   * start() assigns this.socket synchronously, but bind() is async and may still
   * fail with EADDRINUSE. A send before 'listening' (socket assigned, not yet
   * bound) must reject with the distinct UDP_NOT_STARTED *before* the empty-target
   * check, so a listener that never actually bound can't masquerade as the
   * transient UDP_NO_PEER the Out node silently waits out (Codex review).
   */
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  /** Before start(): socket is null. */
  await assert.rejects(() => transport.send(Buffer.from([1])), (err) => err.code === 'UDP_NOT_STARTED');
  /** After start() but before the 'listening' event: socket assigned, not bound. */
  transport.start();
  assert.ok(transport.socket, 'start() assigns the socket synchronously');
  assert.strictEqual(transport._bound, false, 'but it is not bound until listening');
  await assert.rejects(() => transport.send(Buffer.from([1])), (err) => err.code === 'UDP_NOT_STARTED');
  await transport.stop();
});

test('tcp-server send before listen completes rejects TCP_NOT_LISTENING, not TCP_NO_CLIENT', async () => {
  /**
   * start() assigns this.server synchronously, but listen() is async and may
   * still fail (e.g. EADDRINUSE). A send before the listen callback (server
   * assigned, server.listening false) must reject with the distinct
   * TCP_NOT_LISTENING *before* the no-client check, so a server that never
   * actually listened can't masquerade as the transient TCP_NO_CLIENT the Out
   * node silently waits out (Codex review).
   */
  const transport = new TcpTransport({ mode: 'tcp-server', host: '127.0.0.1', port: 0 });
  /** Before start(): server is null. */
  await assert.rejects(() => transport.send(Buffer.from([1])), (err) => err.code === 'TCP_NOT_LISTENING');
  /** After start() but before the 'listening' callback: server assigned, not listening. */
  transport.start();
  assert.ok(transport.server, 'start() assigns the server synchronously');
  assert.strictEqual(transport.server.listening, false, 'but it is not listening yet');
  await assert.rejects(() => transport.send(Buffer.from([1])), (err) => err.code === 'TCP_NOT_LISTENING');
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

test('udp-peer receipt commits nothing; confirmPeer commits the validated endpoint (#21, #85, #239)', async () => {
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

  // The connection confirms after validation, passing each validated packet's
  // own datagram source (#239); only then do mappings appear.
  transport.confirmPeer(1, { address: '127.0.0.1', port: v1.address().port });
  transport.confirmPeer(2, { address: '127.0.0.1', port: v2.address().port });
  assert.strictEqual(transport.peersBySysid.get(1).port, v1.address().port);
  assert.strictEqual(transport.peersBySysid.get(2).port, v2.address().port);
  assert.strictEqual(transport.learnedPeer.port, v2.address().port);

  /** The stored peer is a copy — mutating the caller's endpoint later cannot
   * silently redirect the committed mapping. */
  const endpoint = { address: '127.0.0.1', port: v1.address().port };
  transport.confirmPeer(7, endpoint);
  endpoint.port = 1;
  assert.strictEqual(transport.peersBySysid.get(7).port, v1.address().port);

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
  transport.confirmPeer(1, { address: '127.0.0.1', port: v1.address().port });
  transport.confirmPeer(2, { address: '127.0.0.1', port: v2.address().port });

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
  const gotGcs = new Promise((resolve) => gcs.on('message', resolve));

  const twoSeen = new Promise((resolve) => { let n = 0; transport.on('data', () => { if (++n === 2) resolve(); }); });
  /** Vehicle sysid 1 speaks first; a GCS at sysid 255 confirms later. */
  vehicle.send(Buffer.from([0xfd, 9, 0, 0, 0, 1, 1, 0, 0, 0]), addr.port, '127.0.0.1');
  gcs.send(Buffer.from([0xfd, 9, 0, 0, 0, 255, 1, 0, 0, 0]), addr.port, '127.0.0.1');
  await twoSeen;

  transport.confirmPeer(1, { address: '127.0.0.1', port: vehicle.address().port });
  transport.confirmPeer(255, { address: '127.0.0.1', port: gcs.address().port });

  assert.strictEqual(transport.learnedPeer.port, vehicle.address().port, 'GCS did not steal the fallback');

  /** An untargeted send fans out to *every* peer: both the vehicle and the GCS
   * receive it, and the vehicle (the fallback owner) is not the only one. */
  await transport.send(Buffer.from([7]), {});
  const [mVehicle, mGcs] = await Promise.all([gotVehicle, gotGcs]);
  assert.deepStrictEqual([...mVehicle], [7]);
  assert.deepStrictEqual([...mGcs], [7]);

  await transport.stop();
  await new Promise((r) => vehicle.close(r));
  await new Promise((r) => gcs.close(r));
});

test('broadcast fan-out de-duplicates peers that share one endpoint (#148)', () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  /** Two sysids learned from the same socket resolve to a single endpoint;
   * the fan-out must send one datagram, not two. */
  transport.peersBySysid.set(1, { address: '127.0.0.1', port: 9999 });
  transport.peersBySysid.set(3, { address: '127.0.0.1', port: 9999 });
  assert.deepStrictEqual(transport._targets({ targetSystem: 0 }), [{ address: '127.0.0.1', port: 9999 }]);
});

test('a partial fan-out failure still resolves but emits sendPartialFailure (#148)', async () => {
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  await new Promise((resolve) => { transport.on('listening', resolve); transport.start(); });
  const good = dgram.createSocket('udp4');
  await new Promise((r) => good.bind(0, '127.0.0.1', r));

  /** One healthy endpoint and one that fails validation (port 0). */
  transport.peersBySysid.set(1, { address: '127.0.0.1', port: good.address().port });
  transport.peersBySysid.set(2, { address: '127.0.0.1', port: 0 });

  const gotGood = new Promise((resolve) => good.on('message', resolve));
  const partial = new Promise((resolve) => transport.on('sendPartialFailure', resolve));

  /** The broadcast still resolves — one datagram went out — while the dead peer
   * is surfaced on the dedicated event rather than swallowed. */
  await transport.send(Buffer.from([5]), { targetSystem: 0 });
  const info = await partial;
  assert.strictEqual(info.failed, 1);
  assert.strictEqual(info.total, 2);
  assert.deepStrictEqual([...(await gotGood)], [5]);

  await transport.stop();
  await new Promise((r) => good.close(r));
});

test('confirmPeer without a valid endpoint commits nothing (#85, #239)', async () => {
  /**
   * Trust comes only from a validated read's endpoint: a confirm with no
   * endpoint (e.g. a transport read that carried no source info) or with an
   * invalid one must be a no-op, so nothing but a real datagram source can
   * enter the routing tables.
   */
  const transport = new UdpTransport({ mode: 'udp-peer', bindAddress: '127.0.0.1', bindPort: 0 });
  transport.confirmPeer(1);
  transport.confirmPeer(1, null);
  transport.confirmPeer(1, { address: '', port: 14550 });
  transport.confirmPeer(1, { address: '127.0.0.1', port: 0 });
  transport.confirmPeer('bogus', { address: '127.0.0.1', port: 14550 });
  assert.strictEqual(transport.learnedPeer, null);
  assert.strictEqual(transport.peersBySysid.size, 0);
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
  /** A server with connected clients is, by definition, listening. */
  transport.server = { listening: true };
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
  /** A server with connected clients is, by definition, listening. */
  transport.server = { listening: true };
  transport.sockets.add(healthy);
  transport.sockets.add(backedUp);

  await transport.send(Buffer.from([9]));

  assert.strictEqual(healthy.written, 1, 'the healthy client still got the bytes');
  assert.strictEqual(backedUp.destroyed, true, 'the backed-up client was dropped');
  assert.ok(errors.some((e) => e.code === 'TCP_CLIENT_BACKPRESSURE'), 'backpressure was surfaced');
});

test('a serial write whose callback never fires times out with SERIAL_SEND_TIMEOUT (#237)', async (t) => {
  /**
   * A dead device the kernel still lists accepts write() and never calls back;
   * without a deadline that single write holds the shared outbound drain loop
   * open until the queue fills and every later send rejects.
   */
  const transport = new SerialTransport({ serialPath: '/dev/fake', writeTimeoutMs: 20 });
  transport.port = { isOpen: true, write() {} };
  /** The deadline timer is unref'd; keep the loop alive so it can fire. */
  const keepAlive = setInterval(() => {}, 5);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(() => transport.send(Buffer.from([1])), (e) => e.code === 'SERIAL_SEND_TIMEOUT');
});

test('a UDP send whose callback never fires times out with UDP_SEND_TIMEOUT (#237)', async (t) => {
  const transport = new UdpTransport({ mode: 'udp-peer', writeTimeoutMs: 20 });
  transport.socket = { send() {} };
  transport._bound = true;
  transport.remoteHost = '127.0.0.1';
  transport.remotePort = 14550;
  const keepAlive = setInterval(() => {}, 5);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(() => transport.send(Buffer.from([1])), (e) => e.code === 'UDP_SEND_TIMEOUT');
});
