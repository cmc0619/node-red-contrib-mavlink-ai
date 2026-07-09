'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

// The connection node bails on a missing profile before it starts any transport,
// but the heartbeat interval is parsed (and clamped/warned) first — so these
// tests exercise the clamp without opening a socket. See issue #76.

test('heartbeat interval below the 1000 ms minimum is clamped and warned (#76)', () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-connection', { id: 'c1', heartbeatIntervalMs: 100 });
  assert.strictEqual(node.heartbeatIntervalMs, 1000);
  assert.ok(
    node.warnings.some((w) => /100 ms/.test(w) && /1000 ms/.test(w)),
    `expected a clamp warning, got ${JSON.stringify(node.warnings)}`
  );
});

test('default heartbeat interval stays 1000 ms with no warning (#76)', () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-connection', { id: 'c1' });
  assert.strictEqual(node.heartbeatIntervalMs, 1000);
  assert.strictEqual(node.warnings.length, 0);
});

test('an explicit interval at or above the minimum is left alone (#76)', () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-connection', { id: 'c1', heartbeatIntervalMs: 2000 });
  assert.strictEqual(node.heartbeatIntervalMs, 2000);
  assert.strictEqual(node.warnings.length, 0);
});
