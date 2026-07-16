'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { MockRED } = require('../helpers/mock-red');

/**
 * mavlink-ai-formation node (issue #46 / #232). Geometric shapes are a stateless
 * transform of a vehicle list + anchor into fanout targets; follow-leader mode
 * holds a live registry, re-emits as the leader moves, and promotes a successor
 * when the leader goes stale.
 */

/** A connection stand-in that records the subscription and pushes messages through it. */
function stubConnection(RED, id) {
  const conn = {
    id,
    name: 'stub',
    emitter: new EventEmitter(),
    profile: null,
    filters: [],
    callbacks: [],
    subscribe: (filter, cb) => {
      conn.filters.push(filter);
      conn.callbacks.push(cb);
      return conn.callbacks.length;
    },
    unsubscribe: () => true,
    deliver: (payload) => {
      for (const cb of conn.callbacks) {
        cb({ topic: `mavlink/${payload.name}`, payload });
      }
    }
  };
  RED._nodes.set(id, conn);
  return conn;
}

function heartbeat(sysid) {
  return { name: 'HEARTBEAT', sysid, compid: 1, fields: { type: 2, autopilot: 3, base_mode: 81, custom_mode: 4, system_status: 4 } };
}

function gpi(sysid, lat, lon, alt, hdg) {
  return {
    name: 'GLOBAL_POSITION_INT',
    sysid,
    compid: 1,
    fields: { lat: lat * 1e7, lon: lon * 1e7, alt: alt * 1000, relative_alt: alt * 1000, hdg: hdg == null ? 65535 : hdg * 100 }
  };
}

/** Geometric shapes: a stateless transform of a vehicle list + anchor. */

test('a geometric shape transforms a vehicle list into a fanout payload', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'wedge', spacing: 10, anchorMode: 'msg', sendAs: 'int' });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2, 3], origin: { lat: 39.1, lon: -75.1, alt: 100 } } });
  assert.strictEqual(collected[0].topic, 'swarm/formation');
  assert.strictEqual(collected[0].payload.command, 'MAV_CMD_DO_REPOSITION');
  assert.strictEqual(collected[0].payload.command_int, true);
  assert.strictEqual(collected[0].payload.fields.frame, 'MAV_FRAME_GLOBAL');
  assert.deepStrictEqual(collected[0].payload.targets.map((t) => t.sysid), [1, 2, 3]);
});

test('accepts a swarm registry payload.vehicles directly and a fixed anchor', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', {
    id: 'fm1',
    shape: 'line',
    spacing: 10,
    anchorMode: 'fixed',
    anchorLat: 39.1,
    anchorLon: -75.1,
    anchorAlt: 100
  });
  const { collected } = await RED.inject(node, { payload: { vehicles: [{ sysid: 2 }, { sysid: 4 }] } });
  assert.deepStrictEqual(collected[0].payload.targets.map((t) => t.sysid), [2, 4]);
});

test('a geometric snapshot with no vehicles fails with NO_TARGETS', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'line', anchorMode: 'fixed', anchorLat: 39.1, anchorLon: -75.1, anchorAlt: 100 });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'NO_TARGETS');
});

test('an anchor with no altitude fails closed (no descent to sea level)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'line', anchorMode: 'msg' });
  const { collected } = await RED.inject(node, { payload: { sysids: [1], origin: { lat: 39.1, lon: -75.1 } } });
  assert.strictEqual(collected[0].payload.code, 'BAD_ANCHOR');
});

test('an explicit slot map pins a vehicle to a slot', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', {
    id: 'fm1',
    shape: 'column',
    spacing: 10,
    anchorMode: 'fixed',
    anchorLat: 39.1,
    anchorLon: -75.1,
    anchorAlt: 100,
    slotAssign: 'explicit',
    slots: '{"3": 0, "1": 1, "2": 2}'
  });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2, 3] } });
  /** sysid 3 is pinned to slot 0 (the reference), so it sits on the anchor. */
  const t = collected[0].payload.targets;
  const three = t.find((x) => x.sysid === 3);
  assert.ok(Math.abs(three.lat - 39.1) < 1e-9 && Math.abs(three.lon + 75.1) < 1e-9);
});

test('a malformed explicit slot map invalidates the node and fails closed (#204)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'line', slotAssign: 'explicit', slots: '{bad json' });
  assert.deepStrictEqual(node.statusHistory[0], { fill: 'red', shape: 'ring', text: 'invalid config' });
  const { collected } = await RED.inject(node, { payload: { sysids: [1] } });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'INVALID_CONFIG');
});

