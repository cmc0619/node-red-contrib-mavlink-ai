'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { buildFanout } = require('../../lib/swarm/fanout');

// ---------------------------------------------------------------------------
// buildFanout (pure)
// ---------------------------------------------------------------------------

test('fan-out expands one command into one message per sysid (#46)', () => {
  const messages = buildFanout({
    command: 'MAV_CMD_DO_SET_MODE',
    targets: [1, 2, '3'],
    base: { param1: 1, param2: 4 }
  });
  assert.strictEqual(messages.length, 3);
  assert.deepStrictEqual(messages.map((m) => m.target_system), [1, 2, 3]);
  for (const m of messages) {
    assert.strictEqual(m.name, 'COMMAND_LONG');
    assert.strictEqual(m.fields.command, 'MAV_CMD_DO_SET_MODE');
    assert.strictEqual(m.fields.param1, 1);
    assert.strictEqual(m.fields.param2, 4);
  }
});

test('per-target objects override shared params and carry coordinates (#46)', () => {
  const messages = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: true,
    targets: [
      { sysid: 1, lat: 39.1, lon: -75.1, alt: 40 },
      { sysid: 2, lat: 39.1001, lon: -75.1, alt: 40, param1: 5 }
    ],
    base: { param1: -1 }
  });
  assert.strictEqual(messages[0].name, 'COMMAND_INT');
  assert.strictEqual(messages[0].fields.x, 391000000); // degE7 wire scaling
  assert.strictEqual(messages[0].fields.y, -751000000);
  assert.strictEqual(messages[0].fields.z, 40);
  assert.strictEqual(messages[0].fields.param1, -1);
  assert.strictEqual(messages[1].fields.x, 391001000);
  assert.strictEqual(messages[1].fields.param1, 5); // per-target override wins
});

test('meter offsets from a shared origin become per-vehicle lat/lon (#46)', () => {
  const origin = { lat: 39.1, lon: -75.1, alt: 40 };
  const messages = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: true,
    origin,
    targets: [
      { sysid: 1, north: 0, east: 0 },
      { sysid: 2, east: 10 },
      { sysid: 3, east: -10, up: 5 }
    ]
  });
  assert.strictEqual(messages[0].fields.x, 391000000); // slot at origin
  assert.ok(messages[1].fields.y > messages[0].fields.y, 'east offset increases lon');
  assert.ok(messages[2].fields.y < messages[0].fields.y, 'west offset decreases lon');
  assert.strictEqual(messages[0].fields.z, 40);
  assert.strictEqual(messages[2].fields.z, 45); // up 5 raises altitude
});

test('offset targets without an origin fail loudly (#46)', () => {
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', targets: [{ sysid: 1, east: 10 }] }),
    (err) => err.code === 'MISSING_ORIGIN'
  );
});

test('COMMAND_LONG positions ride param5/6/7 as float degrees (#46)', () => {
  const [m] = buildFanout({
    command: 'MAV_CMD_NAV_WAYPOINT',
    targets: [{ sysid: 1, lat: 39.1, lon: -75.1, alt: 25 }]
  });
  assert.strictEqual(m.name, 'COMMAND_LONG');
  assert.strictEqual(m.fields.param5, 39.1);
  assert.strictEqual(m.fields.param6, -75.1);
  assert.strictEqual(m.fields.param7, 25);
});

test('broadcast builds a single target_system-0 message (#46)', () => {
  const messages = buildFanout({
    command: 'MAV_CMD_SET_MESSAGE_INTERVAL',
    broadcast: true,
    base: { param1: 33, param2: 100000 },
    targets: [1, 2, 3] // ignored: broadcast is one identical message
  });
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].target_system, 0);
  assert.strictEqual(messages[0].target_component, 0);
});

