'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { fakeIdentity } = require('../helpers/v3-config');
const { buildFanout } = require('../../lib/swarm/fanout');
const { loadDialect } = require('../../lib/dialects/dialect-loader');

const ENUMS = loadDialect('common').enums;

// ---------------------------------------------------------------------------
// Fail-fast command/frame validation (#72): reject a bad command/frame at the
// fan-out node, matching the Mission node, instead of deferring to the codec
// (which in build-only mode surfaces late in the decoupled Out node).
// ---------------------------------------------------------------------------

test('fan-out rejects an out-of-range numeric command up front', () => {
  assert.throws(
    () => buildFanout({ command: 70000, targets: [1] }),
    (e) => e.code === 'INVALID_FIELD' && /command/.test(e.message)
  );
});

test('fan-out rejects an unknown command NAME against the dialect', () => {
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DEFINITELY_NOT_REAL', targets: [1], enums: ENUMS }),
    (e) => e.code === 'INVALID_FIELD' && /not a known MavCmd/.test(e.message)
  );
});

test('fan-out rejects an out-of-range / unknown COMMAND_INT frame up front', () => {
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', useInt: true, targets: [{ sysid: 1, frame: 300 }], enums: ENUMS }),
    (e) => e.code === 'INVALID_FIELD' && /frame/.test(e.message)
  );
  assert.throws(
    () =>
      buildFanout({
        command: 'MAV_CMD_DO_REPOSITION',
        useInt: true,
        targets: [{ sysid: 1, frame: 'MAV_FRAME_NOPE', lat: 1, lon: 1, alt: 1 }],
        enums: ENUMS
      }),
    (e) => e.code === 'INVALID_FIELD' && /not a known MavFrame/.test(e.message)
  );
});

test('fan-out preserves the numeric escape hatch: a valid-but-undefined enum id passes', () => {
  // frame 12 is a valid uint8 that need not be a named MAV_FRAME — intentional
  // escape hatch, identical to Mission; validation must not reject it.
  const messages = buildFanout({
    command: 400, // MAV_CMD_COMPONENT_ARM_DISARM, as a raw number
    useInt: true,
    targets: [{ sysid: 1, frame: 12, lat: 1, lon: 1, alt: 1 }],
    enums: ENUMS
  });
  assert.strictEqual(messages[0].fields.frame, 12);
  assert.strictEqual(messages[0].fields.command, 400);
});

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
  /**
   * A non-numeric garbage param still fails. (An explicit NaN param is now a
   * legal "keep current" value and is exercised in the #142 test, so it is no
   * longer rejected here.)
   */
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_SET_MODE', targets: [1], base: { param1: 'not-a-number' } }),
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
    (e) => e.code === 'INVALID_FIELD' && /target_component/.test(e.message)
  );
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', useInt: true, targets: [{ sysid: 1, x: null, y: 1 }] }),
    (e) => e.code === 'BAD_PARAM'
  );
});

test('fan-out carries an explicit NaN command param (PX4 keep-current), not 0 or an error (#142)', () => {
  const messages = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    targets: [
      { sysid: 1, param4: NaN },
      { sysid: 2, param4: 'NaN' },
      { sysid: 3, param4: null }
    ]
  });
  assert.ok(Number.isNaN(messages[0].fields.param4), 'numeric NaN is preserved on the wire');
  assert.ok(Number.isNaN(messages[1].fields.param4), '"NaN" string resolves to NaN');
  assert.ok(Number.isNaN(messages[2].fields.param4), 'null resolves to NaN');
  /** Unspecified params still default to 0; explicit numbers stay numeric. */
  assert.strictEqual(messages[0].fields.param1, 0);
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

