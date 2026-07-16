'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  slotOffsets,
  bodyToNed,
  assignSlots,
  formationTargets,
  nextLeaderSysid,
  moveDistanceMeters
} = require('../../lib/swarm/formation');
const { globalToNedOffset } = require('../../lib/swarm/coordinate-frames');

/**
 * Formation geometry (issue #46 / #232). Pure math: slot layouts in the body
 * frame, heading rotation, deterministic slot assignment, global targets around
 * an anchor, and leader succession.
 */

test('slotOffsets lays out each shape with slot 0 on the reference', () => {
  assert.deepStrictEqual(slotOffsets('line', 3, 10), [
    { forward: 0, right: 0, down: 0 },
    { forward: 0, right: 10, down: 0 },
    { forward: 0, right: -10, down: 0 }
  ]);
  assert.deepStrictEqual(slotOffsets('column', 3, 10), [
    { forward: 0, right: 0, down: 0 },
    { forward: -10, right: 0, down: 0 },
    { forward: -20, right: 0, down: 0 }
  ]);
  assert.deepStrictEqual(slotOffsets('wedge', 3, 10), [
    { forward: 0, right: 0, down: 0 },
    { forward: -10, right: 10, down: 0 },
    { forward: -10, right: -10, down: 0 }
  ]);
});

test('circle puts the reference at the center and the rest on a ring', () => {
  const c = slotOffsets('circle', 4, 10);
  assert.deepStrictEqual(c[0], { forward: 0, right: 0, down: 0 });
  /** Three on a ring of radius 10 at 0°, 120°, 240°. */
  assert.ok(Math.abs(c[1].forward - 10) < 1e-9 && Math.abs(c[1].right) < 1e-9);
  assert.ok(Math.abs(Math.hypot(c[2].forward, c[2].right) - 10) < 1e-9);
  assert.ok(Math.abs(Math.hypot(c[3].forward, c[3].right) - 10) < 1e-9);
});

test('an unknown shape throws BAD_FORMATION', () => {
  assert.throws(() => slotOffsets('spiral', 3, 10), (e) => e.code === 'BAD_FORMATION');
});

test('grid keeps slot 0 on the reference and trails the rest behind (#244 review)', () => {
  const g = slotOffsets('grid', 4, 10);
  assert.deepStrictEqual(g[0], { forward: 0, right: 0, down: 0 });
  /** Every follower trails behind the reference (forward < 0). */
  assert.ok(g.slice(1).every((o) => o.forward < 0));
  /** A single-vehicle grid is just the reference. */
  assert.deepStrictEqual(slotOffsets('grid', 1, 10), [{ forward: 0, right: 0, down: 0 }]);
});

test('duplicate explicit slot assignments are rejected (#244 review)', () => {
  assert.throws(() => assignSlots([1, 2], { slotMap: { 1: 0, 2: 0 } }), (e) => e.code === 'BAD_SLOT');
  /** A pinned slot that collides with an auto-filled one is also caught. */
  assert.throws(() => assignSlots([1, 2, 3], { slotMap: { 3: 0, 1: 0 } }), (e) => e.code === 'BAD_SLOT');
});

test('bodyToNed rotates forward/right into north/east by heading', () => {
  /** Heading 0 (north): forward -> north, right -> east. */
  const n0 = bodyToNed({ forward: 5, right: 3 }, 0);
  assert.ok(Math.abs(n0.north - 5) < 1e-9 && Math.abs(n0.east - 3) < 1e-9);
  /** Heading 90 (east): forward -> east, right -> south (-north). */
  const n90 = bodyToNed({ forward: 5, right: 3 }, 90);
  assert.ok(Math.abs(n90.north + 3) < 1e-9 && Math.abs(n90.east - 5) < 1e-9);
});

test('assignSlots is sorted-sysid order by default and honors an explicit map', () => {
  assert.deepStrictEqual([...assignSlots([3, 1, 2]).entries()], [
    [1, 0],
    [2, 1],
    [3, 2]
  ]);
  /** sysid 3 pinned to slot 1; the rest auto-fill the lowest free slots (0, 2). */
  const explicit = assignSlots([1, 2, 3], { slotMap: { 3: 1 } });
  assert.strictEqual(explicit.get(3), 1);
  assert.strictEqual(explicit.get(1), 0);
  assert.strictEqual(explicit.get(2), 2);
  /** startSlot reserves the low slots (follow-leader reserves slot 0 for the leader). */
  assert.deepStrictEqual([...assignSlots([5, 6, 7], { startSlot: 1 }).entries()], [
    [5, 1],
    [6, 2],
    [7, 3]
  ]);
});