test('non-numeric params and coordinates fail fast instead of emitting NaN (#46)', () => {
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_SET_MODE', targets: [{ sysid: 1, param2: 'GUIDED-ish' }] }),
    (e) => e.code === 'BAD_PARAM' && /param2/.test(e.message)
  );
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_SET_MODE', targets: [1], base: { param1: NaN } }),
    (e) => e.code === 'BAD_PARAM'
  );
  assert.throws(
    // Non-numeric lat/lon now go through the shared range validator (#55),
    // which reports the more specific INVALID_FIELD.
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', targets: [{ sysid: 1, lat: 'x', lon: 8.5 }] }),
    (e) => e.code === 'INVALID_FIELD'
  );
  assert.throws(
    () =>
      buildFanout({
        command: 'MAV_CMD_NAV_WAYPOINT',
        targets: [{ sysid: 1, lat: 39.1, lon: -75.1, alt: 'high' }]
      }),
    (e) => e.code === 'BAD_COORDINATES'
  );
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_NAV_LAND', targets: [{ sysid: 1, target_component: 'gimbal' }] }),
    (e) => e.code === 'BAD_PARAM' && /target_component/.test(e.message)
  );
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', useInt: true, targets: [{ sysid: 1, x: null, y: 1 }] }),
    (e) => e.code === 'BAD_PARAM'
  );
});

test('fan-out rejects an out-of-range target latitude (#55)', () => {
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', targets: [{ sysid: 1, lat: 200, lon: 8.5 }] }),
    (e) => e.code === 'INVALID_FIELD' && e.context.field === 'lat' && e.context.sysid === 1
  );
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', targets: [{ sysid: 2, lat: 39, lon: -999 }] }),
    (e) => e.code === 'INVALID_FIELD' && e.context.field === 'lon'
  );
});

test('empty target list and missing command fail with structured codes (#46)', () => {
  assert.throws(() => buildFanout({ command: 'MAV_CMD_NAV_LAND', targets: [] }), (e) => e.code === 'NO_TARGETS');
  assert.throws(() => buildFanout({ targets: [1] }), (e) => e.code === 'NO_COMMAND');
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_NAV_LAND', targets: [{ lat: 1 }] }),
    (e) => e.code === 'BAD_TARGET'
  );
});

// ---------------------------------------------------------------------------
// mavlink-ai-fanout node
// ---------------------------------------------------------------------------

/**
 * Connection stand-in that auto-acks commands per a scripted result table:
 * sysid -> MAV_RESULT number, or undefined for silence (timeout).
 */
function stubAckConnection(RED, id, script) {
  const subs = new Map();
  let nextId = 1;
  const conn = {
    id,
    name: 'stub',
    emitter: new (require('events').EventEmitter)(),
    statusState: 'connected',
    sent: [],
    subscribe: (filter, cb) => {
      const sid = nextId++;
      subs.set(sid, cb);
      return sid;
    },
    unsubscribe: (sid) => subs.delete(sid),
    send: (message) => {
      conn.sent.push(message);
      const sysid = message.fields.target_system;
      const result = script[sysid];
      if (result !== undefined) {
        setImmediate(() => {
          for (const cb of subs.values()) {
            cb({
              topic: 'mavlink/COMMAND_ACK',
              payload: { name: 'COMMAND_ACK', sysid, compid: 1, fields: { command: message.fields.command, result } }
            });
          }
        });
      }
      return Promise.resolve();
    }
  };
  RED._nodes.set(id, conn);
  return conn;
}

function setup(extraConfig, script) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    sourceSystemId: 255,
    sourceComponentId: 190,
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  const conn = stubAckConnection(RED, 'c1', script || {});
  const node = RED.create(
    'mavlink-ai-fanout',
    Object.assign({ id: 'f1', profile: 'p1', connection: 'c1' }, extraConfig)
  );
  return { RED, node, conn };
}

test('node fans out to payload.sysids as mavlink/send messages (#46)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_NAV_RETURN_TO_LAUNCH' });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2] } });
  assert.strictEqual(collected.length, 1);
  const batch = collected[0][0]; // one output, multiple messages
  assert.strictEqual(batch.length, 2);
  assert.strictEqual(batch[0].topic, 'mavlink/send');
  assert.strictEqual(batch[0].payload.target_system, 1);
  assert.strictEqual(batch[1].payload.target_system, 2);
});

