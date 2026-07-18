'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');

/**
 * Runtime transport-config validation (issue #103). The editor validates
 * required endpoint/path settings before deploy, but a flow imported as JSON
 * (or authored before those validators existed) can still carry a blank
 * required field. The connection node must reject that combination loudly at
 * deploy — with a clear TRANSPORT_CONFIG_INVALID error and a safe no-op runtime
 * API — instead of silently starting and only failing later on the first send.
 */

function withProfile() {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p_default',
    name: 'Default',
    dialect: 'common',
    mavlinkVersion: 'v2'
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id_t',
    name: 'GCS',
    role: 'custom',
    sourceSystemId: 255,
    sourceComponentId: 190
  });
  return RED;
}

function connect(RED, config) {
  return RED.create(
    'mavlink-ai-connection',
    Object.assign(
      { id: 'c1', name: 'Conn', profile: 'p_default', localIdentity: 'id_t', reconnect: false, heartbeat: false },
      config
    )
  );
}

test('udp with a partial remote pair is rejected at deploy', () => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'udp', remoteHost: '', remotePort: 14550 });
  assert.strictEqual(conn.statusState, 'error');
  const logged = conn.errors.map(String).join('\n');
  assert.match(logged, /TRANSPORT_CONFIG_INVALID/);
  assert.match(logged, /remote host/i);
  // The runtime API degrades to safe no-ops; no transport was started.
  assert.strictEqual(conn._transport, null);
});

test('a rejected connection sends reject rather than throwing', async () => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'udp', remoteHost: '' });
  await assert.rejects(() => conn.send({ name: 'HEARTBEAT', fields: {} }), /not initialised/);
});

test('serial with no device path is rejected at deploy', () => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'serial', serialPath: '' });
  assert.strictEqual(conn.statusState, 'error');
  assert.match(conn.errors.map(String).join('\n'), /TRANSPORT_CONFIG_INVALID.*serial path/is);
});

test('tcp with a partial remote pair is rejected at deploy', () => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'tcp', remoteHost: '', remotePort: 5760 });
  assert.strictEqual(conn.statusState, 'error');
  assert.match(conn.errors.map(String).join('\n'), /TRANSPORT_CONFIG_INVALID/);
});

test('udp with a blank remote is accepted (learn-first peer)', async (t) => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'udp', bindAddress: '127.0.0.1', bindPort: 0, remoteHost: '' });
  t.after(() => RED.close(conn));
  assert.notStrictEqual(conn.statusState, 'error', `status: ${conn.statusState} ${conn.statusDetail}`);
  assert.ok(conn._transport, 'transport started');
});

test('udp with only a remote endpoint is accepted (send-first, ephemeral bind)', async (t) => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'udp', remoteHost: '127.0.0.1', remotePort: 14550 });
  t.after(() => RED.close(conn));
  assert.notStrictEqual(conn.statusState, 'error', `status: ${conn.statusState} ${conn.statusDetail}`);
  assert.ok(conn._transport, 'transport started');
});

test('tcp with both roles filled is rejected at deploy (#243 strict xor)', () => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'tcp', bindPort: 5760, remoteHost: '127.0.0.1', remotePort: 5761 });
  assert.strictEqual(conn.statusState, 'error');
  assert.match(conn.errors.map(String).join('\n'), /TRANSPORT_CONFIG_INVALID.*exactly one role/is);
});

test('tcp with neither role filled is rejected at deploy (#243)', () => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'tcp' });
  assert.strictEqual(conn.statusState, 'error');
  assert.match(conn.errors.map(String).join('\n'), /TRANSPORT_CONFIG_INVALID/);
});

test('a pre-#243 mode name is rejected at deploy (clean break)', () => {
  const RED = withProfile();
  const conn = connect(RED, { transport: 'udp-peer', bindPort: 14550 });
  assert.strictEqual(conn.statusState, 'error');
  assert.match(conn.errors.map(String).join('\n'), /TRANSPORT_CONFIG_INVALID.*Unknown transport/is);
});
