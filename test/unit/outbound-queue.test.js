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

test('age promotion keeps a background item from being starved by sustained higher-priority traffic', async () => {
  /**
   * Deterministic hand-advanced clock. A priority-2 item holds the in-flight
   * slot; the heartbeat (priority 3) queues behind it at t=0, then a steady
   * stream of fresh priority-2 traffic keeps arriving. Under strict priority the
   * heartbeat never drains; with age promotion (agePromotionMs=1000 => one band
   * per second) it must surface once it has aged.
   */
  let clock = 0;
  const written = [];
  /**
   * Only one write is ever in flight (the drain loop is serial), so a single
   * live resolver is enough: each write blocks until release() lets it finish,
   * giving the test control over drain cadence and flood injection.
   */
  let resolveWrite;
  const release = () => resolveWrite();
  const queue = new OutboundQueue(
    (buf) => {
      written.push(buf[0]);
      return new Promise((r) => {
        resolveWrite = r;
      });
    },
    { agePromotionMs: 1000, now: () => clock }
  );

  /** Priority-2 item takes the in-flight slot; the heartbeat queues behind it at t=0. */
  queue.enqueue(Buffer.from([1]), 2).catch(() => {});
  const hb = queue.enqueue(Buffer.from([99]), 3);
  queue.enqueue(Buffer.from([10]), 2).catch(() => {});
  queue.enqueue(Buffer.from([11]), 2).catch(() => {});

  /** Finish the in-flight write, advance the clock, then top the flood back up. */
  const drainOne = async (advanceMs, floodByte) => {
    clock += advanceMs;
    release();
    await new Promise((r) => setImmediate(r));
    if (floodByte !== undefined) {
      queue.enqueue(Buffer.from([floodByte]), 2).catch(() => {});
    }
  };

  /**
   * Well under a full band: strict priority holds, the heartbeat stays parked
   * behind the priority-2 flood no matter how many messages drain.
   */
  await drainOne(200, 12);
  await drainOne(200, 13);
  await drainOne(200, 14);
  assert.ok(!written.includes(99), 'heartbeat must not drain before it has aged a full band');

  /**
   * Push the wait past a promotion band and keep draining with the flood still
   * running; the promoted heartbeat must surface within a bounded number of
   * writes instead of waiting behind the never-ending priority-2 stream forever.
   */
  for (let i = 0; i < 6 && !written.includes(99); i += 1) {
    await drainOne(1000, 20 + i);
  }
  assert.ok(written.includes(99), 'aged heartbeat should drain despite sustained priority-2 traffic');

  /** Drain the remainder so no promise dangles. */
  for (let i = 0; i < 12; i += 1) {
    await drainOne(1000);
  }
  await hb;
});

test('coalesceKey drops a superseded queued item and resolves it', async () => {
  const written = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  const queue = new OutboundQueue((buf) => {
    calls += 1;
    written.push(buf[0]);
    return calls === 1 ? gate : Promise.resolve();
  });

  /** Priority-2 item starts draining and blocks; two heartbeats queue behind it. */
  const inflight = queue.enqueue(Buffer.from([1]), 2);
  const firstHb = queue.enqueue(Buffer.from([10]), 3, undefined, { coalesceKey: 'heartbeat' });
  const secondHb = queue.enqueue(Buffer.from([11]), 3, undefined, { coalesceKey: 'heartbeat' });

  /**
   * The first heartbeat is superseded by the second: only one heartbeat stays
   * queued (plus the in-flight item), and the dropped one resolves rather than
   * rejects (the newer send carries the same intent).
   */
  assert.strictEqual(queue.length, 1, 'only the newest heartbeat should remain queued');
  await firstHb;

  release();
  await Promise.all([inflight, secondHb]);
  /** In-flight [1] plus exactly one heartbeat — the newest ([11]); [10] never written. */
  assert.deepStrictEqual(written, [1, 11]);
});

