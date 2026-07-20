'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { common } = require('node-mavlink');
const { MockRED } = require('../helpers/mock-red');

/** A stub connection exposing just the send() the move node uses. */
function fakeConnection() {
  const conn = { id: 'conn1', name: 'Conn', sent: [] };
  conn.send = (m) => {
    conn.sent.push(m);
    return Promise.resolve();
  };
  return conn;
}

function setup(moveConfig, { withConnection = false } = {}) {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    mavlinkVersion: 'v2',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });
  let conn = null;
  if (withConnection) {
    conn = fakeConnection();
    RED._nodes.set('conn1', conn);
  }
  const node = RED.create(
    'mavlink-ai-move',
    Object.assign({ id: 'm1', profile: 'p1', delivery: 'build', connection: withConnection ? 'conn1' : '' }, moveConfig)
  );
  return { RED, node, conn };
}

test('local position build-only emits mavlink/send with negated z', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', altitude: '10', north: '5', east: '0' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(out.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.strictEqual(out.fields.x, 5);
  assert.strictEqual(out.fields.z, -10);
  const expectedMask =
    common.PositionTargetTypemask.VX_IGNORE |
    common.PositionTargetTypemask.VY_IGNORE |
    common.PositionTargetTypemask.VZ_IGNORE |
    common.PositionTargetTypemask.AX_IGNORE |
    common.PositionTargetTypemask.AY_IGNORE |
    common.PositionTargetTypemask.AZ_IGNORE |
    common.PositionTargetTypemask.YAW_IGNORE |
    common.PositionTargetTypemask.YAW_RATE_IGNORE;
  assert.strictEqual(out.fields.type_mask, expectedMask);
  assert.strictEqual(out.vehicleProfile, 'p1');
  assert.strictEqual(out.target_system, 1);
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('acceleration preset passes the af vector through the node (#128)', async () => {
  const { RED, node } = setup({
    coordinate: 'local',
    preset: 'acceleration',
    frame: 'LOCAL_NED',
    accelNorth: '1.5',
    accelEast: '0',
    accelUp: '2'
  });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.afx, 1.5);
  assert.strictEqual(out.fields.afz, -2);
});

test('force preset via msg.payload sets the force bit (#128)', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', frame: 'LOCAL_NED' });
  const { collected } = await RED.inject(node, { payload: { preset: 'force', accelNorth: 3, accelEast: 0, accelUp: 0 } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.afx, 3);
  assert.strictEqual(
    out.fields.type_mask & common.PositionTargetTypemask.FORCE_SET,
    common.PositionTargetTypemask.FORCE_SET
  );
});

test('global coordinate builds SET_POSITION_TARGET_GLOBAL_INT with degE7', async () => {
  const { RED, node } = setup({
    coordinate: 'global',
    preset: 'position',
    frame: 'GLOBAL_RELATIVE_ALT_INT',
    lat: '47.397742',
    lon: '8.545594',
    altitude: '5'
  });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0][0].payload;
  assert.strictEqual(out.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.strictEqual(out.fields.lat_int, 473977420);
  assert.strictEqual(out.fields.alt, 5);
});

test('Send via connection sends directly and emits move/sent on port 0 (observable, #207)', async () => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0.5', delivery: 'send' },
    { withConnection: true }
  );
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(conn.sent.length, 1, 'sent directly on the connection');
  assert.strictEqual(conn.sent[0].name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.strictEqual(conn.sent[0].vehicleProfile, 'p1');
  assert.strictEqual(conn.sent[0].fields.vx, 1);
  assert.strictEqual(conn.sent[0].fields.vz, -0.5);
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'move/sent', 'the one-shot send is now observable on port 0');
  assert.strictEqual(out.payload.sent, true);
  assert.strictEqual(out.payload.target_system, 1);
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('a one-shot send that fails after a connection redeploy still emits the structured error (#128)', async () => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'send' },
    { withConnection: true }
  );

  /** A send whose rejection we control lands after the redeploy nulls the ref. */
  let rejectSend;
  conn.send = () => new Promise((_resolve, reject) => { rejectSend = reject; });

  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));

  /** The flows:started guard can null/replace node.connection mid-await; the
   * catch must use the captured connection, not throw and leave done() uncalled. */
  node.connection = null;
  rejectSend(new Error('link down'));

  const { collected } = await injected;
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'SEND_FAILED');
  assert.strictEqual(collected[0][1].payload.connection, 'Conn', 'names the connection it sent on');
});

