'use strict';

const test = require('node:test');
const assert = require('node:assert');
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
    Object.assign({ id: 'm1', profile: 'p1', connection: withConnection ? 'conn1' : '' }, moveConfig)
  );
  return { RED, node, conn };
}

test('local position build-only emits mavlink/send with negated z', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', altitude: '10', north: '5' });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0].payload;
  assert.strictEqual(collected[0].topic, 'mavlink/send');
  assert.strictEqual(out.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.strictEqual(out.fields.x, 5);
  assert.strictEqual(out.fields.z, -10);
  assert.strictEqual(out.fields.type_mask, 3576);
  assert.strictEqual(out.vehicleProfile, 'p1');
  assert.strictEqual(out.target_system, 1);
});

test('acceleration preset passes the af vector through the node (#128)', async () => {
  const { RED, node } = setup({
    coordinate: 'local',
    preset: 'acceleration',
    frame: 'MAV_FRAME_LOCAL_NED',
    accelNorth: '1.5',
    accelUp: '2'
  });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.afx, 1.5);
  assert.strictEqual(out.fields.afz, -2);
});

test('force preset via msg.payload sets the force bit (#128)', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', frame: 'MAV_FRAME_LOCAL_NED' });
  const { collected } = await RED.inject(node, { payload: { preset: 'force', accelNorth: 3 } });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.afx, 3);
  assert.strictEqual(out.fields.type_mask & 0b0000_0010_0000_0000, 0b0000_0010_0000_0000);
});

test('global coordinate builds SET_POSITION_TARGET_GLOBAL_INT with degE7', async () => {
  const { RED, node } = setup({
    coordinate: 'global',
    preset: 'position',
    frame: 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT',
    lat: '47.397742',
    lon: '8.545594',
    altitude: '5'
  });
  const { collected } = await RED.inject(node, { payload: {} });
  const out = collected[0].payload;
  assert.strictEqual(out.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.strictEqual(out.fields.lat_int, 473977420);
  assert.strictEqual(out.fields.alt, 5);
});

test('with a connection the node sends directly and emits nothing', async () => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', climb: '0.5' },
    { withConnection: true }
  );
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected.length, 0);
  assert.strictEqual(conn.sent.length, 1);
  assert.strictEqual(conn.sent[0].name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.strictEqual(conn.sent[0].vehicleProfile, 'p1');
  assert.strictEqual(conn.sent[0].fields.vx, 1);
  assert.strictEqual(conn.sent[0].fields.vz, -0.5);
});

test('a one-shot send that fails after a connection redeploy still emits the structured error (#128)', async () => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1' },
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
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'SEND_FAILED');
  assert.strictEqual(collected[0].payload.connection, 'Conn', 'names the connection it sent on');
});

test('msg.payload overrides editor values', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'position', altitude: '1' });
  const { collected } = await RED.inject(node, { payload: { altitude: 20, north: 3 } });
  const out = collected[0].payload;
  assert.strictEqual(out.fields.z, -20);
  assert.strictEqual(out.fields.x, 3);
});

test('custom preset uses the raw type_mask from the payload', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'custom' });
  const { collected } = await RED.inject(node, { payload: { type_mask: 0 } });
  assert.strictEqual(collected[0].payload.fields.type_mask, 0);
});

test('a bad custom type_mask emits a structured error', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'custom', typeMask: '70000' });
  const { collected } = await RED.inject(node, { payload: {} });
  const err = collected[0].payload;
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(err.code, 'BAD_TYPE_MASK');
});

test('streaming resends the setpoint at the configured rate until stopped (#128)', async (t) => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
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
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
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
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
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
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
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
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
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
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
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
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
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
   * settle is stale and must not emit a mavlink/error from the node. */
  rejectSend(new Error('link down'));
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(node.sent.filter((m) => m && m.topic === 'mavlink/error').length, 0, 'no stale error emitted');
});

test('streaming without a connection is a structured error (#128)', async () => {
  const { RED, node } = setup({ coordinate: 'local', preset: 'velocity', stream: true });
  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'STREAM_NEEDS_CONNECTION');
  assert.strictEqual(node._streamTimer, null, 'no stream started');
});

