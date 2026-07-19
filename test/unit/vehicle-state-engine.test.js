'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { VehicleStateEngine } = require('../../lib/state/vehicle-state');

/** A controllable clock so staleness is deterministic. */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function heartbeat(fields) {
  return { name: 'HEARTBEAT', sysid: 1, compid: 1, fields };
}

test('HEARTBEAT from the autopilot fills identity, armed, and mode, keyed per sysid', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  const res = engine.ingest(
    heartbeat({ type: 2, autopilot: 3, base_mode: 128 | 1, custom_mode: 0, system_status: 4 })
  );
  assert.strictEqual(res.sysid, 1);

  const s = engine.snapshot(1);
  assert.strictEqual(s.contract, 'vehicle-state/1');
  assert.strictEqual(s.sysid, 1);
  assert.strictEqual(s.connected, true);
  assert.strictEqual(s.autopilot_seen, true);
  assert.strictEqual(s.identity.type, 2);
  assert.strictEqual(s.identity.autopilot, 3);
  assert.strictEqual(s.armed, true);
  /** ArduCopter (firmware ardupilot, type copter) custom_mode 0 = STABILIZE. */
  assert.strictEqual(s.mode.custom_mode, 0);
  assert.strictEqual(s.mode.name, 'STABILIZE');
});

test('a non-autopilot component is presence-only and does not own flight state', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  /** Only a camera (compid 100) has been heard — no autopilot yet. */
  engine.ingest({ name: 'HEARTBEAT', sysid: 4, compid: 100, fields: { type: 30, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 3 } });
  const s = engine.snapshot(4);
  assert.strictEqual(s.autopilot_seen, false);
  assert.strictEqual(s.armed, null, 'no autopilot: flight state absent');
  assert.strictEqual(s.identity, null);
  assert.strictEqual(s.components.length, 1);
  assert.strictEqual(s.components[0].compid, 100);
});

test('connected flips false once the heartbeat ages past staleMs', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ staleMs: 5000, now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  assert.strictEqual(engine.snapshot(1).connected, true);
  c.advance(6000);
  assert.strictEqual(engine.snapshot(1).connected, false);
});

test('ingest returns null for a payload with no numeric sysid', () => {
  const engine = new VehicleStateEngine();
  assert.strictEqual(engine.ingest({ name: 'STATUSTEXT', fields: { text: 'x' } }), null);
});

test('ingest rejects null/blank/non-numeric sysid and creates no phantom vehicle', () => {
  const engine = new VehicleStateEngine();
  assert.strictEqual(engine.ingest({ name: 'HEARTBEAT', sysid: '', compid: 1, fields: {} }), null);
  assert.strictEqual(engine.ingest({ name: 'HEARTBEAT', sysid: null, compid: 1, fields: {} }), null);
  assert.strictEqual(engine.ingest({ name: 'HEARTBEAT', sysid: 'x', compid: 1, fields: {} }), null);
  assert.strictEqual(engine.ingest({ name: 'HEARTBEAT', compid: 1, fields: {} }), null);
  assert.deepStrictEqual(
    engine.sysids(),
    [],
    'Number(null)/Number("") coerce to 0, which used to create a phantom sysid-0 vehicle'
  );
});

test('position, home, and gps sections decode units and carry independent staleness', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ staleMs: 5000, now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: { lat: 371234567, lon: -1221234567, alt: 100000, relative_alt: 30000 } });
  engine.ingest({ name: 'HOME_POSITION', sysid: 1, compid: 1, fields: { latitude: 371200000, longitude: -1221200000, altitude: 95000 } });
  engine.ingest({ name: 'GPS_RAW_INT', sysid: 1, compid: 1, fields: { fix_type: 3, satellites_visible: 12, eph: 120, epv: 200 } });

  const s = engine.snapshot(1);
  assert.ok(Math.abs(s.position.lat - 37.1234567) < 1e-6);
  assert.ok(Math.abs(s.position.lon - -122.1234567) < 1e-6);
  assert.strictEqual(s.position.alt_amsl_m, 100);
  assert.strictEqual(s.position.alt_rel_m, 30);
  assert.ok(Math.abs(s.home.lat - 37.12) < 1e-6);
  assert.strictEqual(s.home.alt_amsl_m, 95);
  assert.strictEqual(s.gps.fix_type, 3);
  assert.strictEqual(s.gps.satellites, 12);
  assert.strictEqual(s.gps.eph_m, 1.2);
  assert.strictEqual(s.gps.epv_m, 2.0);

  /** A fresh heartbeat 6 s later must NOT refresh position — it goes stale. */
  c.advance(6000);
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  const s2 = engine.snapshot(1);
  assert.strictEqual(s2.connected, true, 'heartbeat is fresh');
  assert.strictEqual(s2.position.stale, true, 'but position is stale');
});