test('dropCoalesced removes matching queued items and resolves their promises (#225)', async () => {
  /**
   * Added for #225: the connection's health-driven heartbeat tick must be
   * able to evict an already-queued heartbeat for an identity that has just
   * gone fatal, without enqueuing a replacement (unlike the enqueue-time
   * `_dropSuperseded` this reuses). Dropped items resolve, not reject — the
   * caller decided the item should no longer be sent, not that it failed.
   */
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  const queue = new OutboundQueue(() => {
    calls += 1;
    return calls === 1 ? gate : Promise.resolve();
  });

  /** In-flight (blocked) item, plus two queued items sharing a coalesce key and one unrelated queued item. */
  const inflight = queue.enqueue(Buffer.from([1]));
  const hb1 = queue.enqueue(Buffer.from([10]), 3, undefined, { coalesceKey: 'heartbeat:id-a' });
  const other = queue.enqueue(Buffer.from([2]), 2, undefined, { coalesceKey: 'unrelated' });

  const dropped = queue.dropCoalesced('heartbeat:id-a');

  assert.strictEqual(dropped, 1, 'reports how many items were dropped');
  assert.strictEqual(queue.length, 1, 'only the matching-key item is removed; the unrelated item stays queued');
  await hb1; // resolves (not rejects) despite never being written

  /** A second call with no matches is a safe no-op. */
  assert.strictEqual(queue.dropCoalesced('heartbeat:id-a'), 0);

  release();
  await Promise.all([inflight, other]);
});

test('dropCoalescedMatching removes every item whose coalesce key satisfies the predicate (#225)', async () => {
  /**
   * Added for #225 review: the mixed v1/v2 broadcast path (#199) re-keys a
   * coalesced heartbeat per wire version (`heartbeat:<id>:v1` /
   * `heartbeat:<id>:v2`), so evicting only the bare `heartbeat:<id>` key
   * (dropCoalesced) misses those queued frames. dropCoalescedMatching lets a
   * caller evict a base key and every `:`-suffixed variant with one call,
   * sharing the same removal path (_removeMatching) dropCoalesced uses.
   */
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  const queue = new OutboundQueue(() => {
    calls += 1;
    return calls === 1 ? gate : Promise.resolve();
  });

  const inflight = queue.enqueue(Buffer.from([1]));
  const base = queue.enqueue(Buffer.from([10]), 3, undefined, { coalesceKey: 'heartbeat:id-a' });
  const v1 = queue.enqueue(Buffer.from([11]), 3, undefined, { coalesceKey: 'heartbeat:id-a:v1' });
  const v2 = queue.enqueue(Buffer.from([12]), 3, undefined, { coalesceKey: 'heartbeat:id-a:v2' });
  const unrelated = queue.enqueue(Buffer.from([2]), 2, undefined, { coalesceKey: 'unrelated' });

  const matchBase = 'heartbeat:id-a';
  const predicate = (k) => typeof k === 'string' && (k === matchBase || k.startsWith(`${matchBase}:`));
  const dropped = queue.dropCoalescedMatching(predicate);

  assert.strictEqual(dropped, 3, 'drops the base key plus both version-suffixed variants');
  assert.strictEqual(queue.length, 1, 'only the unrelated item remains queued');
  await Promise.all([base, v1, v2]); // all resolve (not reject) despite never being written

  release();
  await Promise.all([inflight, unrelated]);
});

test('dropCoalescedMatching with a base-key predicate does not false-match a longer sysid (#225)', async () => {
  /**
   * Guards the anchoring in the `=== base || startsWith(base + ':')` form:
   * base `heartbeat:1` must not evict `heartbeat:10` or `heartbeat:12` —
   * plain-substring matching would wrongly conflate a different identity
   * whose id happens to share a numeric prefix.
   */
  const queue = new OutboundQueue(() => new Promise(() => {}));
  const inflight = queue.enqueue(Buffer.from([0]));
  const idOneQueued = queue.enqueue(Buffer.from([1]), 3, undefined, { coalesceKey: 'heartbeat:1' });
  const idTenQueued = queue.enqueue(Buffer.from([10]), 3, undefined, { coalesceKey: 'heartbeat:10' });
  const idTwelveQueued = queue.enqueue(Buffer.from([12]), 3, undefined, { coalesceKey: 'heartbeat:12' });

  const matchBase = 'heartbeat:1';
  const predicate = (k) => typeof k === 'string' && (k === matchBase || k.startsWith(`${matchBase}:`));
  const dropped = queue.dropCoalescedMatching(predicate);

  assert.strictEqual(dropped, 1, 'only the exact base key matches; the longer sysids must survive');
  assert.strictEqual(queue.length, 2, 'heartbeat:10 and heartbeat:12 stay queued');

  idOneQueued.catch(() => {});
  idTenQueued.catch(() => {});
  idTwelveQueued.catch(() => {});
  inflight.catch(() => {});
  queue.clear();
});