test('a reposition payload keeps current yaw and default speed, not 0/north (#244 review)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'line', spacing: 10, anchorMode: 'msg', sendAs: 'int' });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2], origin: { lat: 39.1, lon: -75.1, alt: 100 } } });
  const f = collected[0].payload.fields;
  assert.strictEqual(f.param1, -1); /** default ground speed, not 0 m/s */
  assert.strictEqual(f.param2, 1); /** switch to guided so the reposition is accepted */
  assert.ok(Number.isNaN(f.param4), 'param4 (yaw) is NaN = keep current heading, not yaw-to-north');
  /** An explicit fields override wins. */
  const o = await RED.inject(node, { payload: { sysids: [1], origin: { lat: 39.1, lon: -75.1, alt: 100 }, fields: { param4: 0 } } });
  assert.strictEqual(o.collected[0].payload.fields.param4, 0);
});

test('a non-reposition command does not get reposition param defaults', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', {
    id: 'fm1',
    shape: 'line',
    anchorMode: 'fixed',
    anchorLat: 39.1,
    anchorLon: -75.1,
    anchorAlt: 100,
    command: 'MAV_CMD_NAV_WAYPOINT'
  });
  const { collected } = await RED.inject(node, { payload: { sysids: [1] } });
  const f = collected[0].payload.fields;
  assert.strictEqual(f.param1, undefined);
  assert.strictEqual(f.param4, undefined);
});

test('dry_run is omitted unless enabled, so it cannot override a downstream fanout (#244 review)', async () => {
  const RED = new MockRED().loadNodes();
  const off = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'line', anchorMode: 'fixed', anchorLat: 39.1, anchorLon: -75.1, anchorAlt: 100 });
  const a = await RED.inject(off, { payload: { sysids: [1] } });
  assert.ok(!('dry_run' in a.collected[0].payload), 'dry_run is absent when the node has it off');
  const on = RED.create('mavlink-ai-formation', { id: 'fm2', shape: 'line', anchorMode: 'fixed', anchorLat: 39.1, anchorLon: -75.1, anchorAlt: 100, dryRun: true });
  const b = await RED.inject(on, { payload: { sysids: [1] } });
  assert.strictEqual(b.collected[0].payload.dry_run, true);
});

test('an explicit localIdentity is preserved into the fanout payload (#244 review)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'line', anchorMode: 'fixed', anchorLat: 39.1, anchorLon: -75.1, anchorAlt: 100 });
  const { collected } = await RED.inject(node, { payload: { sysids: [1], localIdentity: 'gcs-2' } });
  assert.strictEqual(collected[0].payload.localIdentity, 'gcs-2');
});

/** Follow-leader: a live registry that tracks a leader and promotes a successor. */

/** Follow-leader node with a controllable clock and a stub connection. */
function followSetup(config, startNow = 1000) {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  const clock = { now: startNow };
  const node = RED.create(
    'mavlink-ai-formation',
    Object.assign({ id: 'fm1', shape: 'follow-leader', connection: 'c1', leaderSysid: 1, spacing: 10, updateHz: 100, minMoveM: 0 }, config)
  );
  node._now = () => clock.now;
  return { RED, conn, node, clock };
}

test('follow-leader emits follower targets around the leader once it has a position', async () => {
  const { RED, conn, node } = followSetup({ headingSource: 'leader' });
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2));
  conn.deliver(heartbeat(3));
  /** No leader position yet: nothing emitted, and NO succession (heartbeating != stale). */
  assert.strictEqual(node.sent.length, 0);
  conn.deliver(gpi(2, 39.1, -75.1, 100, 0));
  conn.deliver(gpi(3, 39.1, -75.1, 100, 0));
  assert.strictEqual(node.sent.length, 0, 'still waiting for the leader position');
  conn.deliver(gpi(1, 39.1, -75.1, 100, 0));
  const last = node.sent[node.sent.length - 1];
  assert.strictEqual(last.topic, 'swarm/formation');
  assert.strictEqual(last.payload.leader, 1);
  assert.deepStrictEqual(last.payload.targets.map((t) => t.sysid), [2, 3]);
  await RED.close(node);
});

test('the rate limit gates re-emits within the update window', async () => {
  const { conn, node, clock } = followSetup({ updateHz: 2, minMoveM: 0 }); /** 500 ms window */
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2));
  conn.deliver(gpi(1, 39.1, -75.1, 100, 0)); /** first emit */
  assert.strictEqual(node.sent.length, 1);
  clock.now += 100; /** inside the 500 ms window */
  conn.deliver(gpi(1, 39.10001, -75.1, 100, 0));
  assert.strictEqual(node.sent.length, 1, 'dropped inside the rate-limit window');
  clock.now += 500; /** past the window */
  conn.deliver(gpi(1, 39.10002, -75.1, 100, 0));
  assert.strictEqual(node.sent.length, 2, 'emitted after the window');
});

