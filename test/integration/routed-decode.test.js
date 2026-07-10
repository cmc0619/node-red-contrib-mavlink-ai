'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const path = require('path');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

const CUSTOM_XML = path.join(__dirname, '..', 'fixtures', 'dialects', 'custom_vehicle.xml');

/**
 * Wait for an event while re-sending a datagram: UDP loopback can drop a lone
 * datagram under CPU contention, so resend on an interval (like a real MAVLink
 * request) until the expected event arrives.
 */
const until = (attach, sendOnce, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(retry);
      reject(new Error(`timeout: ${label}`));
    }, 5000);
    const done = (v) => {
      clearTimeout(timer);
      clearInterval(retry);
      resolve(v);
    };
    attach(done);
    sendOnce();
    const retry = setInterval(sendOnce, 200);
  });

/**
 * Routed connections must decode each packet with the *matched profile's*
 * dialect, not the default profile's (RELEASE_SCOPE §4). This test routes
 * sysid 1 to an ardupilotmega profile while the default profile is `minimal`
 * (which only knows HEARTBEAT). ATTITUDE (id 30) therefore only decodes if the
 * routed profile's dialect is used; an unmatched system falling back to the
 * minimal default must instead raise a structured decode error.
 */
test('routed connection decodes with the matched profile dialect', async (t) => {
  const RED = new MockRED().loadNodes();

  RED.create('mavlink-ai-profile', {
    id: 'p_min', name: 'Min', profileType: 'gcs', dialect: 'minimal', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-profile', {
    id: 'p_ardu', name: 'Ardu', profileType: 'copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  // A second minimal profile, distinct from the default, to prove routed decode
  // uses the *matched route's* profile rather than the default.
  RED.create('mavlink-ai-profile', {
    id: 'p_min2', name: 'Min2', profileType: 'gcs', dialect: 'minimal', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  // A runtime-compiled custom-XML profile. Its message ids exist in no bundled
  // dialect, so this exercises the merged splitter CRC table: without it the
  // packet would be dropped silently before routing.
  RED.create('mavlink-ai-profile', {
    id: 'p_custom', name: 'Custom', profileType: 'gcs', dialect: 'custom',
    customDialectPath: CUSTOM_XML, mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });

  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_routed', name: 'Routed UDP', profile: 'p_min',
    transport: 'udp-peer', routingMode: 'routed', unmatchedPolicy: 'default',
    routeTable: JSON.stringify([
      { sysid: 1, compid: '*', profile: 'p_ardu' },
      { sysid: 2, compid: '*', profile: 'p_min2' },
      { sysid: 3, compid: '*', profile: 'p_custom' }
    ]),
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });

  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const ardu = loadDialect('ardupilotmega');
  const fromSys1 = new MavlinkCodec({ bundle: ardu, version: 'v2', sysid: 1, compid: 1 });
  const fromSys2 = new MavlinkCodec({ bundle: ardu, version: 'v2', sysid: 2, compid: 1 });
  const sock = dgram.createSocket('udp4');
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });

  // Case 1: ATTITUDE from sysid 1 routes to the ardupilotmega profile and decodes.
  const attitude = await until(
    (done) => conn.subscribe({ messageNames: ['ATTITUDE'] }, done),
    () => sock.send(fromSys1.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }), port, '127.0.0.1'),
    'ATTITUDE decode'
  );
  assert.strictEqual(attitude.payload.name, 'ATTITUDE');
  assert.strictEqual(attitude.payload.sysid, 1);
  assert.strictEqual(attitude.payload.profile, 'Ardu');
  assert.strictEqual(attitude.payload.profile_id, 'p_ardu');

  // Case 2: ATTITUDE from sysid 2 is *matched by an explicit route* to the
  // minimal profile, whose dialect cannot decode id 30. This proves the matched
  // profile's dialect is used (the ardupilotmega default WOULD have decoded it)
  // and that failure produces a structured decode error with packet metadata.
  const decodeError = await until(
    (done) => conn.emitter.on('decodeError', done),
    () => sock.send(fromSys2.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }), port, '127.0.0.1'),
    'decode error'
  );
  assert.strictEqual(decodeError.payload.code, 'DECODE_FAILED');
  assert.strictEqual(decodeError.payload.context.sysid, 2);
  assert.strictEqual(decodeError.payload.context.msgid, 30);
  assert.strictEqual(decodeError.payload.context.dialect, 'minimal');
  // The matched route's profile (Min2), not the default (Min), is attached.
  assert.strictEqual(decodeError.payload.context.profile, 'Min2');
  assert.ok(decodeError.payload.context.raw.length > 0);

  // Case 3: a custom-XML dialect's message id (9100) from sysid 3. The default
  // profile's bundled CRC table has no entry for 9100, so this only works if
  // the connection's splitter uses the merged table across all routed profiles.
  const customBundle = loadDialect('custom', { customDialectPath: CUSTOM_XML });
  const fromSys3 = new MavlinkCodec({ bundle: customBundle, version: 'v2', sysid: 3, compid: 1 });
  const custom = await until(
    (done) => conn.subscribe({ messageNames: ['CUSTOM_VEHICLE_STATUS'] }, done),
    () => sock.send(fromSys3.encode('CUSTOM_VEHICLE_STATUS', { mode: 7 }), port, '127.0.0.1'),
    'custom dialect decode'
  );
  assert.strictEqual(custom.payload.name, 'CUSTOM_VEHICLE_STATUS');
  assert.strictEqual(custom.payload.sysid, 3);
  assert.strictEqual(custom.payload.profile, 'Custom');
  assert.strictEqual(custom.payload.fields.mode, 7);
});