test('node accepts a swarm registry output (payload.vehicles) directly (#46)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_NAV_LAND' });
  const vehicles = [
    { sysid: 1, compid: 1, type_name: 'MAV_TYPE_QUADROTOR' },
    { sysid: 1, compid: 100 }, // second component of the same system
    { sysid: 4, compid: 1 }
  ];
  const { collected } = await RED.inject(node, { payload: { vehicles } });
  const batch = collected[0][0];
  assert.deepStrictEqual(batch.map((m) => m.payload.target_system), [1, 4]); // deduped
});

test('dry-run outputs the built messages without sending (#46)', async () => {
  const { RED, node, conn } = setup({ command: 'MAV_CMD_NAV_LAND', awaitAck: true, dryRun: true });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2] } });
  assert.strictEqual(collected[0].topic, 'swarm/dryrun');
  assert.strictEqual(collected[0].payload.count, 2);
  assert.strictEqual(conn.sent.length, 0);
});

test('await-acks aggregates accepted/failed/timedOut per sysid (#46)', async () => {
  // timeoutMs is generous on purpose: sysids 1/2/4 ack "immediately" (setImmediate
  // in the stub) and must be classified by their ack, never by a timeout. A tight
  // timeout (e.g. 40ms) races the immediate acks under event-loop starvation on a
  // loaded CI runner — a >40ms stall lets sysid 1's timeout fire before its queued
  // ack is processed, wrongly bucketing it as timedOut. Only the genuinely-silent
  // sysid 5 should ever hit the timeout, so a large value stays reliable while the
  // acked sysids still finish near-instantly.
  const { RED, node } = setup(
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', awaitAck: true, timeoutMs: 1000, maxRetries: 0 },
    { 1: 0, 2: 0, 4: 2 /* MAV_RESULT_DENIED */ } // sysid 5 stays silent -> timeout
  );
  // The workflow's retry timer is unref'd; keep the loop alive while it runs.
  const keepAlive = setInterval(() => {}, 10);
  const { collected } = await RED.inject(node, {
    payload: { sysids: [1, 2, 4, 5], fields: { param1: 1 } }
  });
  clearInterval(keepAlive);
  assert.strictEqual(collected[0].topic, 'swarm/ack');
  const out = collected[0].payload;
  assert.deepStrictEqual(out.accepted, [1, 2]);
  assert.deepStrictEqual(out.failed, [4]);
  assert.deepStrictEqual(out.timedOut, [5]);
  assert.strictEqual(out.results['1'].result, 'MAV_RESULT_ACCEPTED');
  assert.strictEqual(out.results['4'].error, 'COMMAND_REJECTED');
  assert.strictEqual(out.results['5'].error, 'COMMAND_TIMEOUT');
});

test('stop-on-error skips remaining targets after the first failure (#46)', async () => {
  // Generous timeout for the same reason as the aggregation test above: sysids
  // 1/2 ack immediately and must be classified by their ack, not a timeout race
  // under load. No sysid is silent here, so a large timeout never actually fires.
  const { RED, node } = setup(
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', awaitAck: true, timeoutMs: 1000, maxRetries: 0, stopOnError: true },
    { 1: 0, 2: 2, 3: 0 }
  );
  const keepAlive = setInterval(() => {}, 10);
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2, 3] } });
  clearInterval(keepAlive);
  const out = collected[0].payload;
  assert.deepStrictEqual(out.accepted, [1]);
  assert.deepStrictEqual(out.failed, [2]);
  assert.deepStrictEqual(out.skipped, [3]);
  assert.strictEqual(out.results['3'].error, 'SKIPPED');
});

test('broadcast with await-acks is rejected (BROADCAST_NO_ACK) (#46)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_NAV_LAND', mode: 'broadcast', awaitAck: true });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'BROADCAST_NO_ACK');
});

test('broadcast build mode emits a single target_system-0 message (#46)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_SET_MESSAGE_INTERVAL', mode: 'broadcast' });
  const { collected } = await RED.inject(node, { payload: { fields: { param1: 33, param2: 100000 } } });
  const batch = collected[0][0];
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].payload.target_system, 0);
});

test('missing targets yields a structured NO_TARGETS error (#46)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_NAV_LAND' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'NO_TARGETS');
});