test('leader going stale promotes the next present sysid (leader + 1)', async () => {
  const { conn, node, clock } = followSetup({ staleAction: 'successor', staleMs: 5000 });
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2));
  conn.deliver(heartbeat(3));
  conn.deliver(gpi(1, 39.1, -75.1, 100, 0));
  conn.deliver(gpi(2, 39.1, -75.1, 100, 0));
  conn.deliver(gpi(3, 39.1, -75.1, 100, 0));
  assert.strictEqual(node.sent[node.sent.length - 1].payload.leader, 1);
  /** Advance past staleMs and refresh only 2 and 3, so leader 1 is stale. */
  clock.now += 7000;
  conn.deliver(heartbeat(2)); /** triggers succession 1 -> 2 (no emit yet) */
  conn.deliver(heartbeat(3));
  conn.deliver(gpi(2, 39.1, -75.1, 100, 0)); /** leader 2 now has a FRESH fix -> emit */
  const last = node.sent[node.sent.length - 1];
  assert.strictEqual(last.payload.leader, 2);
  /** 1 is stale (excluded), 2 is the leader, so only 3 is a follower now. */
  assert.deepStrictEqual(last.payload.targets.map((t) => t.sysid), [3]);
});

test('successor promotes a vehicle that appears after the no-candidate state (#244 review)', async () => {
  const { conn, node, clock } = followSetup({ leaderSysid: 1, staleAction: 'successor', staleMs: 5000 });
  conn.deliver(heartbeat(1));
  conn.deliver(gpi(1, 39.1, -75.1, 100, 0));
  clock.now += 7000; /** leader 1 goes stale as the only vehicle */
  node._maybeEmit(false); /** a tick with no candidates → "no live leader" */
  /** Vehicles appear later; the previously-stuck successor mode must now promote. */
  conn.deliver(heartbeat(2));
  conn.deliver(heartbeat(3));
  conn.deliver(gpi(2, 39.1, -75.1, 100, 0));
  conn.deliver(gpi(3, 39.1, -75.1, 100, 0));
  const last = node.sent[node.sent.length - 1];
  assert.strictEqual(last.payload.leader, 2, 'promoted the newly-appeared vehicle');
  assert.deepStrictEqual(last.payload.targets.map((t) => t.sysid), [3]);
});

test('a new follower joining a stationary leader triggers a re-emit (#244 review)', async () => {
  const { conn, node, clock } = followSetup({ leaderSysid: 1, updateHz: 2, minMoveM: 5 });
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2));
  conn.deliver(gpi(1, 39.1, -75.1, 100, 0)); /** first emit, followers [2] */
  const firstCount = node.sent.length;
  assert.deepStrictEqual(node.sent[firstCount - 1].payload.targets.map((t) => t.sysid), [2]);
  /** Leader has not moved (< minMoveM), but a new follower appears past the window. */
  clock.now += 600;
  conn.deliver(heartbeat(3));
  assert.ok(node.sent.length > firstCount, 're-emitted on membership change despite a stationary leader');
  const last = node.sent[node.sent.length - 1];
  assert.deepStrictEqual(last.payload.targets.map((t) => t.sysid), [2, 3]);
});

test('a stale leader position blocks emission, even on a forced input (#244 review)', async () => {
  const { conn, node, clock } = followSetup({ leaderSysid: 1, staleMs: 5000 });
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2));
  conn.deliver(gpi(1, 39.1, -75.1, 100, 0)); /** fresh fix -> emits */
  const before = node.sent.length;
  assert.ok(before >= 1);
  /** Leader keeps heartbeating, but its position feed goes silent for 7 s. */
  clock.now += 7000;
  conn.deliver(heartbeat(1)); /** heartbeat fresh (not stale), position is now 7 s old */
  node._maybeEmit(true); /** a forced emit must NOT command around the stale fix */
  assert.strictEqual(node.sent.length, before, 'no emit around a stale leader position');
});

test('stale action "hold" stops emitting and does not switch leader', async () => {
  const { conn, node, clock } = followSetup({ staleAction: 'hold', staleMs: 5000 });
  conn.deliver(heartbeat(1));
  conn.deliver(heartbeat(2));
  conn.deliver(gpi(1, 39.1, -75.1, 100, 0));
  conn.deliver(gpi(2, 39.1, -75.1, 100, 0));
  const before = node.sent.length;
  assert.strictEqual(node.sent[before - 1].payload.leader, 1);
  clock.now += 7000; /** leader 1 stale */
  conn.deliver(heartbeat(2));
  conn.deliver(heartbeat(2));
  assert.strictEqual(node.sent.length, before, 'held: no further emits');
});

test('follow-leader with no connection badges and answers NO_CONNECTION', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'follow-leader', connection: 'missing', leaderSysid: 1 });
  assert.deepStrictEqual(node.statusHistory[0], { fill: 'red', shape: 'ring', text: 'missing connection' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'NO_CONNECTION');
});