test('closing the node stops the stream (stop-on-deploy guard) (#128)', async () => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'velocity', velNorth: '1', stream: true, streamRateHz: 50 },
    { withConnection: true }
  );
  await RED.inject(node, { payload: {} });
  assert.ok(node._streamTimer, 'streaming before close');
  await RED.close(node);
  assert.strictEqual(node._streamTimer, null, 'close cleared the stream timer');
});

test('msg.payload.stream=true streams even from a one-shot node and each input refreshes it (#128)', async (t) => {
  const { RED, node } = setup(
    { coordinate: 'local', preset: 'position', altitude: '5', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  await RED.inject(node, { payload: { stream: true } });
  assert.ok(node._streamTimer, 'stream started from payload');
  assert.strictEqual(node._streamState.fields.z, -5);
  await RED.inject(node, { payload: { stream: true, altitude: 12 } });
  assert.strictEqual(node._streamState.fields.z, -12, 'streamed setpoint refreshed');
  assert.ok(node._streamTimer, 'still a single running stream');
});

test('refreshing a running stream does not force an extra immediate send — the rate is honored (#128)', async (t) => {
  /** Slow rate so the repeat timer cannot fire during the test; only the initial
   * start should send immediately. Later refreshes must update the streamed
   * setpoint for the next scheduled tick, not fire an out-of-band send. */
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'position', altitude: '5', stream: true, streamRateHz: 0.2 },
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

test('a plain input keeps a payload-started stream alive and refreshes it (not one-shot) (#128)', async (t) => {
  const { RED, node, conn } = setup(
    { coordinate: 'local', preset: 'position', altitude: '5', streamRateHz: 50 },
    { withConnection: true }
  );
  t.after(() => RED.close(node));
  await RED.inject(node, { payload: { stream: true } });
  assert.ok(node._streamTimer, 'stream started from payload');

  /** A later message with no `stream` flag must refresh the running stream, not
   * fall through to a one-shot send that leaves the timer orphaned with stale state. */
  const { collected } = await RED.inject(node, { payload: { altitude: 9 } });
  assert.strictEqual(collected.length, 0, 'no one-shot emit');
  assert.ok(node._streamTimer, 'stream still running');
  assert.strictEqual(node._streamState.fields.z, -9, 'stream refreshed to the new setpoint');
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
    id: 'm1', profile: 'p1', connection: '', coordinate: 'local', preset: 'force', frame: 'MAV_FRAME_LOCAL_NED', accelNorth: '1'
  });

  const { collected } = await RED.inject(node, { payload: {} });
  assert.strictEqual(collected[0].topic, 'mavlink/send', 'setpoint still sent');
  assert.strictEqual(node.warnings.length, 1, 'one advisory warning');
  assert.match(node.warnings[0], /FORCE/);

  /** Same warning set again: deduplicated, no spam. */
  await RED.inject(node, { payload: {} });
  assert.strictEqual(node.warnings.length, 1, 'repeat input does not re-warn');

  /** A clean setpoint clears the dedup key so a later bad one warns again. */
  await RED.inject(node, { payload: { preset: 'velocity', velNorth: 1 } });
  await RED.inject(node, { payload: {} });
  assert.strictEqual(node.warnings.length, 2, 'warning returns after the set changes');
});

test('missing profile emits MISSING_PROFILE', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-move', { id: 'm2', preset: 'position' });
  const { collected } = await RED.inject(node, { payload: {} });
  const err = collected[0].payload;
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(err.code, 'MISSING_PROFILE');
});

/**
 * Node-RED leaves this node in place when only the referenced profile config
 * node changed, so its constructor never re-runs. Before the fix, a profile
 * fixed after deploy left a stale "invalid profile" badge (and node.profile
 * pointing at the destroyed old profile). watchProfileBadge re-resolves and
 * refreshes on flows:started.
 */
test('move node clears a stale "invalid profile" badge when the profile is fixed on redeploy', () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-move', { id: 'm1', profile: 'p1', connection: '' });
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
