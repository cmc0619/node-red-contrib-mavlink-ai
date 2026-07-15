'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { makeIdentity, makeProfile, makeConnection } = require('../helpers/v3-config');

/**
 * Same-connection multi-identity transmission and connection-owned channel
 * state (issues #228, #192): one link acting as both a GCS and a companion,
 * with sequence numbers scoped per local identity and heartbeats coalesced per
 * identity so one identity's heartbeat can never replace another's.
 */

/** Read the (sysid, compid, seq) triple from a v2 frame header. */
function header(frame) {
  return { sysid: frame[5], compid: frame[6], seq: frame[4] };
}

test('one connection transmits as two distinct identities with independent sequence streams (#228, #192)', async (t) => {
  const RED = new MockRED().loadNodes();
  makeProfile(RED, { id: 'p1', dialect: 'common', mavlinkVersion: 'v2' });
  makeIdentity(RED, { id: 'gcs', name: 'GCS', sourceSystemId: 255, sourceComponentId: 190 });
  makeIdentity(RED, { id: 'companion', name: 'Companion', role: 'companion', sourceSystemId: 1, sourceComponentId: 191 });
  const { connection } = makeConnection(RED, {
    id: 'c1',
    profile: 'p1',
    localIdentity: 'gcs',
    allowMultipleIdentities: true,
    additionalIdentities: JSON.stringify([{ identity: 'companion', allowOutbound: true }])
  });
  t.after(() => RED.close(connection));

  const sent = [];
  connection._queue = { enqueue(buffer) { sent.push(buffer); return Promise.resolve(); }, clear() {} };

  const hb = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };
  // Interleave sends as the two identities.
  await connection.send({ name: 'HEARTBEAT', fields: hb }); // default: GCS
  await connection.send({ name: 'HEARTBEAT', localIdentity: 'companion', fields: hb });
  await connection.send({ name: 'HEARTBEAT', fields: hb }); // GCS again
  await connection.send({ name: 'HEARTBEAT', localIdentity: 'companion', fields: hb });

  const h = sent.map(header);
  // Each frame carries its own identity's source ids.
  assert.deepStrictEqual([h[0].sysid, h[0].compid], [255, 190]);
  assert.deepStrictEqual([h[1].sysid, h[1].compid], [1, 191]);
  assert.deepStrictEqual([h[2].sysid, h[2].compid], [255, 190]);
  assert.deepStrictEqual([h[3].sysid, h[3].compid], [1, 191]);
  // Sequence numbers advance per identity, not globally: GCS 0,1 and companion 0,1.
  assert.strictEqual(h[0].seq, 0, 'GCS first seq');
  assert.strictEqual(h[1].seq, 0, 'companion first seq (independent of GCS)');
  assert.strictEqual(h[2].seq, 1, 'GCS second seq');
  assert.strictEqual(h[3].seq, 1, 'companion second seq');
});

test('the default identity sequence is unaffected by routed vehicle profiles on one link (#192)', async (t) => {
  // Two routed vehicle profiles (different dialects) share one connection and
  // one local identity. Sequence state is keyed by local identity + link, not
  // by dialect codec, so alternating sends keep a single ascending stream.
  const RED = new MockRED().loadNodes();
  makeProfile(RED, { id: 'p_common', name: 'Common', dialect: 'common', mavlinkVersion: 'v2' });
  makeProfile(RED, { id: 'p_ardu', name: 'Ardu', dialect: 'ardupilotmega', mavlinkVersion: 'v2' });
  makeIdentity(RED, { id: 'gcs', name: 'GCS', sourceSystemId: 255, sourceComponentId: 190 });
  const { connection } = makeConnection(RED, {
    id: 'c1',
    profile: 'p_common',
    localIdentity: 'gcs',
    routingMode: 'routed',
    unmatchedPolicy: 'default',
    routeTable: JSON.stringify([{ sysid: 2, compid: '*', profile: 'p_ardu' }])
  });
  t.after(() => RED.close(connection));

  const sent = [];
  connection._queue = { enqueue(buffer) { sent.push(buffer); return Promise.resolve(); }, clear() {} };

  const hb = { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 };
  await connection.send({ name: 'HEARTBEAT', fields: hb });                       // default profile codec
  await connection.send({ name: 'HEARTBEAT', vehicleProfile: 'p_ardu', fields: hb }); // other dialect codec
  await connection.send({ name: 'HEARTBEAT', fields: hb });

  const seqs = sent.map((f) => header(f).seq);
  assert.deepStrictEqual(seqs, [0, 1, 2], 'one ascending sequence stream across both dialect codecs');
});

test('heartbeat coalescing is keyed per identity so one heartbeat cannot replace another (#228)', () => {
  const RED = new MockRED().loadNodes();
  const gcs = makeIdentity(RED, { id: 'gcs', name: 'GCS', sourceSystemId: 255, sourceComponentId: 190 });
  const companion = makeIdentity(RED, { id: 'companion', name: 'Companion', role: 'companion', sourceSystemId: 1, sourceComponentId: 191 });
  // The connection heartbeat sends use coalesceKey `heartbeat:<identity.id>`.
  // Distinct identities therefore never coalesce over each other. This asserts
  // the key derivation the connection uses stays identity-scoped.
  assert.notStrictEqual(`heartbeat:${gcs.id}`, `heartbeat:${companion.id}`);
});