test('Send via connection without a connection is a structured NO_CONNECTION error (#207)', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'send' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'NO_CONNECTION');
});

test('msg.payload overrides editor values', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', altitude: '1', east: '0' });
  const { collected } = await RED.inject(node, { payload: { altitude: 20, north: 3 } });
  const out = collected[0][0].payload;
  assert.strictEqual(out.fields.z, -20);
  assert.strictEqual(out.fields.x, 3);
});

test('custom preset uses the raw type_mask from the payload', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'custom' });
  /** type_mask 0 clears every ignore bit, so all axes are active and must be
   * supplied — a fully-zero setpoint is a real command, not a blank one (#235). */
  const { collected } = await RED.inject(node, {
    payload: {
      type_mask: 0,
      north: 0, east: 0, altitude: 0,
      velNorth: 0, velEast: 0, climb: 0,
      accelNorth: 0, accelEast: 0, accelUp: 0,
      yaw: 0, yawRate: 0
    }
  });
  assert.strictEqual(collected[0][0].payload.fields.type_mask, 0);
});

test('a whitespace-only active field is rejected, not sent as 0 (#248 review)', async () => {
  /**
   * The node coerces fields through toNum(..., undefined) before buildSetpoint.
   * A whitespace-only value used to become a real 0 (Number(' ') === 0) and slip
   * past the guard; toNum now treats it as blank, so the active-field guard fires.
   */
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', north: '5', east: '   ', altitude: '10' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'BAD_SETPOINT_FIELD');
  assert.ok(collected[0][1].payload.context.fields.includes('east'), 'names the blank axis');
});

test('a bad custom type_mask emits a structured error', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'custom', typeMask: '70000' });
  const { collected } = await RED.inject(node, { payload: {} });
  const err = collected[0][1].payload;
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(err.code, 'BAD_TYPE_MASK');
});

test('streaming resends the setpoint at the configured rate until stopped (#128)', async (t) => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));

  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected.length, 0, 'streaming does not emit on the output');
  assert.strictEqual(conn.sent.length, 1, 'sends immediately');
  assert.ok(node._streamTimer, 'a repeat timer is running');

  /** The stream timer is unref'd; this ref'd wait keeps the loop alive so it fires. */
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(conn.sent.length >= 2, `resends on the timer (got ${conn.sent.length})`);
});

test('msg.payload.stream=false stops a running stream (#128)', async (t) => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  await RED.inject(node, { payload: {} });
  assert.ok(node._streamTimer, 'streaming');
  await RED.inject(node, { payload: { stream: false } });
  assert.strictEqual(node._streamTimer, null, 'stream stopped');
});

test('msg.payload.stream="false" (string) also stops a running stream (#128)', async (t) => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  await RED.inject(node, { payload: {} });
  assert.ok(node._streamTimer, 'streaming');
  /** A Change/HTTP/MQTT path can hand us the string 'false'; it must still stop. */
  await RED.inject(node, { payload: { stream: 'false' } });
  assert.strictEqual(node._streamTimer, null, 'string "false" stopped the stream');
});

test('a slow send is not piled up — ticks are skipped while one is in flight (#128)', async (t) => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));

  /** A send that never resolves models a backpressured/blocked transport. */
  let sends = 0;
  conn.send = () => {
    sends += 1;
    return new Promise(() => {});
  };

  await RED.inject(node, { payload: {} });
  assert.strictEqual(sends, 1, 'the initial start sends once');

  /** Several timer periods pass; with the first send still pending, no tick
   * should launch another overlapping send. */
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sends, 1, 'no overlapping sends while one is in flight');
});

test('an unrelated deploy (flows:started, no dependency change) keeps a running stream alive (#128)', async (t) => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  await RED.inject(node, { payload: {} });
  assert.ok(node._streamTimer, 'streaming');

  /** Deploying an unrelated tab/node fires flows:started but changes neither this
   * node's Profile nor its Connection — the stream must survive, or the vehicle
   * would drop out of OFFBOARD on every unrelated deploy. */
  RED.events.emit('flows:started');
  assert.ok(node._streamTimer, 'unrelated deploy did not stop the stream');
});