/**
 * connection.send must encode with the codec of the profile named on the
 * message, not always the default profile (#68). Here the default profile is
 * `minimal` with source sysid 255, while a second profile uses source sysid 42.
 * A HEARTBEAT sent with that profile must go out framed from sysid 42.
 */
test('outbound send honors the message profile codec (#68)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p_def', name: 'Def', profileType: 'gcs', dialect: 'minimal', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-profile', {
    id: 'p_alt', name: 'Alt', profileType: 'gcs', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    sourceSystemId: 42, sourceComponentId: 200, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_send', name: 'Send UDP', profile: 'p_def',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  // Stop the real UDP transport up front and capture outbound frames instead of
  // putting them on the wire. The fake exposes stop() so teardown stays clean.
  await new Promise((resolve) => conn._transport.once('listening', resolve));
  await conn._transport.stop();
  const sent = [];
  conn._transport = {
    descriptor: { type: 'fake' },
    send: (buf) => { sent.push(buf); return Promise.resolve(); },
    stop: () => Promise.resolve()
  };
  t.after(async () => RED.close(conn));

  // Default profile: source sysid 255 (offset 5 in a v2 frame).
  await conn.send({ name: 'HEARTBEAT', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1][5], 255);

  // Named profile: source sysid 42.
  await conn.send({ name: 'HEARTBEAT', profile: 'p_alt', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1][5], 42);

  // Legacy: a unique profile *name* still resolves (back-compat for flows
  // authored before message.profile carried the config-node id).
  await conn.send({ name: 'HEARTBEAT', profile: 'Alt', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1][5], 42);

  // An explicitly requested profile that resolves to nothing must reject the
  // send — never silently encode with the default profile.
  await assert.rejects(
    conn.send({ name: 'HEARTBEAT', profile: 'NoSuchProfile', fields: { type: 'MAV_TYPE_GCS' } }),
    (err) => err.code === 'PROFILE_UNRESOLVED'
  );
});

/**
 * A route entry may reference its profile by config-node id (canonical) or,
 * for backward compatibility, by a *unique* profile name. Routed packets must
 * then decode with that profile's dialect and carry both the display name and
 * the canonical id.
 */
