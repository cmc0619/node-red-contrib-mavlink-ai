'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { safeDetach } = require('../../lib/util/node-lifecycle');

test('safeDetach runs the detach when a connection is present', () => {
  let ran = false;
  const node = { connection: {}, error: () => {} };
  safeDetach(node, () => {
    ran = true;
  });
  assert.strictEqual(ran, true);
});

test('safeDetach skips the detach when the connection is already gone', () => {
  let ran = false;
  const node = { connection: null, error: () => {} };
  safeDetach(node, () => {
    ran = true;
  });
  assert.strictEqual(ran, false);
});

test('safeDetach swallows a detach error and reports it via node.error (#140)', () => {
  const errors = [];
  const node = { connection: {}, error: (m) => errors.push(m) };
  assert.doesNotThrow(() =>
    safeDetach(node, () => {
      throw new Error('boom');
    })
  );
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /boom/);
});