test('fan-out range-checks target ids and COMMAND_INT wire coordinates (#72)', () => {
  // Out-of-range target system.
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_NAV_LAND', targets: [999] }),
    (e) => e.code === 'INVALID_FIELD' && e.context.field === 'target_system'
  );
  // sysid 0 is broadcast, not a fan-out target.
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_NAV_LAND', targets: [0] }),
    (e) => e.code === 'BAD_TARGET' && /broadcast/.test(e.message)
  );
  // Out-of-range target component.
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_NAV_LAND', targets: [{ sysid: 1, target_component: 300 }] }),
    (e) => e.code === 'INVALID_FIELD' && e.context.field === 'target_component'
  );
  // COMMAND_INT raw x/y outside int32.
  assert.throws(
    () => buildFanout({ command: 'MAV_CMD_DO_REPOSITION', useInt: true, targets: [{ sysid: 1, x: 3e9, y: 1 }] }),
    (e) => e.code === 'BAD_COORDINATES' && e.context.field === 'x'
  );
  // COMMAND_INT param5/param6 fallback treated as degrees must be in range.
  assert.throws(
    () =>
      buildFanout({
        command: 'MAV_CMD_DO_REPOSITION',
        useInt: true,
        targets: [{ sysid: 1, param5: 200, param6: 8 }]
      }),
    (e) => e.code === 'INVALID_FIELD' && e.context.field === 'param5'
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
    resolveOutboundIdentity: () => fakeIdentity(),
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

/**
 * Connection stand-in that acks every send after `ackDelayMs`, and records the
 * peak number of sends in flight at once — so a test can assert the fan-out
 * dispatcher actually runs up to `concurrency` await-ack workflows in parallel
 * (#155). Deterministic: with concurrency N and a delayed ack, the first N sends
 * are all outstanding before any ack lands, so maxInFlight settles at
 * min(N, targets).
 */
function probeAckConnection(RED, id, ackDelayMs) {
  const subs = new Map();
  let nextId = 1;
  let inFlight = 0;
  const conn = {
    id,
    name: 'probe',
    emitter: new (require('events').EventEmitter)(),
    statusState: 'connected',
    sent: [],
    maxInFlight: 0,
    subscribe: (filter, cb) => {
      const sid = nextId++;
      subs.set(sid, cb);
      return sid;
    },
    unsubscribe: (sid) => subs.delete(sid),
    resolveOutboundIdentity: () => fakeIdentity(),
    send: (message) => {
      conn.sent.push(message);
      inFlight += 1;
      conn.maxInFlight = Math.max(conn.maxInFlight, inFlight);
      const sysid = message.fields.target_system;
      const command = message.fields.command;
      setTimeout(() => {
        inFlight -= 1;
        for (const cb of subs.values()) {
          cb({
            topic: 'mavlink/COMMAND_ACK',
            payload: { name: 'COMMAND_ACK', sysid, compid: 1, fields: { command, result: 0 } }
          });
        }
      }, ackDelayMs);
      return Promise.resolve();
    }
  };
  RED._nodes.set(id, conn);
  return conn;
}

/**
 * Build a fan-out node wired to a probe connection (above).
 *
 * @param {object} extraConfig  fan-out node config overrides
 * @param {number} ackDelayMs   how long the probe waits before acking each send
 * @returns {{RED: MockRED, node: object, conn: object}}
 */
function setupProbe(extraConfig, ackDelayMs) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  const conn = probeAckConnection(RED, 'c1', ackDelayMs);
  const node = RED.create(
    'mavlink-ai-fanout',
    Object.assign({ id: 'f1', profile: 'p1', connection: 'c1', delivery: 'build' }, extraConfig)
  );
  return { RED, node, conn };
}

function setup(extraConfig, script) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  const conn = stubAckConnection(RED, 'c1', script || {});
  const node = RED.create(
    'mavlink-ai-fanout',
    Object.assign({ id: 'f1', profile: 'p1', connection: 'c1', delivery: 'build' }, extraConfig)
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
  // The profile rides along as the canonical config-node id, name for display.
  assert.strictEqual(batch[0].payload.vehicleProfile, 'p1');
  assert.strictEqual(batch[1].payload.vehicleProfile, 'p1');
  assert.strictEqual(batch[0].payload.vehicleProfileName, 'Copter');
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
  const { RED, node, conn } = setup({ command: 'MAV_CMD_NAV_LAND', delivery: 'await', dryRun: true });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2] } });
  assert.strictEqual(collected[0][0].topic, 'swarm/dryrun');
  assert.strictEqual(collected[0][0].payload.count, 2);
  assert.strictEqual(conn.sent.length, 0);
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
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
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'await', timeoutMs: 1000, maxRetries: 0 },
    { 1: 0, 2: 0, 4: 2 /* MAV_RESULT_DENIED */ } // sysid 5 stays silent -> timeout
  );
  // The workflow's retry timer is unref'd; keep the loop alive while it runs.
  const keepAlive = setInterval(() => {}, 10);
  const { collected } = await RED.inject(node, {
    payload: { sysids: [1, 2, 4, 5], fields: { param1: 1 } }
  });
  clearInterval(keepAlive);
  assert.strictEqual(collected[0][0].topic, 'swarm/ack');
  const out = collected[0][0].payload;
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
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'await', timeoutMs: 1000, maxRetries: 0, stopOnError: true },
    { 1: 0, 2: 2, 3: 0 }
  );
  const keepAlive = setInterval(() => {}, 10);
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2, 3] } });
  clearInterval(keepAlive);
  const out = collected[0][0].payload;
  assert.deepStrictEqual(out.accepted, [1]);
  assert.deepStrictEqual(out.failed, [2]);
  assert.deepStrictEqual(out.skipped, [3]);
  assert.strictEqual(out.results['3'].error, 'SKIPPED');
});