test('redeploying the referenced profile (flows:started, new config node) tears down the stream (#128)', async (t) => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  await RED.inject(node, { payload: {} });
  assert.ok(node._streamTimer, 'streaming before redeploy');

  /** Re-creating the profile with the same id replaces it with a new object —
   * i.e. this node's referenced config was redeployed. `close` never fires, but
   * the stream must not keep flying with the stale state. */
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');
  assert.strictEqual(node._streamTimer, null, 'dependency change stopped the stream');
  assert.strictEqual(node._streamState, null, 'streamed setpoint cleared');
});

test('a stream send that rejects after the stream is stopped emits no stale error (#128)', async (t) => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));

  /** A send whose rejection we control lands *after* the stop below. */
  let rejectSend;
  conn.send = () => new Promise((_resolve, reject) => { rejectSend = reject; });

  await RED.inject(node, { payload: {} });
  assert.ok(node._streamTimer, 'streaming');

  await RED.inject(node, { payload: { stream: false } });
  assert.strictEqual(node._streamTimer, null, 'stream stopped');

  /** The in-flight send now fails — but the stream is already stopped, so its
   * settle is stale and must not emit a mavlink/error from the node. Stream
   * errors land as [null, errMsg] on the two-port [out, error] contract. */
  rejectSend(new Error('link down'));
  await new Promise((r) => setTimeout(r, 0));
  const staleErrors = node.sent.filter((m) => Array.isArray(m) && m[1] && m[1].topic === 'mavlink/error');
  assert.strictEqual(staleErrors.length, 0, 'no stale error emitted');
});

test('streaming without a connection is a structured error (#128)', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'velocity', velNorth: '0', velEast: '0', climb: '0', delivery: 'stream' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'STREAM_NEEDS_CONNECTION');
  assert.strictEqual(node._streamTimer, null, 'no stream started');
});

test('closing the node stops the stream (stop-on-deploy guard) (#128)', async () => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  await RED.inject(node, { payload: {} });
  assert.ok(node._streamTimer, 'streaming before close');
  await RED.close(node);
  assert.strictEqual(node._streamTimer, null, 'close cleared the stream timer');
});

test('a stream-delivery node starts and refreshes on every input, with or without a payload.stream flag (#207)', async (t) => {
  /**
   * Streaming is no longer a per-message override (#207): it is the node's
   * Delivery mode. Every input while Delivery is "Stream via connection"
   * arms/refreshes the stream — not a one-shot send — regardless of whether
   * the message carries a `stream` flag at all.
   */
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'position', north: '0', east: '0', altitude: '5', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));

  const first = await RED.inject(node, { payload: {} });
  assert.strictEqual(first.collected.length, 0, 'stream start emits nothing on the input itself');
  assert.ok(node._streamTimer, 'stream started');
  assert.strictEqual(node._streamState.fields.z, -5);

  const second = await RED.inject(node, { payload: { altitude: 12 } });
  assert.strictEqual(second.collected.length, 0, 'a plain refresh emits nothing on the input itself');
  assert.strictEqual(node._streamState.fields.z, -12, 'streamed setpoint refreshed, not treated as one-shot');
  assert.ok(node._streamTimer, 'still a single running stream');
});

test('refreshing a running stream does not force an extra immediate send — the rate is honored (#128)', async (t) => {
  /** Slow rate so the repeat timer cannot fire during the test; only the initial
   * start should send immediately. Later refreshes must update the streamed
   * setpoint for the next scheduled tick, not fire an out-of-band send. */
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'position', north: '0', east: '0', altitude: '5', delivery: 'stream', streamRateHz: 0.2 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));

  await RED.inject(node, { payload: {} });
  assert.strictEqual(conn.sent.length, 1, 'initial start sends immediately');

  await RED.inject(node, { payload: { altitude: 12 } });
  await RED.inject(node, { payload: { altitude: 18 } });
  assert.strictEqual(conn.sent.length, 1, 'refreshes do not send out-of-band — the rate is honored');
  assert.strictEqual(node._streamState.fields.z, -18, 'streamed setpoint refreshed for the next tick');
});

