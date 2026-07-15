'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');

/**
 * Outbound target normalization (#84). A normalized message can carry target
 * ids top-level and inside fields; the connection must resolve them once so
 * the transport routing metadata and the encoded payload always agree, and a
 * genuine disagreement must reject the send instead of silently sending the
 * packet to one system while the payload addresses another.
 */

function setup() {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'p1',
    name: 'P',
    dialect: 'common',
    mavlinkVersion: 'v2',
    sourceSystemId: 255,
    sourceComponentId: 190,
    defaultTargetSystem: 7,
    defaultTargetComponent: 3
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1',
    name: 'C',
    profile: 'p1',
    transport: 'udp-peer',
    bindAddress: '127.0.0.1',
    bindPort: 0,
    reconnect: false,
    heartbeat: false
  });
  // Capture what send() hands to the queue instead of hitting the socket.
  const sent = [];
  conn._queue = {
    enqueue(buffer, priority, meta) {
      sent.push({ buffer, meta });
      return Promise.resolve();
    },
    clear() {}
  };
  return { RED, conn, sent };
}

/** Decode a wire buffer with the connection's own codec. */
function decodeOne(conn, buffer) {
  return new Promise((resolve, reject) => {
    const decoder = conn._codec.createDecoder(
      (packet) => {
        decoder.destroy();
        resolve(conn._codec.decode(packet, {}));
      },
      (err) => {
        decoder.destroy();
        reject(err);
      }
    );
    decoder.write(buffer);
    setTimeout(() => reject(new Error('no packet decoded')), 200).unref();
  });
}

const COMMAND_FIELDS = { command: 512, confirmation: 0, param1: 33 };

test('conflicting top-level and field-level target_system rejects (#84)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));
  await assert.rejects(
    conn.send({
      name: 'COMMAND_LONG',
      target_system: 1,
      target_component: 1,
      fields: Object.assign({}, COMMAND_FIELDS, { target_system: 2, target_component: 1 })
    }),
    (err) => err.code === 'TARGET_CONFLICT' && err.context.top_level === 1 && err.context.field_level === 2
  );
  assert.strictEqual(sent.length, 0, 'nothing was enqueued');
});

test('conflicting target_component rejects (#84)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));
  await assert.rejects(
    conn.send({
      name: 'COMMAND_LONG',
      target_component: 1,
      fields: Object.assign({}, COMMAND_FIELDS, { target_component: 100 })
    }),
    (err) => err.code === 'TARGET_CONFLICT'
  );
  assert.strictEqual(sent.length, 0);
});

test('numeric string and number that agree are accepted and normalized (#84)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));
  await conn.send({
    name: 'COMMAND_LONG',
    target_system: '2',
    fields: Object.assign({}, COMMAND_FIELDS, { target_system: 2 })
  });
  assert.strictEqual(sent.length, 1);
  // Transport metadata carries the same numeric id the payload encodes.
  assert.strictEqual(sent[0].meta.targetSystem, 2);
  const decoded = await decodeOne(conn, sent[0].buffer);
  assert.strictEqual(decoded.fields.target_system, 2);
});

test('single-location targets and profile defaults still work (#84)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));

  // Top-level only.
  await conn.send({ name: 'COMMAND_LONG', target_system: 9, target_component: 4, fields: { ...COMMAND_FIELDS } });
  // Field-level only.
  await conn.send({
    name: 'COMMAND_LONG',
    fields: Object.assign({}, COMMAND_FIELDS, { target_system: 12, target_component: 5 })
  });
  // Neither: profile defaults (7 / 3).
  await conn.send({ name: 'COMMAND_LONG', fields: { ...COMMAND_FIELDS } });

  assert.strictEqual(sent.length, 3);
  assert.strictEqual(sent[0].meta.targetSystem, 9);
  assert.strictEqual(sent[1].meta.targetSystem, 12);
  assert.strictEqual(sent[2].meta.targetSystem, 7);

  const first = await decodeOne(conn, sent[0].buffer);
  assert.strictEqual(first.fields.target_system, 9);
  assert.strictEqual(first.fields.target_component, 4);
  const second = await decodeOne(conn, sent[1].buffer);
  assert.strictEqual(second.fields.target_system, 12);
  assert.strictEqual(second.fields.target_component, 5);
  const third = await decodeOne(conn, sent[2].buffer);
  assert.strictEqual(third.fields.target_system, 7);
  assert.strictEqual(third.fields.target_component, 3);
});