test('broadcast with await-acks is rejected (BROADCAST_NO_ACK) (#46)', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_NAV_LAND', mode: 'broadcast', delivery: 'await' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'BROADCAST_NO_ACK');
});

test('await-acks defaults to sequential (concurrency 1): one workflow in flight (#155)', async () => {
  const { RED, node, conn } = setupProbe(
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'await', timeoutMs: 2000, maxRetries: 0 },
    15
  );
  const keepAlive = setInterval(() => {}, 10);
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2, 3, 4] } });
  clearInterval(keepAlive);
  assert.strictEqual(collected[0][0].topic, 'swarm/ack');
  assert.strictEqual(conn.maxInFlight, 1, 'the default runs strictly one target at a time');
  assert.deepStrictEqual(collected[0][0].payload.accepted.slice().sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('concurrency runs up to N await-ack workflows in parallel (#155)', async () => {
  const { RED, node, conn } = setupProbe(
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'await', timeoutMs: 2000, maxRetries: 0, concurrency: 3 },
    20
  );
  const keepAlive = setInterval(() => {}, 10);
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2, 3, 4, 5] } });
  clearInterval(keepAlive);
  const out = collected[0][0].payload;
  /** 5 targets, 3 slots: at least one moment has all 3 slots busy at once. */
  assert.strictEqual(conn.maxInFlight, 3, 'up to three targets are commanded in parallel');
  /** Every target is still acked and aggregated, regardless of completion order. */
  assert.deepStrictEqual(out.accepted.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.strictEqual(out.failed.length, 0);
  assert.strictEqual(out.timedOut.length, 0);
});

test('a concurrency below the target count is clamped, above it is capped by targets (#155)', async () => {
  /** concurrency 0/negative clamps to 1 (sequential). */
  const seq = setupProbe(
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'await', timeoutMs: 2000, maxRetries: 0, concurrency: 0 },
    15
  );
  let keepAlive = setInterval(() => {}, 10);
  await seq.RED.inject(seq.node, { payload: { sysids: [1, 2, 3] } });
  clearInterval(keepAlive);
  assert.strictEqual(seq.conn.maxInFlight, 1, 'concurrency 0 clamps to 1');

  /** A concurrency larger than the target list never exceeds the target count. */
  const wide = setupProbe(
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'await', timeoutMs: 2000, maxRetries: 0, concurrency: 10 },
    20
  );
  keepAlive = setInterval(() => {}, 10);
  await wide.RED.inject(wide.node, { payload: { sysids: [1, 2] } });
  clearInterval(keepAlive);
  assert.strictEqual(wide.conn.maxInFlight, 2, 'only two targets exist, so at most two run at once');
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
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'NO_TARGETS');
});

test('await-acks workflow sends carry the node profile id (#81)', async () => {
  const { RED, node, conn } = setup(
    { command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'await', timeoutMs: 1000, maxRetries: 0 },
    { 1: 0, 2: 0 }
  );
  await RED.inject(node, { payload: { sysids: [1, 2] } });
  assert.strictEqual(conn.sent.length, 2);
  for (const m of conn.sent) {
    assert.strictEqual(m.vehicleProfile, 'p1');
  }
});

test('alt-only fan-out targets send "use current position" sentinels, never 0,0', () => {
  /**
   * COMMAND_INT: INT32_MAX in x/y means "don't change"; COMMAND_LONG uses NaN
   * in param5/6. 0 is a real coordinate — a fleet-wide "change altitude only"
   * must not reposition every vehicle to null island.
   */
  const [intMsg] = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: true,
    targets: [{ sysid: 1, alt: 50 }],
    base: {},
    defaults: {}
  });
  assert.strictEqual(intMsg.fields.x, 0x7fffffff);
  assert.strictEqual(intMsg.fields.y, 0x7fffffff);
  assert.strictEqual(intMsg.fields.z, 50);

  const [longMsg] = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: false,
    targets: [{ sysid: 1, alt: 50 }],
    base: {},
    defaults: {}
  });
  assert.ok(Number.isNaN(longMsg.fields.param5), 'param5 is the NaN sentinel');
  assert.ok(Number.isNaN(longMsg.fields.param6), 'param6 is the NaN sentinel');
  assert.strictEqual(longMsg.fields.param7, 50);
});

