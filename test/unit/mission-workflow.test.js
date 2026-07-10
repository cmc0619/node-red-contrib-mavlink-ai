'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MissionDownload, extractItem } = require('../../lib/mission/mission-download');
const { MissionUpload, buildItemFields } = require('../../lib/mission/mission-upload');
const { MissionClear } = require('../../lib/mission/mission-clear');
const { DEFAULT_TIMEOUT_MS } = require('../../lib/mission/mission-state-machine');
const { topicAction, normalizeUploadItems, validateMissionItems } = require('../../lib/mission/upload-input');

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

// --- #58: mission timeout default ------------------------------------------

test('mission workflow default timeout is 10s (#58)', () => {
  assert.strictEqual(DEFAULT_TIMEOUT_MS, 10000);
  // A workflow with no explicit timeout adopts the default.
  const conn = new FakeConnection();
  const wf = new MissionDownload({
    connection: conn,
    targetSystem: 1,
    targetComponent: 1,
    missionType: 'mission'
  });
  assert.strictEqual(wf.timeoutMs, 10000);
});

// --- #57: upload answers with the requested item type ----------------------

test('upload answers MISSION_REQUEST with MISSION_ITEM (float degrees) (#57)', async () => {
  const conn = new FakeConnection();
  // Profile prefers *_INT, but the vehicle asks with the non-INT request.
  const wf = new MissionUpload(
    downloadOpts(conn, { useInt: true, timeoutMs: 1000, maxRetries: 0, items: [{ command: 16, lat: 3, lon: 4 }] })
  );
  const p = wf.run();
  await delay(0);
  conn.deliver('MISSION_REQUEST', { seq: 0, mission_type: 0, target_system: 255, target_component: 190 });
  await delay(0);
  const sent = conn.sent.find((m) => m.name === 'MISSION_ITEM' || m.name === 'MISSION_ITEM_INT');
  assert.ok(sent);
  assert.strictEqual(sent.name, 'MISSION_ITEM'); // matched the request, not the profile
  assert.strictEqual(sent.fields.x, 3); // float degrees, not degE7
  assert.strictEqual(sent.fields.y, 4);
  conn.deliver('MISSION_ACK', { type: 0, mission_type: 0, target_system: 255, target_component: 190 });
  await p;
});

test('upload answers MISSION_REQUEST_INT with MISSION_ITEM_INT (degE7) even if profile prefers float (#57)', async () => {
  const conn = new FakeConnection();
  const wf = new MissionUpload(
    downloadOpts(conn, { useInt: false, timeoutMs: 1000, maxRetries: 0, items: [{ command: 16, lat: 3, lon: 4 }] })
  );
  const p = wf.run();
  await delay(0);
  conn.deliver('MISSION_REQUEST_INT', { seq: 0, mission_type: 0, target_system: 255, target_component: 190 });
  await delay(0);
  const sent = conn.sent.find((m) => m.name === 'MISSION_ITEM' || m.name === 'MISSION_ITEM_INT');
  assert.strictEqual(sent.name, 'MISSION_ITEM_INT');
  assert.strictEqual(sent.fields.x, 30000000); // lat 3 in degE7
  conn.deliver('MISSION_ACK', { type: 0, mission_type: 0, target_system: 255, target_component: 190 });
  await p;
});

// --- #56: waypoints alias + default command --------------------------------

test('topicAction maps Aigen topics to actions (#56)', () => {
  assert.strictEqual(topicAction('upload_mission'), 'upload');
  assert.strictEqual(topicAction('download_mission'), 'download');
  assert.strictEqual(topicAction('clear_mission'), 'clear');
  assert.strictEqual(topicAction('something_else'), undefined);
});

test('normalizeUploadItems accepts waypoints alias and defaults NAV_WAYPOINT (#56)', () => {
  const wp = normalizeUploadItems({ waypoints: [{ lat: 37.7749, lon: -122.4194, alt: 100 }] });
  assert.strictEqual(wp.length, 1);
  assert.strictEqual(wp[0].command, 'MAV_CMD_NAV_WAYPOINT');
  assert.strictEqual(wp[0].lat, 37.7749);

  // items wins over waypoints when both present, and explicit command is kept.
  const both = normalizeUploadItems({
    items: [{ command: 'MAV_CMD_NAV_TAKEOFF', lat: 1, lon: 2, alt: 10 }],
    waypoints: [{ lat: 9, lon: 9 }]
  });
  assert.strictEqual(both.length, 1);
  assert.strictEqual(both[0].command, 'MAV_CMD_NAV_TAKEOFF');

  // A raw item with x/y but no lat/lon and no command is left untouched (no default).
  const raw = normalizeUploadItems({ items: [{ x: 1, y: 2, z: 3 }] });
  assert.strictEqual(raw[0].command, undefined);
  assert.deepStrictEqual(normalizeUploadItems({}), []);
});

