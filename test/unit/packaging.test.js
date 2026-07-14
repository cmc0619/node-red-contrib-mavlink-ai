'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const pkg = require('../../package.json');

/**
 * The published npm tarball is defined by package.json `files` (issue #151).
 * Without it npm shipped the whole repo — every test, DESIGN.md, ROADMAP.md —
 * to consumers. These guards keep the allowlist present and correctly scoped so
 * a future edit can't silently republish the dev tree or drop runtime code.
 */
test('package.json ships a files allowlist that excludes the dev tree (#151)', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files allowlist must be present');

  const normalized = pkg.files.map((f) => f.replace(/\/$/, ''));
  assert.ok(normalized.includes('nodes'), 'runtime nodes/ must be shipped');
  assert.ok(normalized.includes('lib'), 'runtime lib/ must be shipped');

  /** A bare "*" or "." would defeat the allowlist and ship everything again. */
  assert.ok(!normalized.some((f) => f === '*' || f === '.' || f === ''), 'allowlist must not be a catch-all');
  /** test/ carries no runtime value and must never be published. */
  assert.ok(!normalized.some((f) => f === 'test' || f.startsWith('test/')), 'tests must not be shipped');
});

test('every registered Node-RED node file lives under a shipped path (#151)', () => {
  const shipped = pkg.files.map((f) => f.replace(/\/$/, ''));
  const nodeFiles = Object.values(pkg['node-red'].nodes);
  for (const rel of nodeFiles) {
    const topDir = rel.split(path.posix.sep)[0];
    assert.ok(shipped.includes(topDir), `${rel} is registered but its dir '${topDir}/' is not in files`);
  }
});