test('onWrite fires only for actually-written buffers, never for coalesced drops', async () => {
  const onWrote = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  const queue = new OutboundQueue(() => {
    calls += 1;
    return calls === 1 ? gate : Promise.resolve();
  });

  /** Priority-2 item drains and blocks; two coalescing heartbeats queue behind it. */
  const inflight = queue.enqueue(Buffer.from([1]), 2, undefined, { onWrite: () => onWrote.push(1) });
  const firstHb = queue.enqueue(Buffer.from([10]), 3, undefined, { coalesceKey: 'hb', onWrite: () => onWrote.push(10) });
  const secondHb = queue.enqueue(Buffer.from([11]), 3, undefined, { coalesceKey: 'hb', onWrite: () => onWrote.push(11) });

  /** Superseded: its promise resolves, but it must NOT fire onWrite. */
  await firstHb;
  release();
  await Promise.all([inflight, secondHb]);

  /** [1] and the surviving heartbeat [11] were written; the dropped [10] was not. */
  assert.deepStrictEqual(onWrote.sort((a, b) => a - b), [1, 11]);
});

test('coalescing preserves accumulated age so a re-sent heartbeat is not starved', async () => {
  /**
   * The real heartbeat path re-sends every tick with the same coalesceKey. If
   * each re-send reset the queued item's age, age promotion could never fire
   * under a sustained flood. The replacement must inherit the superseded item's
   * enqueue time so its wait keeps accumulating across ticks.
   */
  let clock = 0;
  const written = [];
  let resolveWrite;
  const release = () => resolveWrite();
  const queue = new OutboundQueue(
    (buf) => {
      written.push(buf[0]);
      return new Promise((r) => {
        resolveWrite = r;
      });
    },
    { agePromotionMs: 1000, now: () => clock }
  );

  /** Priority-2 item is in-flight and blocked; first heartbeat queues at t=0. */
  queue.enqueue(Buffer.from([1]), 2).catch(() => {});
  queue.enqueue(Buffer.from([99]), 3, undefined, { coalesceKey: 'heartbeat' }).catch(() => {});
  queue.enqueue(Buffer.from([10]), 2).catch(() => {});

  const drainOne = async (advanceMs, floodByte) => {
    clock += advanceMs;
    release();
    await new Promise((r) => setImmediate(r));
    if (floodByte !== undefined) {
      queue.enqueue(Buffer.from([floodByte]), 2).catch(() => {});
    }
  };

  /**
   * Every ~300ms the heartbeat "ticks" and coalesces itself (inheriting the age
   * of the copy it supersedes), while a priority-2 flood keeps draining. Despite
   * the heartbeat being replaced repeatedly, its inherited age keeps climbing,
   * so it must still promote and drain. The final re-send carries buffer 99 so
   * the drain is observable.
   */
  for (let i = 0; i < 12 && !written.includes(99); i += 1) {
    await drainOne(300, 20 + i);
    queue.enqueue(Buffer.from([99]), 3, undefined, { coalesceKey: 'heartbeat' }).catch(() => {});
  }
  assert.ok(
    written.includes(99),
    'a repeatedly-coalesced heartbeat must still age in and drain, not reset to zero each tick'
  );

  for (let i = 0; i < 12; i += 1) {
    await drainOne(300);
  }
});