// --- #59: clear with MISSION_ACK -------------------------------------------

test('MissionClear resolves on an accepted MISSION_ACK (#59)', async () => {
  const conn = new FakeConnection();
  const enums = loadDialect('ardupilotmega').enums;
  const wf = new MissionClear(downloadOpts(conn, { enums, timeoutMs: 1000, maxRetries: 0 }));
  const p = wf.run();
  await delay(0);
  assert.ok(conn.sent.find((m) => m.name === 'MISSION_CLEAR_ALL'));
  conn.deliver('MISSION_ACK', { type: 0, mission_type: 0, target_system: 255, target_component: 190 });
  const res = await p;
  assert.strictEqual(res.topic, 'mission/cleared');
  assert.strictEqual(res.payload.acked, true);
  assert.strictEqual(res.payload.result, 0);
  assert.match(String(res.payload.result_name), /ACCEPTED/);
});

test('MissionClear rejects a denied clear with the result name (#59)', async () => {
  const conn = new FakeConnection();
  const enums = loadDialect('ardupilotmega').enums;
  const wf = new MissionClear(downloadOpts(conn, { enums, timeoutMs: 1000, maxRetries: 0 }));
  const p = wf.run();
  await delay(0);
  conn.deliver('MISSION_ACK', { type: 3, mission_type: 0, target_system: 255, target_component: 190 });
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, 'MISSION_CLEAR_REJECTED');
    assert.strictEqual(e.context.result, 3);
    return true;
  });
});

// --- #55: mission item validation ------------------------------------------

test('validateMissionItems rejects a missing command and out-of-range coords (#55)', () => {
  const ok = validateMissionItems([{ command: 'MAV_CMD_NAV_WAYPOINT', lat: 37, lon: -122 }]);
  assert.strictEqual(ok.length, 1);
  assert.throws(
    () => validateMissionItems([{ lat: 1, lon: 2 }]),
    (e) => e.code === 'INVALID_FIELD' && e.context.field === 'command' && e.context.seq === 0
  );
  assert.throws(
    () => validateMissionItems([{ command: 16, lat: 200, lon: 2 }]),
    (e) => e.code === 'INVALID_FIELD' && e.context.field === 'lat'
  );
});

test('MissionClear times out cleanly with no ACK (#59)', async () => {
  const conn = new FakeConnection();
  const wf = new MissionClear(downloadOpts(conn, { timeoutMs: 20, maxRetries: 0 }));
  // The workflow timeout timer is unref'd; keep the loop alive so it can fire.
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(wf.run(), (e) => {
      assert.strictEqual(e.code, 'MISSION_TIMEOUT');
      return true;
    });
  } finally {
    clearInterval(keepAlive);
  }
});

test('mission workflow sends carry the profile reference end-to-end', async () => {
  const conn = new FakeConnection();
  const wf = new MissionClear(downloadOpts(conn, { profile: 'p_routed' }));
  const p = wf.run();
  conn.deliver('MISSION_ACK', { type: 0, mission_type: 0, target_system: 255, target_component: 190 });
  const res = await p;
  assert.strictEqual(res.payload.acked, true);
  assert.strictEqual(conn.sent[0].name, 'MISSION_CLEAR_ALL');
  for (const m of conn.sent) {
    assert.strictEqual(m.profile, 'p_routed');
  }
});

test('mission workflow without a profile sends no profile reference', async () => {
  const conn = new FakeConnection();
  const wf = new MissionClear(downloadOpts(conn));
  const p = wf.run();
  conn.deliver('MISSION_ACK', { type: 0, mission_type: 0, target_system: 255, target_component: 190 });
  await p;
  assert.ok(!('profile' in conn.sent[0]));
});