test('a non-integer explicit slot index is rejected (BAD_SLOT)', () => {
  assert.throws(() => assignSlots([1], { slotMap: { 1: 'left' } }), (e) => e.code === 'BAD_SLOT');
  assert.throws(() => assignSlots([1], { slotMap: { 1: -2 } }), (e) => e.code === 'BAD_SLOT');
});

test('formationTargets places vehicles around the anchor at the anchor altitude', () => {
  const anchor = { lat: 39.1, lon: -75.1, alt: 100 };
  const t = formationTargets({ shape: 'line', spacing: 10, anchor, headingDeg: 0, sysids: [1, 2, 3] });
  assert.strictEqual(t.length, 3);
  assert.deepStrictEqual(t.map((x) => x.sysid), [1, 2, 3]);
  /** Slot 0 (sysid 1) sits on the anchor; all inherit the anchor altitude. */
  assert.ok(Math.abs(t[0].lat - 39.1) < 1e-9 && Math.abs(t[0].lon + 75.1) < 1e-9);
  t.forEach((x) => assert.ok(Math.abs(x.alt - 100) < 1e-9));
  /** sysid 2 is 10 m east, sysid 3 is 10 m west (recovered via the inverse transform). */
  const o2 = globalToNedOffset(anchor, t[1]);
  assert.ok(Math.abs(o2.north) < 1e-6 && Math.abs(o2.east - 10) < 1e-3);
  const o3 = globalToNedOffset(anchor, t[2]);
  assert.ok(Math.abs(o3.east + 10) < 1e-3);
});

test('heading rotates the whole pattern — a column trails opposite the heading', () => {
  const anchor = { lat: 39.1, lon: -75.1, alt: 100 };
  /** Column, leader heading east (90°): the trailing vehicle sits 10 m WEST. */
  const t = formationTargets({ shape: 'column', spacing: 10, anchor, headingDeg: 90, sysids: [1, 2] });
  const o = globalToNedOffset(anchor, t[1]);
  assert.ok(Math.abs(o.north) < 1e-6 && Math.abs(o.east + 10) < 1e-3);
});

test('startSlot 1 reserves the anchor slot for a leader (follow-leader layout)', () => {
  const anchor = { lat: 39.1, lon: -75.1, alt: 100 };
  /** Two followers, wedge, north heading, slot 0 reserved: both are behind and to the sides. */
  const t = formationTargets({ shape: 'wedge', spacing: 10, anchor, headingDeg: 0, sysids: [2, 3], startSlot: 1 });
  const o2 = globalToNedOffset(anchor, t[0]);
  const o3 = globalToNedOffset(anchor, t[1]);
  assert.ok(o2.north < 0 && o2.east > 0, 'first follower is behind-right');
  assert.ok(o3.north < 0 && o3.east < 0, 'second follower is behind-left');
});

test('formationTargets fails closed on a missing anchor / altitude / empty list', () => {
  assert.throws(
    () => formationTargets({ shape: 'line', spacing: 10, anchor: { lat: 39.1, lon: -75.1 }, sysids: [1] }),
    (e) => e.code === 'BAD_ANCHOR'
  );
  assert.throws(
    () => formationTargets({ shape: 'line', spacing: 10, anchor: null, sysids: [1] }),
    (e) => e.code === 'BAD_ANCHOR'
  );
  assert.throws(
    () => formationTargets({ shape: 'line', spacing: 10, anchor: { lat: 39.1, lon: -75.1, alt: 100 }, sysids: [] }),
    (e) => e.code === 'NO_TARGETS'
  );
});

test('nextLeaderSysid promotes the next present sysid, wrapping (leader + 1)', () => {
  assert.strictEqual(nextLeaderSysid(1, [1, 2, 3]), 2);
  assert.strictEqual(nextLeaderSysid(2, [1, 2, 4, 5]), 4);
  /** No higher present sysid wraps to the lowest. */
  assert.strictEqual(nextLeaderSysid(3, [1, 2, 3]), 1);
  /** No other vehicle → no successor. */
  assert.strictEqual(nextLeaderSysid(1, [1]), null);
  assert.strictEqual(nextLeaderSysid(1, []), null);
});

test('moveDistanceMeters measures horizontal displacement', () => {
  assert.strictEqual(moveDistanceMeters({ lat: 39.1, lon: -75.1 }, { lat: 39.1, lon: -75.1 }), 0);
  /** ~10 m east at this latitude (a small longitude delta). */
  const d = moveDistanceMeters({ lat: 39.1, lon: -75.1 }, { lat: 39.1, lon: -75.099884 });
  assert.ok(d > 8 && d < 12, `expected ~10 m, got ${d}`);
});
