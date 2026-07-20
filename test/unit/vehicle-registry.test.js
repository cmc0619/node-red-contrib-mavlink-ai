'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { VehicleRegistry } = require('../../lib/swarm/vehicle-registry');
const { loadDialect } = require('../../lib/dialects/dialect-loader');

const ARDU_BUNDLE = loadDialect('ardupilotmega');
const ENUMS = ARDU_BUNDLE.enums;

/** Manual clock so stale/expiry is deterministic. */
function makeClock(start = 1000000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

/** A decoded §14.1 HEARTBEAT payload for a quadrotor running ArduPilot. */
function heartbeat(sysid, extra = {}) {
  return {
    name: 'HEARTBEAT',
    sysid,
    compid: 1,
    fields: Object.assign(
      { type: 2, autopilot: 3, base_mode: 81, custom_mode: 4, system_status: 4 },
      extra
    )
  };
}

test('HEARTBEAT discovers vehicles with readable type/status/mode names (#46)', () => {
  const clock = makeClock();
  const reg = new VehicleRegistry({ enums: ENUMS, dialect: ARDU_BUNDLE.name, now: clock.now });
  const { added } = reg.ingest(heartbeat(1));
  assert.strictEqual(added, true);
  const [v] = reg.vehicles();
  assert.strictEqual(v.sysid, 1);
  assert.strictEqual(v.compid, 1);
  assert.strictEqual(v.type_name, 'MAV_TYPE_QUADROTOR');
  assert.strictEqual(v.autopilot_name, 'MAV_AUTOPILOT_ARDUPILOTMEGA');
  assert.strictEqual(v.status, 'MAV_STATE_ACTIVE');
  assert.strictEqual(v.mode, 'GUIDED'); // ArduCopter custom_mode 4
  assert.strictEqual(v.armed, false); // base_mode 81 has no SAFETY_ARMED bit
  assert.strictEqual(v.stale, false);
});

test('armed flag follows MAV_MODE_FLAG_SAFETY_ARMED (#46)', () => {
  const reg = new VehicleRegistry({ now: makeClock().now });
  reg.ingest(heartbeat(1, { base_mode: 81 | 128 }));
  assert.strictEqual(reg.vehicles()[0].armed, true);
});

test('position/status messages enrich but never discover (#46)', () => {
  const clock = makeClock();
  const reg = new VehicleRegistry({ now: clock.now });
  const gpi = {
    name: 'GLOBAL_POSITION_INT',
    sysid: 1,
    compid: 1,
    fields: { lat: 391000000, lon: -751000000, alt: 40000, relative_alt: 35000, hdg: 9000 }
  };
  // Unknown source: ignored, no typeless ghost entry.
  assert.strictEqual(reg.ingest(gpi).vehicle, null);
  assert.strictEqual(reg.size, 0);

  reg.ingest(heartbeat(1));
  reg.ingest(gpi);
  reg.ingest({ name: 'LOCAL_POSITION_NED', sysid: 1, compid: 1, fields: { x: 1.5, y: -2, z: -10 } });
  reg.ingest({ name: 'SYS_STATUS', sysid: 1, compid: 1, fields: { voltage_battery: 12600, battery_remaining: 88 } });
  const [v] = reg.vehicles();
  assert.deepStrictEqual(v.position, { lat: 39.1, lon: -75.1, alt: 40, relative_alt: 35, heading: 90 });
  assert.deepStrictEqual(v.localPosition, { x: 1.5, y: -2, z: -10 });
  assert.deepStrictEqual(v.battery, { voltage: 12.6, remaining: 88 });
});

test('GCS heartbeats are ignored unless includeGcs (#46)', () => {
  const reg = new VehicleRegistry({ now: makeClock().now });
  reg.ingest(heartbeat(255, { type: 6, autopilot: 8 }));
  assert.strictEqual(reg.size, 0);
  const gcsReg = new VehicleRegistry({ now: makeClock().now, includeGcs: true });
  gcsReg.ingest(heartbeat(255, { type: 6, autopilot: 8 }));
  assert.strictEqual(gcsReg.size, 1);
});

test('vehicles go stale after staleMs and expire after expireMs (#46)', () => {
  const clock = makeClock();
  const reg = new VehicleRegistry({ staleMs: 1000, expireMs: 5000, now: clock.now });
  reg.ingest(heartbeat(1));
  clock.advance(1500);
  const [v] = reg.vehicles();
  assert.strictEqual(v.stale, true);
  assert.strictEqual(reg.vehicles({ includeStale: false }).length, 0);
  clock.advance(4000); // 5500 since last message
  assert.strictEqual(reg.vehicles().length, 0);
});

test('filters select by sysids, type, and armed state (#46)', () => {
  const reg = new VehicleRegistry({ enums: ENUMS, dialect: ARDU_BUNDLE.name, now: makeClock().now });
  reg.ingest(heartbeat(1)); // quad, disarmed
  reg.ingest(heartbeat(2, { base_mode: 81 | 128 })); // quad, armed
  reg.ingest(heartbeat(3, { type: 10 })); // rover
  assert.deepStrictEqual(reg.sysids({ type: 'MAV_TYPE_QUADROTOR' }), [1, 2]);
  assert.deepStrictEqual(reg.sysids({ type: 10 }), [3]);
  assert.deepStrictEqual(reg.sysids({ armed: true }), [2]);
  assert.deepStrictEqual(reg.sysids({ sysids: [1, 3] }), [1, 3]);
});

test('sysids filter accepts arrays, single ids, and comma strings; rejects garbage (#46)', () => {
  const reg = new VehicleRegistry({ now: makeClock().now });
  reg.ingest(heartbeat(1));
  reg.ingest(heartbeat(2));
  reg.ingest(heartbeat(3));
  assert.deepStrictEqual(reg.sysids({ sysids: 2 }), [2]);
  assert.deepStrictEqual(reg.sysids({ sysids: '1, 3' }), [1, 3]);
  // A malformed filter must throw, not silently select every vehicle.
  const isBad = (err) => err.code === 'BAD_FILTER';
  assert.throws(() => reg.sysids({ sysids: { nope: true } }), isBad);
  assert.throws(() => reg.sysids({ sysids: 'one,two' }), isBad);
  assert.throws(() => reg.sysids({ sysids: [] }), isBad);
});

test('named groups resolve to vehicles: sysid lists and filters (#46)', () => {
  const reg = new VehicleRegistry({ enums: ENUMS, dialect: ARDU_BUNDLE.name, now: makeClock().now });
  reg.setGroups({
    scouts: [1, 2],
    rovers: { type: 'MAV_TYPE_GROUND_ROVER' }
  });
  reg.ingest(heartbeat(1));
  reg.ingest(heartbeat(2));
  reg.ingest(heartbeat(3, { type: 10 }));
  assert.deepStrictEqual(reg.sysids({ group: 'scouts' }), [1, 2]);
  assert.deepStrictEqual(reg.sysids({ group: 'rovers' }), [3]);
  // Unknown group targets nobody rather than everybody.
  assert.deepStrictEqual(reg.sysids({ group: 'nope' }), []);
});

test('one system with several heartbeating components is tracked per compid (#46)', () => {
  const reg = new VehicleRegistry({ now: makeClock().now });
  reg.ingest(heartbeat(1));
  reg.ingest({ name: 'HEARTBEAT', sysid: 1, compid: 100, fields: { type: 30, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 } });
  assert.strictEqual(reg.vehicles().length, 2);
  assert.deepStrictEqual(reg.sysids(), [1]); // sysids stay unique for fan-out
});

/**
 * VTOL variants (types 19-25), dodecarotor (29), and decarotor (35) were absent
 * from TYPE_VEHICLE, so those heartbeats produced mode: null (#155). VTOLs fly
 * ArduPlane modes (custom_mode 15 = plane GUIDED); dodeca/deca fly copter modes
 * (custom_mode 4 = copter GUIDED).
 */
test('VTOL and high-rotor vehicle types resolve mode names in snapshots (#155)', () => {
  const reg = new VehicleRegistry({ enums: ENUMS, dialect: ARDU_BUNDLE.name, now: makeClock().now });
  reg.ingest(heartbeat(20, { type: 20, custom_mode: 15 }));
  reg.ingest(heartbeat(29, { type: 29, custom_mode: 4 }));
  reg.ingest(heartbeat(35, { type: 35, custom_mode: 4 }));
  const modes = Object.fromEntries(reg.vehicles().map((v) => [v.sysid, v.mode]));
  assert.strictEqual(modes[20], 'GUIDED');
  assert.strictEqual(modes[29], 'GUIDED');
  assert.strictEqual(modes[35], 'GUIDED');
});