test('route entries resolve legacy unique profile names to the real profile', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p_min', name: 'Min', profileType: 'gcs', dialect: 'minimal', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-profile', {
    id: 'p_ardu', name: 'Ardu', profileType: 'copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_names', name: 'Named routes', profile: 'p_min',
    transport: 'udp-peer', routingMode: 'routed', unmatchedPolicy: 'reject',
    routeTable: JSON.stringify([{ sysid: 1, compid: '*', profile: 'Ardu' }]),
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const sock = dgram.createSocket('udp4');
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });

  const fromSys1 = new MavlinkCodec({ bundle: loadDialect('ardupilotmega'), version: 'v2', sysid: 1, compid: 1 });
  const attitude = await until(
    (done) => conn.subscribe({ messageNames: ['ATTITUDE'] }, done),
    () => sock.send(fromSys1.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }), addr.port, '127.0.0.1'),
    'ATTITUDE decode via name route'
  );
  // Decoded with the ardupilotmega dialect (the minimal default cannot decode
  // id 30) and labeled with both the display name and the canonical id.
  assert.strictEqual(attitude.payload.profile, 'Ardu');
  assert.strictEqual(attitude.payload.profile_id, 'p_ardu');

  // Deploy-time validation over the same table finds nothing wrong.
  RED.events.emit('flows:started');
  assert.deepStrictEqual(conn.errors, []);
});

/**
 * A matched route whose profile cannot be resolved must REJECT its packets —
 * never decode them with the default profile — even when the unmatched policy
 * is 'default'. The misconfiguration is loud: once per identity at packet
 * time, and per route at deploy time via flows:started.
 */
test('a route naming an unknown profile rejects its packets and reports loudly', async (t) => {
  const RED = new MockRED().loadNodes();
  // The default profile's dialect COULD decode ATTITUDE — silent fallback
  // would be invisible here, which is exactly the bug this guards against.
  RED.create('mavlink-ai-profile', {
    id: 'p_def', name: 'Def', profileType: 'gcs', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  // Two profiles sharing one name make that name ambiguous as a reference.
  RED.create('mavlink-ai-profile', {
    id: 'p_dup1', name: 'Dup', profileType: 'gcs', dialect: 'minimal', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-profile', {
    id: 'p_dup2', name: 'Dup', profileType: 'gcs', dialect: 'minimal', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_ghost', name: 'Bad routes', profile: 'p_def',
    transport: 'udp-peer', routingMode: 'routed', unmatchedPolicy: 'default',
    routeTable: JSON.stringify([
      { sysid: 1, compid: '*', profile: 'Ghost' },
      { sysid: 2, compid: '*', profile: 'Dup' }
    ]),
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const sock = dgram.createSocket('udp4');
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });

  // Deploy-time validation names both broken routes.
  RED.events.emit('flows:started');
  assert.strictEqual(conn.errors.length, 1);
  assert.match(String(conn.errors[0]), /ROUTE_TABLE_INVALID/);
  assert.match(String(conn.errors[0]), /'Ghost'/);
  assert.match(String(conn.errors[0]), /'Dup'/);
  assert.match(String(conn.errors[0]), /matches 2 profile config nodes/);
  conn.errors.length = 0;

  const ardu = loadDialect('ardupilotmega');
  const fromSys1 = new MavlinkCodec({ bundle: ardu, version: 'v2', sysid: 1, compid: 1 });
  const fromSys2 = new MavlinkCodec({ bundle: ardu, version: 'v2', sysid: 2, compid: 1 });

  // Unresolvable route target: the packet is rejected, not decoded as 'Def'.
  const messages = [];
  conn.subscribe({}, (m) => messages.push(m));
  const rejected1 = await until(
    (done) => conn.emitter.on('rejected', (r) => { if (r.sysid === 1) done(r); }),
    () => sock.send(fromSys1.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }), addr.port, '127.0.0.1'),
    'rejection for unresolved route profile'
  );
  assert.strictEqual(rejected1.reason, 'profile-unresolved');

  // Ambiguous name: same rejection, not a coin-flip between the two 'Dup's.
  const rejected2 = await until(
    (done) => conn.emitter.on('rejected', (r) => { if (r.sysid === 2) done(r); }),
    () => sock.send(fromSys2.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }), addr.port, '127.0.0.1'),
    'rejection for ambiguous route profile'
  );
  assert.strictEqual(rejected2.reason, 'profile-unresolved');

  assert.strictEqual(messages.length, 0);
  // Packet-time logging is deduplicated per identity+problem, not per packet.
  const ghostLogs = conn.errors.filter((e) => /'Ghost'/.test(String(e)));
  const dupLogs = conn.errors.filter((e) => /'Dup'/.test(String(e)));
  assert.strictEqual(ghostLogs.length, 1);
  assert.strictEqual(dupLogs.length, 1);
});