test('agePromotionMs Infinity disables aging (strict priority)', async () => {
  /**
   * The documented opt-out: with aging disabled, a background item stays parked
   * behind higher-priority traffic no matter how much wall-clock passes — the
   * `Number.isFinite` guard must not silently coerce Infinity to the default.
   */
  let clock = 0;
  const written = [];
  let resolveWrite;
  const release = () => resolveWrite();
  const queue = new OutboundQueue(
    (buf) => {
      written.push(buf[0]);
      return new Promise((r) => {
        resolveWrite = r;
      });
    },
    { agePromotionMs: Infinity, now: () => clock }
  );

  assert.strictEqual(queue.agePromotionMs, Infinity, 'Infinity must be honored, not coerced to 2000');

  /** Priority-2 item is in-flight; a heartbeat and a steady priority-2 flood queue behind it. */
  queue.enqueue(Buffer.from([1]), 2).catch(() => {});
  const hb = queue.enqueue(Buffer.from([99]), 3);
  queue.enqueue(Buffer.from([10]), 2).catch(() => {});

  for (let i = 0; i < 8; i += 1) {
    /** Huge clock jumps: aging would have fired long ago if it were enabled. */
    clock += 100000;
    release();
    await new Promise((r) => setImmediate(r));
    queue.enqueue(Buffer.from([20 + i]), 2).catch(() => {});
  }
  assert.ok(!written.includes(99), 'with aging disabled the heartbeat is never promoted');

  /** Drain everything else, then the lone heartbeat, so nothing dangles. */
  for (let i = 0; i < 12; i += 1) {
    release();
    await new Promise((r) => setImmediate(r));
  }
  await hb;
});

test('age promotion never lets an aged low-priority send outrank a later emergency send', async () => {
  /**
   * Aging bounds a low-priority item's wait but must not breach the emergency
   * band (0): an arm/mode/emergency command must cut through a backlog, not
   * queue behind a stale normal send that merely waited a long time. Without the
   * clamp, a priority-2 send aged many bands would reach an effective priority
   * below 0 and be written ahead of a later priority-0 command.
   */
  let clock = 0;
  const written = [];
  let resolveWrite;
  const release = () => resolveWrite();
  const queue = new OutboundQueue(
    (buf) => {
      written.push(buf[0]);
      return new Promise((r) => {
        resolveWrite = r;
      });
    },
    { agePromotionMs: 1000, now: () => clock }
  );

  /** Filler holds the in-flight slot; a priority-2 normal send queues at t=0 and ages. */
  queue.enqueue(Buffer.from([1]), 2).catch(() => {});
  const normal = queue.enqueue(Buffer.from([50]), 2);

  /** Age the normal send far past its own band — enough to drive it below 0 unclamped. */
  clock += 10000;

  /** A priority-0 emergency arrives now, long after the normal send; it must still go first. */
  const emergency = queue.enqueue(Buffer.from([9]), 0);

  release();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(written[written.length - 1], 9, 'emergency must preempt the aged normal send');

  release();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(written[written.length - 1], 50, 'aged normal send drains after the emergency');

  /** Release the now-in-flight normal send so no promise dangles. */
  release();
  await Promise.all([normal, emergency]);
});

test('coalescing reclaims a full queue slot instead of rejecting', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const queue = new OutboundQueue(() => gate, { maxLength: 2 });

  /** In-flight (blocked) item, then a queued heartbeat and a filler fill the queue to maxLength. */
  const inflight = queue.enqueue(Buffer.from([1]));
  queue.enqueue(Buffer.from([10]), 3, undefined, { coalesceKey: 'heartbeat' }).catch(() => {});
  queue.enqueue(Buffer.from([2])).catch(() => {});

  /**
   * A fresh heartbeat would overflow a full queue, but it supersedes the queued
   * heartbeat first, so it is accepted rather than rejected. It stays queued
   * behind the block, so the race just asserts the enqueue does not reject.
   */
  await assert.doesNotReject(() =>
    Promise.race([
      queue.enqueue(Buffer.from([11]), 3, undefined, { coalesceKey: 'heartbeat' }),
      new Promise((r) => setTimeout(r, 10))
    ])
  );
  assert.strictEqual(queue.length, 2, 'coalesced heartbeat reused the slot; queue did not grow');

  release();
  await inflight;
});