test('gps sentinels (eph/epv 65535, satellites 255) become null', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'GPS_RAW_INT', sysid: 1, compid: 1, fields: { fix_type: 0, satellites_visible: 255, eph: 65535, epv: 65535 } });
  const s = engine.snapshot(1);
  assert.strictEqual(s.gps.satellites, null);
  assert.strictEqual(s.gps.eph_m, null);
  assert.strictEqual(s.gps.epv_m, null);
});

test('home is absent until HOME_POSITION arrives (no position substitution)', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: { lat: 371234567, lon: -1221234567, alt: 100000, relative_alt: 30000 } });
  assert.strictEqual(engine.snapshot(1).home, null);
});

test('battery decodes voltage/current/remaining and nulls the -1 sentinels', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 0, voltages: [12600, 65535], current_battery: 1500, battery_remaining: 87 } });
  let s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries[0].voltage_v, 12.6);
  assert.strictEqual(s.battery.batteries[0].current_a, 15);
  assert.strictEqual(s.battery.batteries[0].remaining_pct, 87);

  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 0, voltages: [65535], current_battery: -1, battery_remaining: -1 } });
  s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries[0].voltage_v, null);
  assert.strictEqual(s.battery.batteries[0].current_a, null);
  assert.strictEqual(s.battery.batteries[0].remaining_pct, null);
});

test('per-cell BATTERY_STATUS voltages sum to the pack total', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  /** A 3S smart battery reporting per-cell mV with UINT16_MAX padding. */
  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 0, voltages: [4200, 4200, 4200, 65535, 65535, 65535, 65535, 65535, 65535, 65535], current_battery: -1, battery_remaining: 90 } });
  const s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries[0].voltage_v, 12.6, 'three 4.2 V cells sum to 12.6 V, not just cell 0');
});

test('an all-zero/zero-padded BATTERY_STATUS voltage array reports null, not 0 V', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 0, voltages: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], current_battery: -1, battery_remaining: -1 } });
  let s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries[0].voltage_v, null, 'no live cell → null, not a phantom 0 V critical reading');
  /** Zero-padding after real cells must not corrupt the sum. */
  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 0, voltages: [4200, 4200, 4200, 0, 0, 0, 0, 0, 0, 0], current_battery: -1, battery_remaining: 90 } });
  s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries[0].voltage_v, 12.6, 'zero padding after real cells contributes nothing');
});

test('a second battery with a different id appends rather than overwriting', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 0, voltages: [12600], current_battery: -1, battery_remaining: 80 } });
  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 1, voltages: [11800], current_battery: -1, battery_remaining: 60 } });
  const s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries.length, 2);
  assert.strictEqual(s.battery.batteries.find((b) => b.id === 1).remaining_pct, 60);
});

test('SYS_STATUS voltage is a fallback battery reading when BATTERY_STATUS is absent', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({
    name: 'SYS_STATUS',
    sysid: 1,
    compid: 1,
    fields: {
      onboard_control_sensors_present: 0x1,
      onboard_control_sensors_enabled: 0x1,
      onboard_control_sensors_health: 0x1,
      voltage_battery: 12300,
      current_battery: 800,
      battery_remaining: 77
    }
  });
  const s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries.length, 1);
  assert.strictEqual(s.battery.batteries[0].id, 0);
  assert.strictEqual(s.battery.batteries[0].voltage_v, 12.3);
  assert.strictEqual(s.battery.batteries[0].current_a, 8);
  assert.strictEqual(s.battery.batteries[0].remaining_pct, 77);
});