test('a firmware-unsupported setpoint raises an advisory warning but still sends (#128)', async () => {
  /** The ardupilotmega test profile reports no firmware field by default, so
   * pass it explicitly: ArduPilot + force preset must warn. */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega', firmware: 'ardupilot', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const node = RED.create('mavlink-ai-move', {
    id: 'm1', profile: 'p1', delivery: 'build', connection: '', coordinate: 'local', preset: 'force', frame: 'LOCAL_NED',
    accelNorth: '1', accelEast: '0', accelUp: '0'
  });

  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].topic, 'mavlink/send', 'setpoint still sent');
  assert.strictEqual(node.warnings.length, 1, 'one advisory warning');
  assert.match(node.warnings[0], /FORCE/);

  /** Same warning set again: deduplicated, no spam. */
  await RED.inject(node, { payload: {} });
  assert.strictEqual(node.warnings.length, 1, 'repeat input does not re-warn');

  /** A clean setpoint clears the dedup key so a later bad one warns again. */
  await RED.inject(node, { payload: { preset: 'velocity', velNorth: 1, velEast: 0, climb: 0 } });
  await RED.inject(node, { payload: {} });
  assert.strictEqual(node.warnings.length, 2, 'warning returns after the set changes');
});

test('missing profile emits MISSING_PROFILE', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-move', { id: 'm2', delivery: 'build', preset: 'position' });
  const { collected } = await RED.inject(node, { payload: {} });
  const err = collected[0][1].payload;
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(err.code, 'MISSING_PROFILE');
});

test('with no delivery set the node fails closed with DELIVERY_UNSET on port 1 (#207)', async () => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const node = RED.create('mavlink-ai-move', { id: 'm3', profile: 'p1', coordinate: 'local', preset: 'position', north: 1, east: 0, altitude: 1 }); // no delivery
  const { collected } = await RED.inject(node, { payload: { x: 1 } });
  const err = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(err.payload.code, 'DELIVERY_UNSET');
});

/**
 * Both Codex and Greptile flagged the same gap (#308): before this, a node
 * saved without a `delivery` value only failed at the first input, so it
 * looked healthy right after deploy. resolveDeliveryMode is now also called
 * at construct time, so the red badge appears immediately.
 */
test('move node badges a construct-time DELIVERY_UNSET before any input (#308)', () => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const node = RED.create('mavlink-ai-move', { id: 'm4', profile: 'p1', coordinate: 'local', preset: 'position' }); // no delivery
  assert.ok(node._configError, 'node._configError set at construct time');
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });
});

/**
 * #308 review finding G1: the construct-time DELIVERY_UNSET badge above must
 * survive a `flows:started` refresh (e.g. an unrelated config-node redeploy)
 * instead of watchConfigBadge's own refresh silently clearing it to idle.
 */
test('move node keeps the DELIVERY_UNSET badge across a flows:started refresh (#308 G1)', () => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const node = RED.create('mavlink-ai-move', { id: 'm5', profile: 'p1', coordinate: 'local', preset: 'position' }); // no delivery
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });

  RED.events.emit('flows:started');

  assert.ok(node._configError, 'node._configError remains set after refresh');
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid config' });
});

/**
 * #308 review finding G2: the Send (fire-and-forget) path awaits
 * connection.send() and, before this fix, emitted move/sent unconditionally
 * once it resolved — even if the node closed mid-flight.
 */
test('move Send via connection emits nothing if the node closes before the in-flight send resolves (#308 G2)', async () => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0.5', delivery: 'send' },
    { withConnection: true }
  );
  let resolveSend;
  conn.send = () => new Promise((resolve) => {
    resolveSend = resolve;
  });
  const injected = RED.inject(node, { payload: {} });
  await new Promise((r) => setTimeout(r, 0));
  const closed = RED.close(node);
  resolveSend();
  const [{ collected }] = await Promise.all([injected, closed]);
  const sentOutput = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(sentOutput, undefined, 'no move/sent output from a closed node');
});

/**
 * Node-RED leaves this node in place when only the referenced profile config
 * node changed, so its constructor never re-runs. Before the fix, a profile
 * fixed after deploy left a stale "invalid profile" badge (and node.profile
 * pointing at the destroyed old profile). watchConfigBadge re-resolves and
 * refreshes on flows:started. `delivery: 'build'` keeps this test isolated to
 * the profile badge — an unset Delivery would otherwise (correctly, #308 G1)
 * surface its own "invalid config" badge once the profile resolves.
 */
test('move node clears a stale "invalid profile" badge when the profile is fixed on redeploy', () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-move', { id: 'm1', profile: 'p1', connection: '', delivery: 'build' });
  assert.deepStrictEqual(node.statusHistory.at(-1), { fill: 'red', shape: 'ring', text: 'invalid profile' });
  assert.ok(!node.profile);

  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');
  assert.deepStrictEqual(node.statusHistory.at(-1), {});
  assert.ok(node.profile && node.profile.isValid());
});

