'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TRANSPORTS,
  isFieldVisible,
  validateConnectionConfig
} = require('../../lib/transport/transport-fields');

/**
 * Condensed transport spec (#243): three protocols — udp, serial, tcp — whose
 * role derives from field presence instead of a mode picker. The editor and the
 * runtime share this module, so these presence rules are the single source of
 * truth for both.
 */

test('the transport list is exactly udp, serial, tcp', () => {
  assert.deepStrictEqual(TRANSPORTS, ['udp', 'serial', 'tcp']);
});

test('udp: bind only (peer/listen) is valid', () => {
  const problems = validateConnectionConfig({ transport: 'udp', bindPort: 14550 });
  assert.strictEqual(problems.length, 0, JSON.stringify(problems));
});

test('udp: remote only (send-first with ephemeral bind) is valid', () => {
  const problems = validateConnectionConfig({ transport: 'udp', remoteHost: '10.0.0.5', remotePort: 14550 });
  assert.strictEqual(problems.length, 0, JSON.stringify(problems));
});

test('udp: bind plus fixed remote is valid', () => {
  const problems = validateConnectionConfig({
    transport: 'udp',
    bindPort: 14550,
    remoteHost: '10.0.0.5',
    remotePort: 14551
  });
  assert.strictEqual(problems.length, 0, JSON.stringify(problems));
});

test('udp: everything blank is a deploy error', () => {
  // An ephemeral socket nobody can reach, with nowhere to send, is dead weight.
  const problems = validateConnectionConfig({ transport: 'udp', bindPort: '', remoteHost: '', remotePort: '' });
  assert.ok(problems.length >= 1, 'expected at least one problem');
});

test('udp: a partial remote pair is a deploy error', () => {
  const hostOnly = validateConnectionConfig({ transport: 'udp', bindPort: 14550, remoteHost: '10.0.0.5' });
  assert.ok(hostOnly.some((p) => p.field === 'remotePort'), JSON.stringify(hostOnly));
  const portOnly = validateConnectionConfig({ transport: 'udp', bindPort: 14550, remotePort: 14551 });
  assert.ok(portOnly.some((p) => p.field === 'remoteHost'), JSON.stringify(portOnly));
});

test('tcp: remote pair only (client role) is valid', () => {
  const problems = validateConnectionConfig({ transport: 'tcp', remoteHost: '10.0.0.5', remotePort: 5760 });
  assert.strictEqual(problems.length, 0, JSON.stringify(problems));
});

test('tcp: bind port only (server role) is valid', () => {
  const problems = validateConnectionConfig({ transport: 'tcp', bindPort: 5760 });
  assert.strictEqual(problems.length, 0, JSON.stringify(problems));
});

test('tcp: both roles filled is a deploy error (strict xor)', () => {
  const problems = validateConnectionConfig({
    transport: 'tcp',
    bindPort: 5760,
    remoteHost: '10.0.0.5',
    remotePort: 5760
  });
  assert.ok(problems.length >= 1, 'expected a problem for both roles');
});

test('tcp: neither role filled is a deploy error', () => {
  const problems = validateConnectionConfig({ transport: 'tcp' });
  assert.ok(problems.length >= 1, 'expected a problem for no role');
});

test('tcp: a partial remote pair is a deploy error', () => {
  const problems = validateConnectionConfig({ transport: 'tcp', remoteHost: '10.0.0.5' });
  assert.ok(problems.some((p) => p.field === 'remotePort'), JSON.stringify(problems));
});

test('serial requires a device path and baud', () => {
  const blank = validateConnectionConfig({ transport: 'serial', serialPath: '', serialBaud: '' });
  const fields = blank.map((p) => p.field);
  assert.ok(fields.includes('serialPath'), 'serialPath required');
  assert.ok(fields.includes('serialBaud'), 'serialBaud required');
  const ok = validateConnectionConfig({ transport: 'serial', serialPath: '/dev/ttyACM0', serialBaud: 57600 });
  assert.strictEqual(ok.length, 0);
});

test('legacy mode names are rejected, not silently remapped (#243 clean break)', () => {
  for (const legacy of ['udp-peer', 'udp-in', 'udp-out', 'tcp-client', 'tcp-server']) {
    const problems = validateConnectionConfig({ transport: legacy, bindPort: 14550, remoteHost: 'h', remotePort: 1 });
    assert.ok(problems.length >= 1, `${legacy} must fail validation`);
  }
});

test('field visibility is protocol-specific', () => {
  assert.ok(isFieldVisible('serial', 'serialPath'));
  assert.ok(!isFieldVisible('serial', 'remoteHost'), 'serial hides remote host');
  assert.ok(isFieldVisible('udp', 'bindPort') && isFieldVisible('udp', 'remoteHost'));
  assert.ok(!isFieldVisible('udp', 'serialPath'), 'udp hides serial path');
  assert.ok(isFieldVisible('tcp', 'remoteHost') && isFieldVisible('tcp', 'bindPort'), 'tcp shows both role fields');
  assert.ok(isFieldVisible('tcp', 'reconnect'));
});

test('an unknown transport still yields a usable visibility spec (editor safety)', () => {
  assert.doesNotThrow(() => isFieldVisible('not-a-transport', 'bindPort'));
});
