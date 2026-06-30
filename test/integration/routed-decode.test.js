'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

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

  const conn = RED.create('mavlink-ai-connection', {
    id: 'c_routed', name: 'Routed UDP', profile: 'p_min',
    transport: 'udp-peer', routingMode: 'routed', unmatchedPolicy: 'default',
    routeTable: JSON.stringify([{ sysid: 1, compid: '*', profile: 'p_ardu' }]),
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });

  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));
  const port = addr.port;

  const ardu = loadDialect('ardupilotmega');
  const fromSys1 = new MavlinkCodec({ bundle: ardu, version: 'v2', sysid: 1, compid: 1 });
  const fromSys9 = new MavlinkCodec({ bundle: ardu, version: 'v2', sysid: 9, compid: 1 });
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

  // Case 2: ATTITUDE from sysid 9 is unmatched, falls back to the minimal
  // default profile, which cannot decode id 30 -> structured decode error.
  const decodeError = await until(
    'decodeError',
    (done) => conn.emitter.on('decodeError', done),
    () => sock.send(fromSys9.encode('ATTITUDE', { roll: 0, pitch: 0, yaw: 0 }), port, '127.0.0.1'),
    'decode error'
  );
  assert.strictEqual(decodeError.payload.code, 'DECODE_FAILED');
  assert.strictEqual(decodeError.payload.context.msgid, 30);
  assert.strictEqual(decodeError.payload.context.dialect, 'minimal');
  assert.strictEqual(decodeError.payload.context.profile, 'Min');
  assert.ok(decodeError.payload.context.raw.length > 0);
});
