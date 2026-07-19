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
  assert.strictEqual(typeof s.mode.name, 'string');
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