test('duplicate fan-out target sysids are rejected (ACK aggregation keys by sysid)', () => {
  assert.throws(
    () =>
      buildFanout({
        command: 'MAV_CMD_COMPONENT_ARM_DISARM',
        targets: [{ sysid: 1 }, { sysid: 2 }, { sysid: 1 }],
        base: {},
        defaults: {}
      }),
    (e) => e.code === 'BAD_TARGET' && /Duplicate/.test(e.message)
  );
});

test('explicit zero param5/6 (equator/prime meridian) survive the alt-only sentinels', () => {
  const [longMsg] = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: false,
    targets: [{ sysid: 1, alt: 50 }],
    base: { param5: 0, param6: 0 },
    defaults: {}
  });
  assert.strictEqual(longMsg.fields.param5, 0);
  assert.strictEqual(longMsg.fields.param6, 0);

  const [intMsg] = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: true,
    targets: [{ sysid: 1, alt: 50 }],
    base: { param5: 0, param6: 0 },
    defaults: {}
  });
  assert.strictEqual(intMsg.fields.x, 0);
  assert.strictEqual(intMsg.fields.y, 0);
});

test('build-only fan-out stamps CRITICAL only on safety commands (#241)', async () => {
  /** An arm/disarm fan-out to the Out node must ride the same critical band as
   * the await-ack path; every clone carries the stamp. */
  const arm = setup({ command: 'MAV_CMD_COMPONENT_ARM_DISARM' });
  const armed = await arm.RED.inject(arm.node, { payload: { sysids: [1, 2] } });
  const armBatch = armed.collected[0][0];
  assert.strictEqual(armBatch[0].priority, 0);
  assert.strictEqual(armBatch[1].priority, 0);

  /** A non-critical command carries no stamp — flows keep control of the field. */
  const rtl = setup({ command: 'MAV_CMD_NAV_RETURN_TO_LAUNCH' });
  const sent = await rtl.RED.inject(rtl.node, { payload: { sysids: [1] } });
  assert.strictEqual(sent.collected[0][0][0].priority, undefined);
});

// ---------------------------------------------------------------------------
// Delivery: Build / Send / Await + dry-run (#207)
// ---------------------------------------------------------------------------

test('fanout Build only emits per-target mavlink/send on port 0', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'build' });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2] } });
  const batch = collected[0][0];
  assert.ok(Array.isArray(batch) && batch.length === 2, 'multiple messages batched on port 0');
  assert.ok(batch.every((m) => m.topic === 'mavlink/send'));
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('fanout Send via connection sends all and emits swarm/sent aggregate on port 0', async () => {
  const { RED, node, conn } = setup({ command: 'MAV_CMD_COMPONENT_ARM_DISARM', delivery: 'send' });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2] } });
  assert.strictEqual(conn.sent.length, 2, 'both targets sent directly on the connection');
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'swarm/sent');
  assert.deepStrictEqual(out.payload.sent.slice().sort((a, b) => a - b), [1, 2]);
  assert.strictEqual(out.payload.failed.length, 0);
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('fanout Send via connection without a connection is a structured NO_CONNECTION error', async () => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  const node = RED.create('mavlink-ai-fanout', {
    id: 'f1',
    profile: 'p1',
    delivery: 'send',
    command: 'MAV_CMD_NAV_LAND'
  });
  const { collected } = await RED.inject(node, { payload: { sysids: [1] } });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'NO_CONNECTION');
});

test('fanout with no delivery set fails closed with DELIVERY_UNSET on port 1', async () => {
  const { RED, node } = setup({ command: 'MAV_CMD_NAV_LAND', delivery: undefined });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2] } });
  const err = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(err.payload.code, 'DELIVERY_UNSET');
  assert.ok(!collected.map((o) => o[0]).find(Boolean), 'nothing on port 0');
});

test('fanout dry-run emits swarm/dryrun and sends nothing regardless of delivery mode', async () => {
  const { RED, node, conn } = setup({ command: 'MAV_CMD_NAV_LAND', delivery: 'send', dryRun: true });
  const { collected } = await RED.inject(node, { payload: { sysids: [1, 2] } });
  assert.strictEqual(conn.sent.length, 0, 'dry-run short-circuits before anything is sent');
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'swarm/dryrun');
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});
