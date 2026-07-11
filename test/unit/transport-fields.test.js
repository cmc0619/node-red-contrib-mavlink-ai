'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TRANSPORTS,
  isFieldVisible,
  validateConnectionConfig
} = require('../../lib/transport/transport-fields');

/**
 * Transport-aware field spec (issue #103). The editor and the runtime share
 * this module so a transport shows (and requires) only the settings it uses.
 */

test('every transport has a field spec', () => {
  for (const t of TRANSPORTS) {
    // A blank config for the transport must produce a defined problem list.
    assert.ok(Array.isArray(validateConnectionConfig({ transport: t })), `spec for ${t}`);
  }
});

test('udp-out requires a remote endpoint', () => {
  const problems = validateConnectionConfig({ transport: 'udp-out', remoteHost: '', remotePort: '' });
  const fields = problems.map((p) => p.field);
  assert.ok(fields.includes('remoteHost'), 'remoteHost required');
  assert.ok(fields.includes('remotePort'), 'remotePort required');
});

test('udp-out is valid once the remote is set', () => {
  const problems = validateConnectionConfig({ transport: 'udp-out', remoteHost: '10.0.0.5', remotePort: 14550 });
  assert.strictEqual(problems.length, 0, JSON.stringify(problems));
});

test('tcp-client requires a remote host and port', () => {
  const problems = validateConnectionConfig({ transport: 'tcp-client', remoteHost: '', remotePort: 5760 });
  assert.deepStrictEqual(problems.map((p) => p.field), ['remoteHost']);
});

test('serial requires a device path', () => {
  const problems = validateConnectionConfig({ transport: 'serial', serialPath: '', serialBaud: 57600 });
  assert.deepStrictEqual(problems.map((p) => p.field), ['serialPath']);
});

test('serial is valid with a path', () => {
  const problems = validateConnectionConfig({ transport: 'serial', serialPath: '/dev/ttyACM0', serialBaud: 57600 });
  assert.strictEqual(problems.length, 0);
});

test('udp-peer does not require a remote (learn-first) but needs a bind port', () => {
  const learn = validateConnectionConfig({ transport: 'udp-peer', bindPort: 14550, remoteHost: '', remotePort: '' });
  assert.strictEqual(learn.length, 0, 'blank remote is fine for udp-peer (learned peer)');

  const noBind = validateConnectionConfig({ transport: 'udp-peer', bindPort: '' });
  assert.deepStrictEqual(noBind.map((p) => p.field), ['bindPort']);
});

test('udp-in only needs a bind port (receive-only)', () => {
  const ok = validateConnectionConfig({ transport: 'udp-in', bindPort: 14550 });
  assert.strictEqual(ok.length, 0);
  const blank = validateConnectionConfig({ transport: 'udp-in', bindPort: '  ' });
  assert.deepStrictEqual(blank.map((p) => p.field), ['bindPort']);
});

test('field visibility is transport-specific', () => {
  assert.ok(isFieldVisible('serial', 'serialPath'));
  assert.ok(!isFieldVisible('serial', 'remoteHost'), 'serial hides remote host');
  assert.ok(isFieldVisible('udp-in', 'bindPort'));
  assert.ok(!isFieldVisible('udp-in', 'remoteHost'), 'udp-in hides remote host (receive-only)');
  assert.ok(isFieldVisible('udp-peer', 'bindPort') && isFieldVisible('udp-peer', 'remoteHost'));
  assert.ok(isFieldVisible('tcp-client', 'remoteHost') && !isFieldVisible('tcp-client', 'bindPort'));
});

test('migration: a legacy config carrying every field still validates for any transport', () => {
  // Old flows saved all fields regardless of transport. A fully-populated
  // config must remain valid after the transport-aware spec is applied, so an
  // upgrade never invalidates a working saved connection.
  const legacy = {
    bindAddress: '0.0.0.0',
    bindPort: 14550,
    remoteHost: '127.0.0.1',
    remotePort: 14550,
    serialPath: '/dev/ttyACM0',
    serialBaud: 57600
  };
  for (const t of TRANSPORTS) {
    const problems = validateConnectionConfig(Object.assign({ transport: t }, legacy));
    assert.strictEqual(problems.length, 0, `${t}: ${JSON.stringify(problems)}`);
  }
});

test('an unknown transport falls back to a usable spec instead of throwing', () => {
  assert.doesNotThrow(() => validateConnectionConfig({ transport: 'not-a-transport' }));
});
