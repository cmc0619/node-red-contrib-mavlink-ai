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
  assert.strictEqual(out.profile, 'p1');
  assert.strictEqual(out.target_system, 1);
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
  assert.strictEqual(conn.sent[0].profile, 'p1');
  assert.strictEqual(conn.sent[0].fields.vx, 1);
  assert.strictEqual(conn.sent[0].fields.vz, -0.5);
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

test('missing profile emits MISSING_PROFILE', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-move', { id: 'm2', preset: 'position' });
  const { collected } = await RED.inject(node, { payload: {} });
  const err = collected[0].payload;
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(err.code, 'MISSING_PROFILE');
});
