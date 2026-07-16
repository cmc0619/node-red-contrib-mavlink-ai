'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const path = require('path');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

// A standalone custom dialect that only *adds* message id 9100. It must not
// include the trimmed fixture common.xml: that copy redefines HEARTBEAT and
// ATTITUDE with different layouts, which is a routed CRC-extra conflict the
// connection now rejects (#86) rather than merging silently.
const CUSTOM_XML = path.join(__dirname, '..', 'fixtures', 'dialects', 'custom_addon.xml');

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

  RED.create('mavlink-ai-vehicle', {
    id: 'p_min', name: 'Min', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p_ardu', name: 'Ardu', vehicleFamily: 'copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  // A second minimal profile, distinct from the default, to prove routed decode
  // uses the *matched route's* profile rather than the default.
  RED.create('mavlink-ai-vehicle', {
    id: 'p_min2', name: 'Min2', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  // A runtime-compiled custom-XML profile. Its message ids exist in no bundled
  // dialect, so this exercises the merged splitter CRC table: without it the
  // packet would be dropped silently before routing.
  RED.create('mavlink-ai-vehicle', {
    id: 'p_custom', name: 'Custom', vehicleFamily: 'generic', dialect: 'custom',
    customDialectPath: CUSTOM_XML, mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });

  // The connection needs a Local Identity to open its socket (#228).
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });

  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_routed', name: 'Routed UDP', profile: 'p_min', localIdentity: 'id1',
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
  const fromSys1 = new MavlinkCodec({ bundle: ardu, version: 'v2' });
  const fromSys2 = new MavlinkCodec({ bundle: ardu, version: 'v2' });
  const sock = dgram.createSocket('udp4');
  t.after(async () => {
    await RED.close(conn);
    await new Promise((r) => sock.close(r));
  });

  // Case 1: ATTITUDE from sysid 1 routes to the ardupilotmega profile and decodes.
  const attitude = await until(
    (done) => conn.subscribe({ messageNames: ['ATTITUDE'] }, done),
    () => sock.send(enc(fromSys1, 'ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }, { sysid: 1, compid: 1 }), port, '127.0.0.1'),
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
    () => sock.send(enc(fromSys2, 'ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }, { sysid: 2, compid: 1 }), port, '127.0.0.1'),
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
  const fromSys3 = new MavlinkCodec({ bundle: customBundle, version: 'v2' });
  const custom = await until(
    (done) => conn.subscribe({ messageNames: ['CUSTOM_VEHICLE_STATUS'] }, done),
    () => sock.send(enc(fromSys3, 'CUSTOM_VEHICLE_STATUS', { mode: 7 }, { sysid: 3, compid: 1 }), port, '127.0.0.1'),
    'custom dialect decode'
  );
  assert.strictEqual(custom.payload.name, 'CUSTOM_VEHICLE_STATUS');
  assert.strictEqual(custom.payload.sysid, 3);
  assert.strictEqual(custom.payload.profile, 'Custom');
  assert.strictEqual(custom.payload.fields.mode, 7);
});

/**
 * Outbound source identity follows the resolved Local Identity, never a Vehicle
 * Profile (#228). In the old model this test proved that selecting a second
 * profile changed the outbound *source* sysid; that capability was deliberately
 * removed — a Vehicle Profile can never change who this runtime is on the wire.
 * The preserved spirit (one connection transmitting as two identities) is now
 * expressed with explicit multi-identity bindings: the connection binds an
 * additional Local Identity and a send addresses it via `msg.localIdentity`.
 */
test('outbound send transmits as the selected Local Identity, not a profile', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p_def', name: 'Def', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  // Two Local Identities: the default (255/190) and an alternate (42/200).
  RED.create('mavlink-ai-local-identity', {
    id: 'id_def', name: 'Def', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id_alt', name: 'Alt', role: 'custom', sourceSystemId: 42, sourceComponentId: 200
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_send', name: 'Send UDP', profile: 'p_def', localIdentity: 'id_def',
    // Explicit multi-identity binding: the connection may also transmit as id_alt.
    allowMultipleIdentities: true,
    additionalIdentities: JSON.stringify([{ identity: 'id_alt', allowOutbound: true }]),
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

  // No identity override: the connection's default identity, source sysid 255.
  await conn.send({ name: 'HEARTBEAT', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1][5], 255);

  // Explicit second identity by id: source sysid 42 (offset 5 in a v2 frame).
  await conn.send({ name: 'HEARTBEAT', localIdentity: 'id_alt', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1][5], 42);

  // A unique identity *name* resolves too (back-compat for flows that name it).
  await conn.send({ name: 'HEARTBEAT', localIdentity: 'Alt', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1][5], 42);

  // An explicitly requested identity that resolves to nothing must reject the
  // send — never silently transmit as the default identity.
  await assert.rejects(
    conn.send({ name: 'HEARTBEAT', localIdentity: 'NoSuchIdentity', fields: { type: 'MAV_TYPE_GCS' } }),
    (err) => err.code === 'LOCAL_IDENTITY_UNRESOLVED'
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
  RED.create('mavlink-ai-vehicle', {
    id: 'p_min', name: 'Min', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p_ardu', name: 'Ardu', vehicleFamily: 'copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_names', name: 'Named routes', profile: 'p_min', localIdentity: 'id1',
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

  const fromSys1 = new MavlinkCodec({ bundle: loadDialect('ardupilotmega'), version: 'v2' });
  const attitude = await until(
    (done) => conn.subscribe({ messageNames: ['ATTITUDE'] }, done),
    () => sock.send(enc(fromSys1, 'ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }, { sysid: 1, compid: 1 }), addr.port, '127.0.0.1'),
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
  RED.create('mavlink-ai-vehicle', {
    id: 'p_def', name: 'Def', vehicleFamily: 'generic', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  // Two profiles sharing one name make that name ambiguous as a reference.
  RED.create('mavlink-ai-vehicle', {
    id: 'p_dup1', name: 'Dup', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p_dup2', name: 'Dup', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_ghost', name: 'Bad routes', profile: 'p_def', localIdentity: 'id1',
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
  const fromSys1 = new MavlinkCodec({ bundle: ardu, version: 'v2' });
  const fromSys2 = new MavlinkCodec({ bundle: ardu, version: 'v2' });

  // Unresolvable route target: the packet is rejected, not decoded as 'Def'.
  const messages = [];
  conn.subscribe({}, (m) => messages.push(m));
  const rejected1 = await until(
    (done) => conn.emitter.on('rejected', (r) => { if (r.sysid === 1) done(r); }),
    () => sock.send(enc(fromSys1, 'ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }, { sysid: 1, compid: 1 }), addr.port, '127.0.0.1'),
    'rejection for unresolved route profile'
  );
  assert.strictEqual(rejected1.reason, 'profile-unresolved');

  // Ambiguous name: same rejection, not a coin-flip between the two 'Dup's.
  const rejected2 = await until(
    (done) => conn.emitter.on('rejected', (r) => { if (r.sysid === 2) done(r); }),
    () => sock.send(enc(fromSys2, 'ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }, { sysid: 2, compid: 1 }), addr.port, '127.0.0.1'),
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

/**
 * A partial deploy can fix a broken route table (add the missing profile)
 * without recreating the connection node. The re-validation on the next
 * flows:started must then clear the stale route-table error status, restoring
 * the status it replaced — not leave the node looking broken forever.
 */
test('fixing a broken route table on redeploy clears the stale error status', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p_def', name: 'Def', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_late', name: 'Late profile', profile: 'p_def', localIdentity: 'id1',
    transport: 'udp-peer', routingMode: 'routed', unmatchedPolicy: 'reject',
    routeTable: JSON.stringify([{ sysid: 1, compid: '*', profile: 'p_late' }]),
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  await new Promise((resolve) => conn._transport.once('listening', resolve));
  t.after(async () => RED.close(conn));
  assert.strictEqual(conn.statusState, 'listening');

  // Deploy with the route's profile missing: loud error status.
  RED.events.emit('flows:started');
  assert.strictEqual(conn.statusState, 'error');
  assert.strictEqual(conn.errors.length, 1);

  // "Partial redeploy" adds the missing profile; the connection instance
  // persists and the next flows:started re-validates cleanly.
  RED.create('mavlink-ai-vehicle', {
    id: 'p_late', name: 'Late', vehicleFamily: 'copter', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');
  // The pre-error status (listening) is restored, and no new error is logged.
  assert.strictEqual(conn.statusState, 'listening');
  assert.strictEqual(conn.errors.length, 1);
});

/**
 * Workflow profile propagation: the Vehicle Profile named on an outbound message
 * is the effective profile for the WHOLE send (codec dialect + target defaults)
 * — a plain profile *name* resolves to the real config node, and an explicit
 * reference that resolves to nothing rejects instead of silently sending as the
 * connection default. In v3 the profile NEVER changes source identity (#228):
 * source identity follows the connection's resolved Local Identity regardless of
 * the selected Vehicle Profile.
 */
test('outbound send resolves profile names, keeps source identity, and rejects unknown profiles', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p_def', name: 'Def', vehicleFamily: 'generic', dialect: 'minimal', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p_alt', name: 'Alt', vehicleFamily: 'generic', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 7, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id_def', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_send2', name: 'Send UDP 2', profile: 'p_def', localIdentity: 'id_def',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  await new Promise((resolve) => conn._transport.once('listening', resolve));
  await conn._transport.stop();
  const sent = [];
  conn._transport = {
    descriptor: { type: 'fake' },
    send: (buf, meta) => { sent.push({ buf, meta }); return Promise.resolve(); },
    stop: () => Promise.resolve()
  };
  t.after(async () => RED.close(conn));

  /**
   * A profile *name* (what inbound payloads and hand-authored flows carry)
   * resolves to the real config node so its dialect/target defaults apply. The
   * source identity is still the connection's Local Identity (255) — selecting
   * the 'Alt' Vehicle Profile can no longer change it (#228). HEARTBEAT is a
   * broadcast with no target_system field, so it carries no routing target
   * regardless of the profile default (#148).
   */
  await conn.send({ name: 'HEARTBEAT', profile: 'Alt', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1].buf[5], 255);
  assert.strictEqual(sent[sent.length - 1].meta.targetSystem, undefined);

  /** No profile: connection default profile + default identity; broadcast has no target. */
  await conn.send({ name: 'HEARTBEAT', fields: { type: 'MAV_TYPE_GCS' } });
  assert.strictEqual(sent[sent.length - 1].buf[5], 255);
  assert.strictEqual(sent[sent.length - 1].meta.targetSystem, undefined);

  // Unknown explicit profile: reject, never silently fall back to the default.
  await assert.rejects(
    conn.send({ name: 'HEARTBEAT', profile: 'no-such-profile', fields: { type: 'MAV_TYPE_GCS' } }),
    (err) => err.code === 'PROFILE_UNRESOLVED'
  );
});
