'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { diffVehicleState } = require('../../lib/state/vehicle-state');

function snap(over = {}) {
  return Object.assign(
    {
      sysid: 1,
      connected: true,
      armed: false,
      mode: { name: 'STABILIZE' },
      landed: { state: 'on_ground' },
      gps: { fix_type: 3 },
      home: null,
      components: [{ compid: 1 }],
      health: { sensors: [{ bit: 0, name: 'GYRO', healthy: true }] }
    },
    over
  );
}

test('first snapshot (prev null) emits connected but no spurious edges', () => {
  const events = diffVehicleState(null, snap(), 5000);
  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes('connected'));
  assert.ok(!kinds.includes('disarmed'), 'no edge for an unchanged-from-nothing field');
  for (const spurious of ['mode_change', 'landed_change', 'gps_fix_change', 'component_appeared', 'home_set', 'armed', 'disarmed']) {
    assert.ok(!kinds.includes(spurious), `first snapshot must not emit ${spurious}`);
  }
  assert.strictEqual(kinds.length, 1, 'first snapshot emits exactly one event (connected)');
});

test('arming, mode, landed, gps, and home edges fire once on change', () => {
  const prev = snap();
  const next = snap({
    armed: true,
    mode: { name: 'GUIDED' },
    landed: { state: 'in_air' },
    gps: { fix_type: 4 },
    home: { lat: 1, lon: 2 }
  });
  const events = diffVehicleState(prev, next, 6000);
  const byKind = Object.fromEntries(events.map((e) => [e.event, e]));
  assert.strictEqual(byKind.armed.to, true);
  assert.strictEqual(byKind.mode_change.from, 'STABILIZE');
  assert.strictEqual(byKind.mode_change.to, 'GUIDED');
  assert.strictEqual(byKind.landed_change.to, 'in_air');
  assert.strictEqual(byKind.gps_fix_change.to, 4);
  assert.strictEqual(byKind.home_set.at, 6000);
});

test('identical snapshots produce no events', () => {
  assert.deepStrictEqual(diffVehicleState(snap(), snap(), 1), []);
});

test('component appearance/loss and sensor health flips are edges', () => {
  const prev = snap({ components: [{ compid: 1 }] });
  const next = snap({ components: [{ compid: 1 }, { compid: 100 }] });
  let events = diffVehicleState(prev, next, 1);
  assert.ok(events.some((e) => e.event === 'component_appeared' && e.to === 100));
  events = diffVehicleState(next, prev, 1);
  assert.ok(events.some((e) => e.event === 'component_lost' && e.from === 100));

  const sick = snap({ health: { sensors: [{ bit: 0, name: 'GYRO', healthy: false }] } });
  events = diffVehicleState(snap(), sick, 1);
  const h = events.find((e) => e.event === 'sensor_health_change');
  assert.strictEqual(h.to.healthy, false);
  assert.strictEqual(h.to.name, 'GYRO');
});

test('an autopilot appearing on an already-known vehicle emits armed/disarmed (no null-guard suppression)', () => {
  /**
   * prev is non-null (the vehicle was already known from a non-autopilot
   * component), but no autopilot had been seen yet, so armed was null. Once
   * the autopilot HEARTBEAT arrives, armed flips null -> false and must
   * still edge-trigger a 'disarmed' event — the pArmed !== null guard used
   * to wrongly suppress this legitimate transition.
   */
  const prev = snap({ armed: null });
  const next = snap({ armed: false });
  const events = diffVehicleState(prev, next, 1);
  assert.ok(
    events.some((e) => e.event === 'disarmed' && e.from === null && e.to === false),
    'null -> false armed transition on an already-known vehicle fires disarmed'
  );
});

test('a component going stale fires component_lost, and reappearing fires component_appeared', () => {
  const prev = snap({ components: [{ compid: 1 }, { compid: 100 }] });
  const next = snap({ components: [{ compid: 1 }, { compid: 100, stale: true }] });
  const events = diffVehicleState(prev, next, 1);
  assert.ok(
    events.some((e) => e.event === 'component_lost' && e.from === 100),
    'a component marked stale (not removed) still fires component_lost'
  );

  const reappeared = snap({ components: [{ compid: 1 }, { compid: 100 }] });
  const events2 = diffVehicleState(next, reappeared, 1);
  assert.ok(
    events2.some((e) => e.event === 'component_appeared' && e.to === 100),
    'a component going non-stale again fires component_appeared'
  );
});
