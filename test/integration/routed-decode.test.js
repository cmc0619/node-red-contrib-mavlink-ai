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

  // UDP loopback can drop a lone datagram under CPU contention, so resend on an
  // interval (like a real MAVLink request) until the expected event arrives.
  const until = (event, attach, sendOnce, label) =>
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

  // Case 1: ATTITUDE from sysid 1 routes to the ardupilotmega profile and decodes.
  const attitude = await until(
    'message',
    (done) => conn.subscribe({ messageNames: ['ATTITUDE'] }, done),
    () => sock.send(fromSys1.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }), port, '127.0.0.1'),
    'ATTITUDE decode'
  );
  assert.strictEqual(attitude.payload.name, 'ATTITUDE');
  assert.strictEqual(attitude.payload.sysid, 1);
  assert.strictEqual(attitude.payload.profile, 'Ardu');

  // Case 2: ATTITUDE from sysid 2 is *matched by an explicit route* to the
  // minimal profile, whose dialect cannot decode id 30. This proves the matched
  // profile's dialect is used (the ardupilotmega default WOULD have decoded it)
  // and that failure produces a structured decode error with packet metadata.
  const decodeError = await until(
    'decodeError',
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
    'message',
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
});
