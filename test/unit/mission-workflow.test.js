'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MissionDownload, extractItem } = require('../../lib/mission/mission-download');
const { MissionUpload, buildItemFields } = require('../../lib/mission/mission-upload');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal connection stand-in: records outbound messages and delivers decoded
 * mission payloads to whatever the workflow subscribed with.
 */
class FakeConnection {
  constructor() {
    this.sent = [];
    this._subs = new Map();
    this._id = 1;
  }

  subscribe(filter, cb) {
    const id = this._id++;
    this._subs.set(id, { filter, cb });
    return id;
  }

  unsubscribe(id) {
    return this._subs.delete(id);
  }

  send(message) {
    this.sent.push(message);
    return Promise.resolve();
  }

  deliver(name, fields, sysid = 1) {
    for (const { cb } of this._subs.values()) {
      cb({ topic: `mavlink/${name}`, payload: { name, sysid, compid: 1, fields } });
    }
  }
}

function downloadOpts(conn, extra = {}) {
  return Object.assign(
    {
      connection: conn,
      targetSystem: 1,
      targetComponent: 1,
      sourceSystem: 255,
      sourceComponent: 190,
      missionType: 'mission',
      timeoutMs: 50,
      maxRetries: 1
    },
    extra
  );
}

test('buildItemFields converts lat/lon degrees to the wire scaling (#18)', () => {
  const int = buildItemFields({ command: 16, lat: 47.397742, lon: 8.545594, alt: 50 }, 1, true);
  assert.strictEqual(int.x, 473977420);
  assert.strictEqual(int.y, 85455940);
  assert.strictEqual(int.z, 50);

  const flt = buildItemFields({ command: 16, lat: 47.397742, lon: 8.545594, z: 50 }, 1, false);
  assert.strictEqual(flt.x, 47.397742);
  assert.strictEqual(flt.y, 8.545594);

  // Explicit x/y are raw wire values and win over lat/lon.
  const raw = buildItemFields({ command: 16, x: 473977420, y: 85455940, lat: 1, lon: 2 }, 0, true);
  assert.strictEqual(raw.x, 473977420);
  assert.strictEqual(raw.y, 85455940);
});

test('extractItem adds lat/lon degrees and wire_message for global frames (#18)', () => {
  const int = extractItem(
    { seq: 0, frame: 6, command: 16, x: 473977420, y: 85455940, z: 50 },
    'MISSION_ITEM_INT'
  );
  assert.strictEqual(int.lat, 47.397742);
  assert.strictEqual(int.lon, 8.545594);
  assert.strictEqual(int.wire_message, 'MISSION_ITEM_INT');
  assert.strictEqual(int.x, 473977420); // raw wire value preserved

  // MISSION_ITEM_INT with a non-INT global frame (ArduPilot does this) is
  // still degE7 — scaling follows the message, not the frame.
  const intFrame3 = extractItem({ seq: 0, frame: 3, command: 16, x: 473977420, y: 85455940, z: 50 }, 'MISSION_ITEM_INT');
  assert.strictEqual(intFrame3.lat, 47.397742);

  const flt = extractItem({ seq: 0, frame: 3, command: 16, x: 47.397742, y: 8.545594, z: 50 }, 'MISSION_ITEM');
  assert.strictEqual(flt.lat, 47.397742);
  assert.strictEqual(flt.lon, 8.545594);

  // Local frames (e.g. MAV_FRAME_LOCAL_NED = 1) carry meters, not lat/lon.
  const local = extractItem({ seq: 0, frame: 1, command: 16, x: 10, y: 20, z: -5 }, 'MISSION_ITEM_INT');
  assert.strictEqual(local.lat, undefined);
  assert.strictEqual(local.lon, undefined);
});

test('download ignores responses addressed to another GCS (#34)', async () => {
  const conn = new FakeConnection();
  const wf = new MissionDownload(downloadOpts(conn, { timeoutMs: 1000, maxRetries: 0 }));
  const p = wf.run();
  await delay(0);
  // Addressed to GCS sysid 254 — someone else's transfer; must not advance us.
  conn.deliver('MISSION_COUNT', { count: 1, mission_type: 0, target_system: 254, target_component: 190 });
  assert.strictEqual(wf.count, 0);
  // Addressed to us (and a broadcast component) advances the download.
  conn.deliver('MISSION_COUNT', { count: 0, mission_type: 0, target_system: 255, target_component: 0 });
  const res = await p;
  assert.strictEqual(res.payload.count, 0);
});

test('upload sequences items by array index, ignoring item.seq (#33)', async () => {
  const conn = new FakeConnection();
  const wf = new MissionUpload(
    downloadOpts(conn, {
      timeoutMs: 1000,
      maxRetries: 0,
      items: [
        { command: 16, lat: 1, lon: 2, seq: 99 },
        { command: 16, lat: 3, lon: 4, seq: 0 }
      ]
    })
  );
  const p = wf.run();
  await delay(0);
  conn.deliver('MISSION_REQUEST_INT', { seq: 1, mission_type: 0, target_system: 255, target_component: 190 });
  await delay(0);
  const sentItem = conn.sent.find((m) => m.name === 'MISSION_ITEM_INT');
  assert.ok(sentItem);
  assert.strictEqual(sentItem.fields.seq, 1); // requested seq, not item.seq
  assert.strictEqual(sentItem.fields.x, 30000000); // lat 3 in degE7
  conn.deliver('MISSION_ACK', { type: 0, mission_type: 0, target_system: 255, target_component: 190 });
  const res = await p;
  assert.strictEqual(res.payload.count, 2);
});

test('upload rejection reports the MAV_MISSION_RESULT name (#24)', async () => {
  const conn = new FakeConnection();
  const enums = loadDialect('ardupilotmega').enums;
  const wf = new MissionUpload(
    downloadOpts(conn, { enums, timeoutMs: 1000, maxRetries: 0, items: [{ command: 16, lat: 1, lon: 2 }] })
  );
  const p = wf.run();
  await delay(0);
  // MAV_MISSION_RESULT 13 = MAV_MISSION_INVALID_SEQUENCE.
  conn.deliver('MISSION_ACK', { type: 13, mission_type: 0, target_system: 255, target_component: 190 });
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, 'MISSION_REJECTED');
    assert.match(e.message, /13/);
    assert.match(e.message, /INVALID_SEQUENCE/);
    assert.strictEqual(e.context.result, 13);
    assert.match(String(e.context.result_name), /INVALID_SEQUENCE/);
    return true;
  });
});