test('blank target values mean "not set" and fall through to defaults (#84)', async (t) => {
  // Number('') is 0, so a blank Node-RED field must not silently address the
  // broadcast target — it falls through to the profile default (7 / 3).
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));
  await conn.send({
    name: 'COMMAND_LONG',
    target_system: '',
    target_component: '  ',
    fields: { ...COMMAND_FIELDS }
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].meta.targetSystem, 7);
  const decoded = await decodeOne(conn, sent[0].buffer);
  assert.strictEqual(decoded.fields.target_system, 7);
  assert.strictEqual(decoded.fields.target_component, 3);
});

test('non-numeric target values reject with BAD_TARGET (#84)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));
  await assert.rejects(
    conn.send({ name: 'COMMAND_LONG', target_system: 'vehicle-one', fields: { ...COMMAND_FIELDS } }),
    (err) => err.code === 'BAD_TARGET'
  );
  assert.strictEqual(sent.length, 0);
});

test('send does not mutate the caller message fields (#84)', async (t) => {
  const { RED, conn } = setup();
  t.after(() => RED.close(conn));
  const fields = Object.assign({}, COMMAND_FIELDS, { target_system: '2' });
  await conn.send({ name: 'COMMAND_LONG', target_system: 2, fields });
  assert.strictEqual(fields.target_system, '2', 'caller fields object left untouched');
});

test('a broadcast message (HEARTBEAT) carries no routing target, so udp-peer fans it out (#148)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));

  /** HEARTBEAT has no target_system field. Despite the profile's
   * defaultTargetSystem (7), the transport routing metadata must be undefined
   * so a udp-peer transport broadcasts to every learned peer instead of
   * unicasting to sysid 7's endpoint (or the last-sender fallback). */
  await conn.send({
    name: 'HEARTBEAT',
    fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 }
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].meta.targetSystem, undefined, 'untargeted broadcast carries no routing target');
});

test('an addressed message still routes to its target via the profile default (#148 regression)', async (t) => {
  const { RED, conn, sent } = setup();
  t.after(() => RED.close(conn));

  /** COMMAND_LONG has a target_system field, so with neither a top-level nor a
   * field-level target the profile default (7) fills in and rides as routing
   * metadata — the broadcast carve-out must not disturb addressed messages. */
  await conn.send({ name: 'COMMAND_LONG', fields: { ...COMMAND_FIELDS } });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].meta.targetSystem, 7, 'addressed message keeps its routing target');
});

test('under auto version, a broadcast is framed with the connection default, not the routing target peer (#148)', async (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-profile', {
    id: 'pa', name: 'Auto', dialect: 'common', mavlinkVersion: 'auto',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 7, defaultTargetComponent: 3
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'ca', name: 'CA', profile: 'pa', transport: 'udp-peer',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  const sent = [];
  conn._queue = { enqueue(buffer, priority, meta) { sent.push({ buffer, meta }); return Promise.resolve(); }, clear() {} };
  t.after(() => RED.close(conn));

  /** The default target sysid 7 speaks v2, but the connection's last-detected
   * default is v1. A broadcast must use the connection default, not sysid 7's. */
  conn._codec.noteInboundMagic(0xfd, 7);
  conn._codec.noteInboundMagic(0xfe, 9);

  await conn.send({ name: 'HEARTBEAT', fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 } });
  assert.strictEqual(sent[sent.length - 1].meta.targetSystem, undefined);
  assert.strictEqual(sent[sent.length - 1].buffer[0], 0xfe, 'broadcast framed with the connection default (v1), not sysid 7 (v2)');

  /** An addressed message to sysid 7 still uses that peer's detected v2 (0xfd). */
  await conn.send({ name: 'COMMAND_LONG', fields: { command: 512, confirmation: 0, target_system: 7 } });
  assert.strictEqual(sent[sent.length - 1].meta.targetSystem, 7);
  assert.strictEqual(sent[sent.length - 1].buffer[0], 0xfd, 'addressed message uses the target sysid detected version (v2)');
});
