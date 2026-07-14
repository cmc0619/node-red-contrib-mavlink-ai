'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileReplayStore } = require('../../lib/protocol/replay-store');

/** A throwaway temp directory removed after the callback. */
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavlink-replay-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('round-trips per-scope state through the file and isolates scopes', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'nested', 'replay-state.json');
    const store = new FileReplayStore({ file, throttleMs: 0 });
    store.save('scopeA', { '1:1:0': 2000 });
    store.save('scopeB', { '2:1:0': 55 });
    store.flush();

    const reopened = new FileReplayStore({ file, throttleMs: 0 });
    assert.deepStrictEqual(reopened.load('scopeA'), { '1:1:0': 2000 });
    assert.deepStrictEqual(reopened.load('scopeB'), { '2:1:0': 55 });
    assert.deepStrictEqual(reopened.load('unknown'), {});
  });
});

test('a missing or corrupt file starts fresh rather than throwing', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'replay-state.json');
    assert.deepStrictEqual(new FileReplayStore({ file }).load('x'), {});
    fs.writeFileSync(file, '{ not json');
    assert.deepStrictEqual(new FileReplayStore({ file }).load('x'), {});
  });
});

test('degrades to in-memory (never throws) when the location is unwritable', () => {
  withTempDir((dir) => {
    /** A file sits where a directory is required, so mkdir/write must fail. */
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'sub', 'replay-state.json');
    let warned = 0;
    const store = new FileReplayStore({ file, throttleMs: 0, onUnwritable: () => (warned += 1) });
    assert.doesNotThrow(() => store.save('scopeA', { '1:1:0': 1 }));
    /** Further saves stay silent — the operator is warned only once. */
    store.save('scopeA', { '1:1:0': 2 });
    store.flush();
    assert.strictEqual(warned, 1, 'operator is warned exactly once');
    assert.strictEqual(fs.existsSync(file), false);
  });
});
