'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { OutboundQueue } = require('../../lib/runtime/outbound-queue');

test('higher-priority writes jump the queue while draining', async () => {
  const written = [];
  let releaseFirst;
  const firstGate = new Promise((r) => (releaseFirst = r));
  let calls = 0;
  const queue = new OutboundQueue((buf) => {
    calls += 1;
    written.push(buf[0]);
    // Block the very first write so the rest queue up behind it.
    return calls === 1 ? firstGate : Promise.resolve();
  });

  const p1 = queue.enqueue(Buffer.from([1]), 2); // starts draining immediately
  const p2 = queue.enqueue(Buffer.from([2]), 3); // queued (background)
  const p3 = queue.enqueue(Buffer.from([3]), 0); // queued (emergency) -> jumps ahead
  releaseFirst();
  await Promise.all([p1, p2, p3]);

  // First is already in-flight; among the queued ones, priority 0 beats 3.
  assert.deepStrictEqual(written, [1, 3, 2]);
});

test('disabled queue writes straight through', async () => {
  const written = [];
  const queue = new OutboundQueue((buf) => Promise.resolve(written.push(buf[0])), { enabled: false });
  await queue.enqueue(Buffer.from([9]));
  assert.deepStrictEqual(written, [9]);
});

test('rejects enqueue when the queue is full (stalled transport)', async () => {
  // A writer that never resolves simulates a stalled transport.
  let release;
  const gate = new Promise((r) => (release = r));
  const queue = new OutboundQueue(() => gate, { maxLength: 2 });

  const p1 = queue.enqueue(Buffer.from([1])); // starts draining, in-flight
  queue.enqueue(Buffer.from([2])).catch(() => {}); // queued
  queue.enqueue(Buffer.from([3])).catch(() => {}); // queued -> length 2
  await assert.rejects(() => queue.enqueue(Buffer.from([4])), /queue is full/);

  release();
  await p1;
});

test('clear rejects pending writes', async () => {
  const gate = new Promise(() => {}); // never resolves
  const queue = new OutboundQueue(() => gate);
  const pending = queue.enqueue(Buffer.from([1]));
  const queued = queue.enqueue(Buffer.from([2]));
  queue.clear();
  await assert.rejects(() => queued, /cleared/);
  // The in-flight write should remain unsettled (neither resolved nor rejected)
  // after clear(), since clear only drops queued items, not the active write.
  const state = await Promise.race([
    pending.then(() => 'settled', () => 'settled'),
    new Promise((r) => setTimeout(() => r('pending'), 20))
  ]);
  assert.strictEqual(state, 'pending');
});
