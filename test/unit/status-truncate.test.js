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