test('build-only output carries the ELEVATED priority stamp (#241)', async () => {
  /** Move -> mavlink-ai-out must ride the same band as a direct send: the Out
   * node forwards msg.priority to the outbound queue. */
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', north: '1', east: '0', altitude: '5' });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].priority, 1, 'setpoints are ELEVATED on the build-only path too');
});

test('a streamed setpoint expires after maxStreamSeconds (#216)', async (t) => {
  /**
   * A bare setInterval used to retransmit the last setpoint forever — an
   * abandoned flow kept commanding the vehicle indefinitely. The stream now
   * carries a TTL: on expiry the timer stops, the status shows the expiry,
   * and one { stream: 'expired' } message is emitted on port 0.
   */
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50, maxStreamSeconds: 0.05 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  const emitted = [];
  const injected = await RED.inject(node, { payload: {} });
  node.send = (m) => emitted.push(m);
  assert.ok(node._streamTimer, 'streaming');

  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(node._streamTimer, null, 'the stream stopped at the TTL');
  const sentCount = conn.sent.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(conn.sent.length, sentCount, 'no setpoints after expiry');
  assert.strictEqual(emitted.length, 1, 'exactly one expiry message');
  assert.strictEqual(emitted[0][0].payload.stream, 'expired');
  assert.strictEqual(emitted[0][1], null, 'nothing on the error port');
  assert.strictEqual(injected.collected.length, 0, 'the input itself emitted nothing');
});

test('maxStreamSeconds 0 opts out of the stream TTL (#216)', async (t) => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50, maxStreamSeconds: 0 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  await RED.inject(node, { payload: {} });
  assert.strictEqual(node._streamDeadline, null, 'no deadline armed');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(node._streamTimer, 'the stream keeps running');
});

test('the stream TTL defaults to 300 seconds and refreshes on every input (#216)', async (t) => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  assert.strictEqual(node.maxStreamSeconds, 300, 'default TTL');

  /** Deadman semantics: the TTL counts from the LAST input, not the first. */
  await RED.inject(node, { payload: {} });
  const first = node._streamDeadline;
  assert.ok(first > Date.now(), 'deadline armed');
  await new Promise((r) => setTimeout(r, 20));
  await RED.inject(node, { payload: {} });
  assert.ok(node._streamDeadline > first, 'a fresh input pushes the deadline out');
});

test('a blank Max stream field keeps the default TTL, only explicit 0 opts out (#216 review)', async () => {
  /**
   * Number('') coerces to 0, which would silently disable the deadman for a
   * cleared/imported-blank editor field. Blank falls to the 300 s default via
   * blank-aware parsing; only an explicit 0 means unlimited.
   */
  const blank = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', maxStreamSeconds: '' },
    { withConnection: true }
  );
  assert.strictEqual(blank.node.maxStreamSeconds, 300, 'blank field falls to the default');
  const zero = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', maxStreamSeconds: '0' },
    { withConnection: true }
  );
  assert.strictEqual(zero.node.maxStreamSeconds, 0, 'explicit 0 stays the unlimited opt-out');
});

test('stream expiry fires on time even when the TTL is shorter than a tick interval (#216 review)', async (t) => {
  /**
   * Expiry used to be checked only inside streamTick, so at the minimum
   * 0.2 Hz rate a short TTL waited up to 5 s for the next tick. The
   * deadline now arms its own timeout, independent of the send interval.
   */
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', streamRateHz: 0.2, maxStreamSeconds: 0.05 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  const emitted = [];
  await RED.inject(node, { payload: {} });
  node.send = (m) => emitted.push(m);
  assert.ok(node._streamTimer, 'streaming');

  /** Well before the 5 s tick interval, the 50 ms TTL must have fired. */
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(node._streamTimer, null, 'expired without waiting for a tick');
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0][0].payload.stream, 'expired');
});

test('a stream TTL beyond the 32-bit timer limit is capped, not instantly expired (#216 review)', () => {
  /**
   * setTimeout clamps delays above 2^31-1 ms to 1 ms, so a 30-day deadman
   * would fire immediately after the stream starts. The TTL is capped at
   * config time to the timer limit (~24.8 days).
   */
  const { node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', velEast: '0', climb: '0', delivery: 'stream', maxStreamSeconds: 999999999999 },
    { withConnection: true }
  );
  assert.strictEqual(node.maxStreamSeconds, 2147483, 'capped at the setTimeout limit in seconds');
});