test('clear rejects pending writes, including the one in flight (#237)', async () => {
  /**
   * Before #237 the in-flight item was deliberately left unsettled by clear()
   * — but its owner is a flow message whose done() then never fires when the
   * writer is stalled, leaking the message across a redeploy. clear() now
   * settles the in-flight item too; a late writer completion is a no-op on the
   * already-rejected promise.
   */
  const gate = new Promise(() => {}); // never resolves
  const queue = new OutboundQueue(() => gate);
  const pending = queue.enqueue(Buffer.from([1]));
  const queued = queue.enqueue(Buffer.from([2]));
  queue.clear();
  await assert.rejects(() => queued, /cleared/);
  await assert.rejects(() => pending, (e) => e.code === 'QUEUE_CLEARED');
});

test('teardown and overflow rejections carry stable codes (QUEUE_CLEARED / QUEUE_FULL)', async () => {
  /**
   * The connection's heartbeat catch filters expected teardown rejections by
   * code; a codeless Error would be re-emitted on an emitter whose listeners
   * close() already removed — an EventEmitter throw that kills the process.
   */
  const stalled = new OutboundQueue(() => new Promise(() => {}), { maxLength: 1 });
  const first = stalled.enqueue(Buffer.from([1]));
  const queued = stalled.enqueue(Buffer.from([2]));
  const overflow = stalled.enqueue(Buffer.from([3]));
  await assert.rejects(overflow, (e) => e.code === 'QUEUE_FULL');
  stalled.clear();
  await assert.rejects(queued, (e) => e.code === 'QUEUE_CLEARED');
  first.catch(() => {});
});

test('a synchronously-throwing writer rejects (never throws) when the queue is disabled', async () => {
  const q = new OutboundQueue(
    () => {
      throw new Error('sync boom');
    },
    { enabled: false }
  );
  /** must return a rejected promise, preserving the promise contract */
  await assert.rejects(q.enqueue(Buffer.from([1])), /sync boom/);
});

test('clear() settles the in-flight item during a stalled write (#237)', async () => {
  /**
   * The drain loop shift()s an item out of _queue before awaiting the writer,
   * so the old clear() (which only spliced _queue) left a stalled write's
   * caller waiting forever — done() never fired and the flow message leaked
   * across a redeploy. clear() must reject the in-flight item too; the late
   * writer completion is a no-op on the already-settled promise.
   */
  let completeWrite;
  const queue = new OutboundQueue(() => new Promise((resolve) => { completeWrite = resolve; }));
  const stalled = queue.enqueue(Buffer.from([1]));
  const queued = queue.enqueue(Buffer.from([2]));

  queue.clear();
  await assert.rejects(stalled, (e) => e.code === 'QUEUE_CLEARED', 'the in-flight item settles on clear');
  await assert.rejects(queued, (e) => e.code === 'QUEUE_CLEARED', 'queued items settle as before');

  /** The writer's late completion must not wedge the loop or double-settle. */
  completeWrite();
  await new Promise((r) => setImmediate(r));

  /** The queue keeps working after the teardown/clear. */
  const after = queue.enqueue(Buffer.from([3]));
  completeWrite();
  await after;
});

test('onWrite does not fire for an in-flight item cleared mid-write', async () => {
  /**
   * clear() rejects the in-flight item on teardown, but its writer may resolve
   * later. That late completion must not fire onWrite — the send was abandoned,
   * and a stale post-teardown trace would contradict the onWrite contract.
   */
  let completeWrite;
  const queue = new OutboundQueue(() => new Promise((resolve) => { completeWrite = resolve; }));
  let wrote = 0;
  const stalled = queue.enqueue(Buffer.from([1]), 2, undefined, { onWrite: () => (wrote += 1) });

  queue.clear();
  await assert.rejects(stalled, (e) => e.code === 'QUEUE_CLEARED');

  /** Writer resolves after the clear — onWrite must stay silent. */
  completeWrite();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(wrote, 0, 'a cleared in-flight item must not fire onWrite when its write completes late');
});
