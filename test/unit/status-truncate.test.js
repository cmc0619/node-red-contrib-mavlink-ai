'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { truncateStatus } = require('../../lib/util/status');

test('truncateStatus passes short text through unchanged', () => {
  assert.strictEqual(truncateStatus('tx 5'), 'tx 5');
  assert.strictEqual(truncateStatus('waiting for link'), 'waiting for link');
});

test('truncateStatus leaves text exactly at the cap unchanged', () => {
  const s = '3 vehicles · 2 connect'; // 22 chars, <= 24
  assert.ok(s.length <= 24);
  assert.strictEqual(truncateStatus(s), s);
});

test('truncateStatus caps overlong text at maxLen with a trailing ellipsis', () => {
  const out = truncateStatus('SET_POSITION_TARGET_GLOBAL_INT'); // 30 chars
  assert.strictEqual(out.length, 24);
  assert.ok(out.endsWith('…'));
  assert.strictEqual(out, 'SET_POSITION_TARGET_GLO…');
});

test('truncateStatus respects an explicit maxLen', () => {
  assert.strictEqual(truncateStatus('abcdefghij', 5), 'abcd…');
});

test('truncateStatus tolerates non-string and empty input', () => {
  assert.strictEqual(truncateStatus(undefined), '');
  assert.strictEqual(truncateStatus(null), '');
  assert.strictEqual(truncateStatus(123), '123');
});

const { MockRED } = require('../helpers/mock-red');

test('a node applies truncateStatus to a long badge end-to-end (#221)', async () => {
  // The Build node badges the built message name (nodes/mavlink-ai-build.js).
  // SET_POSITION_TARGET_GLOBAL_INT is 30 chars — over the 24-char cap — so its
  // status badge must come back capped, proving the wrapping is wired in a real
  // node path, not just the helper in isolation.
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  const node = RED.create('mavlink-ai-build', {
    id: 'b1',
    profile: 'p1',
    messageName: 'SET_POSITION_TARGET_GLOBAL_INT'
  });
  const { err } = await RED.inject(node, { payload: {} });
  assert.strictEqual(err, undefined);
  const last = node.statusHistory[node.statusHistory.length - 1];
  assert.ok(last, 'expected a status badge to be set');
  assert.ok(last.text.length <= 24, `badge not capped: ${JSON.stringify(last)}`);
  assert.ok(last.text.startsWith('SET_POSITION_TARGET'), `unexpected badge text: ${last.text}`);
});