test('once BATTERY_STATUS has been seen, it takes precedence over the SYS_STATUS fallback', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'BATTERY_STATUS', sysid: 1, compid: 1, fields: { id: 0, voltages: [12600], current_battery: 1500, battery_remaining: 87 } });
  engine.ingest({
    name: 'SYS_STATUS',
    sysid: 1,
    compid: 1,
    fields: {
      onboard_control_sensors_present: 0x1,
      onboard_control_sensors_enabled: 0x1,
      onboard_control_sensors_health: 0x1,
      voltage_battery: 9900,
      current_battery: 100,
      battery_remaining: 10
    }
  });
  const s = engine.snapshot(1);
  assert.strictEqual(s.battery.batteries.length, 1, 'SYS_STATUS does not append a second entry');
  assert.strictEqual(s.battery.batteries[0].voltage_v, 12.6, 'BATTERY_STATUS reading is untouched by SYS_STATUS');
  assert.strictEqual(s.battery.batteries[0].remaining_pct, 87);
});

test('SYS_STATUS decodes per-sensor present/enabled/healthy flags', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  /** bit 0 (0x1) = MAV_SYS_STATUS_SENSOR_3D_GYRO. Present+enabled, unhealthy. */
  engine.ingest({ name: 'SYS_STATUS', sysid: 1, compid: 1, fields: { onboard_control_sensors_present: 0x1, onboard_control_sensors_enabled: 0x1, onboard_control_sensors_health: 0x0 } });
  const s = engine.snapshot(1);
  const gyro = s.health.sensors.find((x) => x.bit === 0);
  assert.strictEqual(gyro.present, true);
  assert.strictEqual(gyro.enabled, true);
  assert.strictEqual(gyro.healthy, false);
});

test('the health section carries its own staleness while heartbeats continue', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ staleMs: 5000, now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'SYS_STATUS', sysid: 1, compid: 1, fields: { onboard_control_sensors_present: 0x1, onboard_control_sensors_enabled: 0x1, onboard_control_sensors_health: 0x1 } });
  assert.strictEqual(engine.snapshot(1).health.stale, false, 'fresh SYS_STATUS is not stale');
  /** A fresh heartbeat 6 s later must NOT refresh the health section. */
  c.advance(6000);
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  const s = engine.snapshot(1);
  assert.strictEqual(s.connected, true, 'heartbeat is fresh');
  assert.strictEqual(s.health.stale, true, 'but sensor health has gone stale');
});

test('EXTENDED_SYS_STATE sets the landed state', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  assert.strictEqual(engine.snapshot(1).landed.state, 'unknown');
  engine.ingest({ name: 'EXTENDED_SYS_STATE', sysid: 1, compid: 1, fields: { landed_state: 2 } });
  assert.strictEqual(engine.snapshot(1).landed.state, 'in_air');
});

test('statustext keeps a capped newest-last ring with severity names', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ statustextBuffer: 2, now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'STATUSTEXT', sysid: 1, compid: 1, fields: { severity: 6, text: 'first' } });
  engine.ingest({ name: 'STATUSTEXT', sysid: 1, compid: 1, fields: { severity: 4, text: 'second' } });
  engine.ingest({ name: 'STATUSTEXT', sysid: 1, compid: 1, fields: { severity: 2, text: 'third' } });
  const s = engine.snapshot(1);
  assert.strictEqual(s.statustext.length, 2, 'ring capped at 2');
  assert.strictEqual(s.statustext[0].text, 'second');
  assert.strictEqual(s.statustext[1].text, 'third');
  assert.strictEqual(s.statustext[1].severity, 2);
});

test('a component is marked stale once it stops heartbeating', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ staleMs: 5000, now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  engine.ingest({ name: 'HEARTBEAT', sysid: 1, compid: 100, fields: { type: 30, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 3 } });
  c.advance(6000);
  /** Refresh only the autopilot; the camera goes stale. */
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  const cam = engine.snapshot(1).components.find((x) => x.compid === 100);
  assert.strictEqual(cam.stale, true);
});
