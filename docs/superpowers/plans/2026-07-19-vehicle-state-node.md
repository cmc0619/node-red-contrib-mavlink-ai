# Vehicle State Node (PR A, #208) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-class `mavlink-ai-vehicle-state` node backed by a pure `VehicleStateEngine`, so flows consume a versioned per-vehicle state contract (connected, armed, mode, landed, position, home, GPS, battery, health, components, statustext) instead of rebuilding it in Function nodes.

**Architecture:** A pure engine (`lib/state/vehicle-state.js`, no Node-RED types) ingests decoded §14.1 payloads and produces per-sysid snapshots with independent per-section staleness; a pure `diffVehicleState` computes edge transitions. The node owns the connection subscription, emits transitions / snapshots / statustext on three outputs, and merges capabilities from the connection's #233 cache. This mirrors the existing `lib/swarm/vehicle-registry.js` + `nodes/mavlink-ai-swarm.js` split.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, Node-RED runtime API, existing helpers `lib/protocol/enum-resolver`, `lib/command/flight-modes`, `lib/util/geo`, `lib/util/status`.

## Global Constraints

- Node engine floor: `node>=20` (package.json `engines`).
- Pure lib modules use CommonJS, no Node-RED imports, injectable clock via `opts.now` (default `Date.now`) — copy the `lib/swarm/vehicle-registry.js` pattern.
- Every emitted payload carries `contract: 'vehicle-state/1'`.
- No back-compat shims / cross-version fallbacks (AGENTS.md rule 7) — this is new code.
- Absent sections are `null`, never zero-filled; sentinel wire values actually used by the 8 ingested messages become `null`, not the raw sentinel: GPS `eph`/`epv`/`satellites_visible` = `UINT16_MAX`/255, and battery `voltage`/`current_battery`/`battery_remaining` = `UINT16_MAX`/`-1`. (GLOBAL_POSITION_INT's `lat`/`lon`/`alt` have no `INT32_MAX` sentinel in the wire spec, so no `INT32_MAX` handling is needed or present.) **Sole carve-out (`landed`):** `landed` is always present as `{ state, state_name }` with `state: 'unknown'` until `EXTENDED_SYS_STATE` is seen — ArduPilot never sends that message, so a `null` there would be permanent and indistinguishable from "not wired up," whereas the `'unknown'` sentinel reads correctly. This is the deliberate, documented exception to the null rule (spec §sections table).
- A fresh HEARTBEAT never refreshes another section's `updated_at` or clears its `stale`.
- Flight state (armed/mode/landed/position/home/gps/battery/health) is taken **only** from the autopilot component `MAV_COMP_ID_AUTOPILOT1` (compid 1); other components are presence-only.
- Commit messages end with the two trailers used across this repo:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01AGvcgezJ7MzUZktY8AJ7gv`.
- Run `git config user.email noreply@anthropic.com && git config user.name Claude` once in the worktree before the first commit.

---

### Task 1: Engine scaffold — keying, HEARTBEAT, identity/armed/mode, component presence

**Files:**
- Create: `lib/state/vehicle-state.js`
- Test: `test/unit/vehicle-state-engine.test.js`

**Interfaces:**
- Consumes: `lib/protocol/enum-resolver` (`nameFor(index, enumName, value)`), `lib/command/flight-modes` (`modeNameForCustomMode(firmware, vehicleType, customMode)`).
- Produces:
  - `class VehicleStateEngine`
  - `new VehicleStateEngine({ staleMs = 5000, statustextBuffer = 20, enums = null, now = Date.now })`
  - `engine.ingest(payload) → { sysid: number } | null` (null when payload has no numeric `sysid`)
  - `engine.snapshot(sysid) → object | null`
  - `engine.snapshots() → object[]`
  - `engine.sysids() → number[]`
  - Snapshot shape (contract `vehicle-state/1`), sections filled by later tasks: `{ sysid, connected, autopilot_seen, contract, identity, armed, mode, landed, position, home, gps, battery, health, components, statustext }`.
  - Constants: `MAV_COMP_ID_AUTOPILOT1 = 1`, `MAV_MODE_FLAG_SAFETY_ARMED = 128`.
- Module exports: `{ VehicleStateEngine, diffVehicleState }` (`diffVehicleState` added in Task 5; export it as a stub `() => []` now so requires don't break, replaced in Task 5).

- [ ] **Step 1: Write the failing test**

Create `test/unit/vehicle-state-engine.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: FAIL — `Cannot find module '../../lib/state/vehicle-state'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/state/vehicle-state.js`:

```js
'use strict';

const enumResolver = require('../protocol/enum-resolver');
const { modeNameForCustomMode } = require('../command/flight-modes');

/** The autopilot component owns flight state; other components are presence-only. */
const MAV_COMP_ID_AUTOPILOT1 = 1;
/** HEARTBEAT base_mode flag: motors armed. */
const MAV_MODE_FLAG_SAFETY_ARMED = 128;

// MAV_AUTOPILOT -> profile firmware key, for HEARTBEAT-driven mode naming.
const AUTOPILOT_FIRMWARE = { 3: 'ardupilot', 12: 'px4' };
// MAV_TYPE -> ArduPilot mode-table key (see flight-modes.js).
const TYPE_VEHICLE = {
  1: 'plane', 2: 'copter', 3: 'copter', 4: 'copter', 5: 'antenna-tracker',
  10: 'rover', 11: 'boat', 12: 'sub', 13: 'copter', 14: 'copter', 15: 'copter',
  19: 'plane', 20: 'plane', 21: 'plane', 22: 'plane', 23: 'plane', 24: 'plane',
  25: 'plane', 29: 'copter', 35: 'copter'
};

/**
 * Pure per-vehicle MAVLink state (issue #208). The node feeds decoded §14.1
 * payloads into {@link VehicleStateEngine#ingest} and reads snapshots; the
 * engine has no Node-RED, transport, or connection dependency.
 */
class VehicleStateEngine {
  /**
   * @param {object} [opts]
   * @param {number} [opts.staleMs=5000]        per-section freshness window
   * @param {number} [opts.statustextBuffer=20] STATUSTEXT ring size
   * @param {?object} [opts.enums]              dialect enum index (readable names)
   * @param {function(): number} [opts.now]     injectable clock
   */
  constructor(opts = {}) {
    this.staleMs = opts.staleMs || 5000;
    this.statustextBuffer = opts.statustextBuffer || 20;
    this.enums = opts.enums || null;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    /** sysid -> internal vehicle record. */
    this._vehicles = new Map();
  }

  /**
   * @param {object} payload  decoded §14.1 payload ({ name, sysid, compid, fields })
   * @returns {?{sysid: number}}
   */
  ingest(payload) {
    const sysid = Number(payload && payload.sysid);
    if (!Number.isFinite(sysid)) {
      return null;
    }
    const v = this._vehicleFor(sysid);
    if (payload.name === 'HEARTBEAT') {
      this._ingestHeartbeat(v, payload);
    }
    return { sysid };
  }

  /** @param {number} sysid @returns {object} internal record (created on demand) */
  _vehicleFor(sysid) {
    let v = this._vehicles.get(sysid);
    if (!v) {
      v = { sysid, components: new Map(), autopilot: null, statustext: [] };
      this._vehicles.set(sysid, v);
    }
    return v;
  }

  /** @param {object} v @param {object} payload */
  _ingestHeartbeat(v, payload) {
    const f = payload.fields || {};
    const compid = Number(payload.compid);
    v.components.set(compid, {
      compid,
      type: f.type,
      autopilot: f.autopilot,
      system_status: f.system_status,
      last_seen: this._now()
    });
    if (compid === MAV_COMP_ID_AUTOPILOT1) {
      v.autopilot = {
        type: f.type,
        autopilot: f.autopilot,
        base_mode: f.base_mode,
        custom_mode: f.custom_mode,
        system_status: f.system_status,
        last_heartbeat: this._now()
      };
    }
  }

  /** @param {number} sysid @returns {?object} */
  snapshot(sysid) {
    const v = this._vehicles.get(sysid);
    return v ? this._snapshot(v) : null;
  }

  /** @returns {object[]} */
  snapshots() {
    return [...this._vehicles.values()].map((v) => this._snapshot(v));
  }

  /** @returns {number[]} */
  sysids() {
    return [...this._vehicles.keys()];
  }

  /** @param {object} v @returns {object} the vehicle-state/1 snapshot */
  _snapshot(v) {
    const now = this._now();
    const ap = v.autopilot;
    const connected = !!ap && now - ap.last_heartbeat <= this.staleMs;
    const firmware = ap ? AUTOPILOT_FIRMWARE[ap.autopilot] : undefined;
    const vehicleType = ap ? TYPE_VEHICLE[ap.type] : undefined;
    return {
      sysid: v.sysid,
      contract: 'vehicle-state/1',
      connected,
      autopilot_seen: !!ap,
      identity: ap
        ? {
            type: ap.type,
            type_name: this._enumName('MavType', ap.type),
            autopilot: ap.autopilot,
            autopilot_name: this._enumName('MavAutopilot', ap.autopilot)
          }
        : null,
      armed: ap ? (ap.base_mode & MAV_MODE_FLAG_SAFETY_ARMED) === MAV_MODE_FLAG_SAFETY_ARMED : null,
      mode: ap
        ? {
            name:
              firmware !== undefined && ap.custom_mode !== undefined
                ? modeNameForCustomMode(firmware, vehicleType, ap.custom_mode)
                : null,
            base_mode: ap.base_mode,
            custom_mode: ap.custom_mode
          }
        : null,
      landed: { state: 'unknown', state_name: null },
      position: null,
      home: null,
      gps: null,
      battery: null,
      health: null,
      components: [...v.components.values()].map((c) => ({ ...c })),
      statustext: v.statustext.map((e) => ({ ...e }))
    };
  }

  /** @param {string} enumName @param {number} value @returns {?string} */
  _enumName(enumName, value) {
    if (!this.enums || value === undefined) {
      return null;
    }
    return enumResolver.nameFor(this.enums, enumName, value) || null;
  }
}

/** Replaced with the real diff in Task 5. */
function diffVehicleState() {
  return [];
}

module.exports = { VehicleStateEngine, diffVehicleState };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/vehicle-state.js test/unit/vehicle-state-engine.test.js
git commit -m "Vehicle state engine: keying, heartbeat identity/armed/mode, component presence (#208)"
```

---

### Task 2: Position, home, and GPS sections with sentinel handling

**Files:**
- Modify: `lib/state/vehicle-state.js`
- Test: `test/unit/vehicle-state-engine.test.js`

**Interfaces:**
- Consumes: Task 1 engine; `lib/util/geo` (`degE7ToDeg(degE7)`).
- Produces (snapshot sections, autopilot-owned):
  - `position: { lat, lon, alt_amsl_m, alt_rel_m, updated_at, stale } | null` from GLOBAL_POSITION_INT
  - `home: { lat, lon, alt_amsl_m, updated_at } | null` from HOME_POSITION only
  - `gps: { fix_type, fix_type_name, satellites, eph_m, epv_m, updated_at, stale } | null` from GPS_RAW_INT (`eph`/`epv` = 65535 → `null`; `satellites_visible` = 255 → `null`)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/vehicle-state-engine.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: FAIL — `s.position` is `null` (`Cannot read properties of null`).

- [ ] **Step 3: Write minimal implementation**

In `lib/state/vehicle-state.js`, add the geo import near the top:

```js
const { degE7ToDeg } = require('../util/geo');
```

Add a sentinel helper above the class:

```js
/**
 * Map a wire sentinel (a value meaning "unavailable") to null, else return the
 * value. GPS eph/epv use 65535; satellites_visible uses 255.
 *
 * @param {number} value
 * @param {number} sentinel
 * @returns {?number}
 */
function nullIfSentinel(value, sentinel) {
  return value === sentinel || value === undefined ? null : value;
}
```

In `ingest()`, extend the dispatch (after the HEARTBEAT branch):

```js
    } else if (payload.name === 'GLOBAL_POSITION_INT' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.position = {
        lat: degE7ToDeg(f.lat),
        lon: degE7ToDeg(f.lon),
        alt_amsl_m: f.alt / 1000,
        alt_rel_m: f.relative_alt / 1000,
        updated_at: this._now()
      };
    } else if (payload.name === 'HOME_POSITION' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.home = {
        lat: degE7ToDeg(f.latitude),
        lon: degE7ToDeg(f.longitude),
        alt_amsl_m: f.altitude / 1000,
        updated_at: this._now()
      };
    } else if (payload.name === 'GPS_RAW_INT' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      const eph = nullIfSentinel(f.eph, 65535);
      const epv = nullIfSentinel(f.epv, 65535);
      v.gps = {
        fix_type: f.fix_type,
        satellites: nullIfSentinel(f.satellites_visible, 255),
        eph_m: eph === null ? null : eph / 100,
        epv_m: epv === null ? null : epv / 100,
        updated_at: this._now()
      };
    }
```

Change the HEARTBEAT `if` to `if (payload.name === 'HEARTBEAT') {` staying as the first branch of the same `if/else if` chain (i.e. convert the existing standalone `if` into the head of the chain).

In `_snapshot()`, replace the `position`, `home`, `gps` lines:

```js
      position: v.position
        ? { ...v.position, stale: now - v.position.updated_at > this.staleMs }
        : null,
      home: v.home ? { ...v.home } : null,
      gps: v.gps
        ? {
            fix_type: v.gps.fix_type,
            fix_type_name: this._enumName('GpsFixType', v.gps.fix_type),
            satellites: v.gps.satellites,
            eph_m: v.gps.eph_m,
            epv_m: v.gps.epv_m,
            updated_at: v.gps.updated_at,
            stale: now - v.gps.updated_at > this.staleMs
          }
        : null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/vehicle-state.js test/unit/vehicle-state-engine.test.js
git commit -m "Vehicle state engine: position/home/gps sections with sentinel handling (#208)"
```

---

### Task 3: Battery, health (sensor flags), and landed sections

**Files:**
- Modify: `lib/state/vehicle-state.js`
- Test: `test/unit/vehicle-state-engine.test.js`

**Interfaces:**
- Consumes: Task 1-2 engine.
- Produces (snapshot sections, autopilot-owned):
  - `battery: { batteries: [{ id, voltage_v, current_a, remaining_pct }], updated_at, stale } | null` from BATTERY_STATUS (sentinels: `current_battery`=-1 → `current_a: null`; `battery_remaining`=-1 → `remaining_pct: null`; `voltages[0]`=65535 → `voltage_v: null`)
  - **SYS_STATUS battery fallback (review fix):** when no BATTERY_STATUS has been seen yet for a vehicle, `battery` is populated from SYS_STATUS's own `voltage_battery` (mV), `current_battery` (cA), and `battery_remaining` (%) as a single synthetic entry `batteries: [{ id: 0, voltage_v, current_a, remaining_pct }]`, with the same sentinel→`null` mapping (`voltage_battery`=65535 → `voltage_v: null`; `current_battery`=-1 → `current_a: null`; `battery_remaining`=-1 → `remaining_pct: null`). Precedence: once a real BATTERY_STATUS message has been ingested for that vehicle, it always wins — SYS_STATUS must never overwrite the richer BATTERY_STATUS-derived reading again, even if a later SYS_STATUS arrives first. The engine tracks this with an internal `batterySource` flag (`'battery_status'` vs `'sys_status'`). Covered by an engine test asserting the SYS_STATUS-only fallback shape and that a subsequent BATTERY_STATUS takes precedence permanently.
  - `health: { sensors: [{ name, bit, present, enabled, healthy }], updated_at } | null` from SYS_STATUS `onboard_control_sensors_{present,enabled,health}`
  - `landed: { state, state_name }` from EXTENDED_SYS_STATE `landed_state` (`0`→`'unknown'`, `1`→`'on_ground'`, `2`→`'in_air'`, `3`→`'takeoff'`, `4`→`'landing'`)

- [ ] **Step 1: Write the failing test**

Append:

```js
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

test('EXTENDED_SYS_STATE sets the landed state', () => {
  const c = clock();
  const engine = new VehicleStateEngine({ now: c.now });
  engine.ingest(heartbeat({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }));
  assert.strictEqual(engine.snapshot(1).landed.state, 'unknown');
  engine.ingest({ name: 'EXTENDED_SYS_STATE', sysid: 1, compid: 1, fields: { landed_state: 2 } });
  assert.strictEqual(engine.snapshot(1).landed.state, 'in_air');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: FAIL — `s.battery` is `null`.

- [ ] **Step 3: Write minimal implementation**

Add constants above the class:

```js
const LANDED_STATE = { 0: 'unknown', 1: 'on_ground', 2: 'in_air', 3: 'takeoff', 4: 'landing' };
```

In `ingest()`'s `if/else if` chain, add branches:

```js
    } else if (payload.name === 'BATTERY_STATUS' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      const v0 = Array.isArray(f.voltages) ? f.voltages[0] : undefined;
      const entry = {
        id: f.id,
        voltage_v: nullIfSentinel(v0, 65535) === null ? null : v0 / 1000,
        current_a: nullIfSentinel(f.current_battery, -1) === null ? null : f.current_battery / 100,
        remaining_pct: nullIfSentinel(f.battery_remaining, -1)
      };
      v.battery = v.battery || { batteries: [], updated_at: this._now() };
      const idx = v.battery.batteries.findIndex((b) => b.id === entry.id);
      if (idx >= 0) {
        v.battery.batteries[idx] = entry;
      } else {
        v.battery.batteries.push(entry);
      }
      v.battery.updated_at = this._now();
    } else if (payload.name === 'SYS_STATUS' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.health = {
        present: f.onboard_control_sensors_present >>> 0,
        enabled: f.onboard_control_sensors_enabled >>> 0,
        healthy: f.onboard_control_sensors_health >>> 0,
        updated_at: this._now()
      };
    } else if (payload.name === 'EXTENDED_SYS_STATE' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.landed = f.landed_state;
    }
```

In `_snapshot()`, replace the `landed`, `battery`, `health` lines:

```js
      landed: {
        state: v.landed !== undefined ? LANDED_STATE[v.landed] || 'unknown' : 'unknown',
        state_name: v.landed !== undefined ? this._enumName('MavLandedState', v.landed) : null
      },
      battery: v.battery
        ? {
            batteries: v.battery.batteries.map((b) => ({ ...b })),
            updated_at: v.battery.updated_at,
            stale: now - v.battery.updated_at > this.staleMs
          }
        : null,
      health: v.health ? this._healthSection(v.health) : null,
```

Add the sensor-flag decoder method to the class:

```js
  /**
   * Decode the SYS_STATUS sensor bitmasks into per-sensor flags. Every bit set
   * in present/enabled/health is surfaced, named via the MavSysStatusSensor
   * enum when known, else by bit index.
   *
   * @param {object} h  { present, enabled, healthy, updated_at }
   * @returns {object}
   */
  _healthSection(h) {
    const bits = new Set();
    for (const mask of [h.present, h.enabled, h.healthy]) {
      for (let bit = 0; bit < 32; bit += 1) {
        if (mask & (1 << bit)) {
          bits.add(bit);
        }
      }
    }
    const sensors = [...bits].sort((a, b) => a - b).map((bit) => ({
      bit,
      name: this._enumName('MavSysStatusSensor', 1 << bit),
      present: (h.present & (1 << bit)) !== 0,
      enabled: (h.enabled & (1 << bit)) !== 0,
      healthy: (h.healthy & (1 << bit)) !== 0
    }));
    return { sensors, updated_at: h.updated_at };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/vehicle-state.js test/unit/vehicle-state-engine.test.js
git commit -m "Vehicle state engine: battery, sensor-health, and landed sections (#208)"
```

---

### Task 4: STATUSTEXT ring buffer + component pruning

**Files:**
- Modify: `lib/state/vehicle-state.js`
- Test: `test/unit/vehicle-state-engine.test.js`

**Interfaces:**
- Consumes: Task 1-3 engine.
- Produces:
  - `statustext: [{ severity, severity_name, text, at }]` newest-last, capped at `statustextBuffer`.
  - `components[].stale: boolean` (a component not heartbeating within `staleMs`); the autopilot component staleness already drives `connected`.

- [ ] **Step 1: Write the failing test**

Append:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: FAIL — `s.statustext` is empty and `cam.stale` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `ingest()`'s chain, add a STATUSTEXT branch (any component, not autopilot-gated — companion faults matter):

```js
    } else if (payload.name === 'STATUSTEXT') {
      const f = payload.fields || {};
      v.statustext.push({
        severity: f.severity,
        severity_name: this._enumName('MavSeverity', f.severity),
        text: typeof f.text === 'string' ? f.text : String(f.text == null ? '' : f.text),
        at: this._now()
      });
      if (v.statustext.length > this.statustextBuffer) {
        v.statustext.splice(0, v.statustext.length - this.statustextBuffer);
      }
    }
```

In `_snapshot()`, replace the `components:` line to add per-component staleness:

```js
      components: [...v.components.values()].map((c) => ({
        ...c,
        stale: now - c.last_seen > this.staleMs
      })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/vehicle-state-engine.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/vehicle-state.js test/unit/vehicle-state-engine.test.js
git commit -m "Vehicle state engine: statustext ring and component staleness (#208)"
```

---

### Task 5: `diffVehicleState` — edge-triggered transitions

**Files:**
- Modify: `lib/state/vehicle-state.js`
- Test: `test/unit/vehicle-state-diff.test.js`

**Interfaces:**
- Consumes: snapshot objects from Task 1-4.
- Produces: `diffVehicleState(prev, next) → Array<{ event, sysid, from, to, at }>`. `prev` may be `null` (first snapshot). Events, each emitted only on change:
  - `connected` / `connection_lost`
  - `armed` / `disarmed`
  - `mode_change` (`from`/`to` = mode name)
  - `landed_change` (`from`/`to` = landed state)
  - `gps_fix_change` (`from`/`to` = fix_type)
  - `home_set` (once, when home goes null→set)
  - `component_appeared` / `component_lost` (`to`/`from` = compid)
  - `sensor_health_change` (`to` = `{ name, bit, healthy }` for each sensor whose `healthy` flipped)
  - `at` = `next`'s wall clock is not available in a pure diff, so `at` is taken from the caller — signature is `diffVehicleState(prev, next, at)` where `at` is a number.

Correcting the signature: `diffVehicleState(prev, next, at) → events[]`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/vehicle-state-diff.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vehicle-state-diff.test.js`
Expected: FAIL — `diffVehicleState` returns `[]` (stub), so the assertions fail.

- [ ] **Step 3: Write minimal implementation**

Replace the stub `diffVehicleState` in `lib/state/vehicle-state.js`:

```js
/**
 * Edge-triggered transitions between two vehicle snapshots (#208). Emits an
 * event only where a tracked field changed; `prev` null means first sight.
 * Pure — the caller supplies the wall clock `at`.
 *
 * @param {?object} prev
 * @param {object} next
 * @param {number} at
 * @returns {Array<{event: string, sysid: number, from: *, to: *, at: number}>}
 */
function diffVehicleState(prev, next, at) {
  const events = [];
  const sysid = next.sysid;
  const push = (event, from, to) => events.push({ event, sysid, from, to, at });

  const pConn = prev ? prev.connected : false;
  if (pConn !== next.connected) {
    push(next.connected ? 'connected' : 'connection_lost', pConn, next.connected);
  }

  // First sight: there is no prior state to diff against, so emit only the
  // connection edge. Every other edge below requires a real previous snapshot.
  if (!prev) {
    return events;
  }

  const pArmed = prev.armed;
  if (pArmed !== next.armed && next.armed !== null) {
    push(next.armed ? 'armed' : 'disarmed', pArmed, next.armed);
  }

  const pMode = prev && prev.mode ? prev.mode.name : null;
  const nMode = next.mode ? next.mode.name : null;
  if (pMode !== nMode && nMode !== null) {
    push('mode_change', pMode, nMode);
  }

  const pLanded = prev && prev.landed ? prev.landed.state : 'unknown';
  const nLanded = next.landed ? next.landed.state : 'unknown';
  if (pLanded !== nLanded) {
    push('landed_change', pLanded, nLanded);
  }

  const pFix = prev && prev.gps ? prev.gps.fix_type : null;
  const nFix = next.gps ? next.gps.fix_type : null;
  if (pFix !== nFix && nFix !== null) {
    push('gps_fix_change', pFix, nFix);
  }

  if ((!prev || !prev.home) && next.home) {
    push('home_set', null, { lat: next.home.lat, lon: next.home.lon });
  }

  // Component sets are stale-aware: a component that is present but stale is
  // treated as "not there" for appearance/loss purposes, so a component that
  // simply goes quiet (without a fresh heartbeat marking it gone) still edges
  // to component_lost once its staleness flips, and does not spuriously
  // re-edge to component_appeared when it later refreshes.
  const prevComps = new Set((prev ? prev.components : []).filter((c) => !c.stale).map((c) => c.compid));
  const nextComps = new Set(next.components.filter((c) => !c.stale).map((c) => c.compid));
  for (const compid of nextComps) {
    if (!prevComps.has(compid)) {
      push('component_appeared', null, compid);
    }
  }
  for (const compid of prevComps) {
    if (!nextComps.has(compid)) {
      push('component_lost', compid, null);
    }
  }

  const pSensors = new Map((prev && prev.health ? prev.health.sensors : []).map((x) => [x.bit, x]));
  for (const s of next.health ? next.health.sensors : []) {
    const before = pSensors.get(s.bit);
    if (before && before.healthy !== s.healthy) {
      push('sensor_health_change', { bit: s.bit, name: s.name, healthy: before.healthy }, { bit: s.bit, name: s.name, healthy: s.healthy });
    }
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/vehicle-state-diff.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/vehicle-state.js test/unit/vehicle-state-diff.test.js
git commit -m "Vehicle state: diffVehicleState edge-triggered transitions (#208)"
```

---

### Task 6: The `mavlink-ai-vehicle-state` node

**Files:**
- Create: `nodes/mavlink-ai-vehicle-state.js`
- Create: `nodes/mavlink-ai-vehicle-state.html`
- Modify: `package.json:72` (`node-red.nodes` map — add the registration line after `"mavlink-ai-swarm"`)
- Test: `test/unit/vehicle-state-node.test.js`

**Interfaces:**
- Consumes: `VehicleStateEngine`, `diffVehicleState` from `lib/state/vehicle-state`; the connection runtime API (`subscribe({ messageNames }, cb)`, `unsubscribe(id)`, `emitter`, `profile.getDialect()`, `getVehicleCapabilities(sysid, compid)`).
- Produces: the registered node type `mavlink-ai-vehicle-state`.
- Config fields: `connection` (required), `sysids` (string, comma list, blank = all), `intervalSeconds` (number, default 0), `staleMs` (number, default 5000), `statustextBuffer` (number, default 20).
- Outputs (3): `[transitions, snapshots, statustext]`.
- Subscription messageNames (engine feed): `['HEARTBEAT','EXTENDED_SYS_STATE','SYS_STATUS','BATTERY_STATUS','GPS_RAW_INT','GLOBAL_POSITION_INT','HOME_POSITION','STATUSTEXT']` (AUTOPILOT_VERSION is NOT forwarded — capabilities come from the connection's #233 cache).

- [ ] **Step 1: Write the failing test**

Create `test/unit/vehicle-state-node.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { MockRED } = require('../helpers/mock-red');

/** Connection stand-in the node subscribes to; the test pushes decoded msgs. */
function stubConnection(RED, id) {
  const conn = {
    id,
    name: 'stub',
    emitter: new EventEmitter(),
    profile: { getDialect: () => ({ valid: false, enums: null }) },
    getVehicleCapabilities: () => undefined,
    _cbs: [],
    subscribe(filter, cb) {
      conn.lastFilter = filter;
      conn._cbs.push(cb);
      return conn._cbs.length;
    },
    unsubscribe() { return true; },
    deliver(payload) {
      for (const cb of conn._cbs) {
        cb({ topic: `mavlink/${payload.name}`, payload });
      }
    }
  };
  RED._nodes.set(id, conn);
  return conn;
}

function hb(sysid, over = {}) {
  return { name: 'HEARTBEAT', sysid, compid: 1, fields: Object.assign({ type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 }, over) };
}

function setup(config = {}) {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  const node = RED.create('mavlink-ai-vehicle-state', Object.assign({ id: 'vs1', connection: 'c1' }, config));
  return { RED, conn, node };
}

test('the node subscribes with the engine message set', (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  assert.ok(conn.lastFilter.messageNames.includes('HEARTBEAT'));
  assert.ok(conn.lastFilter.messageNames.includes('SYS_STATUS'));
  assert.ok(!conn.lastFilter.messageNames.includes('AUTOPILOT_VERSION'), 'capabilities come from the cache');
});

test('a first heartbeat emits a connected transition on output 1', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));
  const connectedMsg = seen.map((o) => o[0]).find(Boolean);
  assert.ok(connectedMsg, 'a transition went out on output 1');
  assert.strictEqual(connectedMsg.payload.event, 'connected');
  assert.strictEqual(connectedMsg.payload.sysid, 1);
});

test('an on-demand snapshot command emits per-vehicle state on output 2', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  conn.deliver(hb(1));
  const { collected } = await RED.inject(node, { command: 'snapshot' });
  const snapMsg = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(snapMsg.topic, 'vehicle/state');
  assert.strictEqual(snapMsg.payload.sysid, 1);
  assert.strictEqual(snapMsg.payload.contract, 'vehicle-state/1');
});

test('STATUSTEXT is emitted live on output 3', (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));
  conn.deliver({ name: 'STATUSTEXT', sysid: 1, compid: 1, fields: { severity: 2, text: 'BATTERY LOW' } });
  const st = seen.map((o) => o[2]).find(Boolean);
  assert.strictEqual(st.topic, 'vehicle/statustext');
  assert.strictEqual(st.payload.text, 'BATTERY LOW');
});

test('the sysid filter restricts which vehicles the node reports', (t) => {
  const { RED, conn, node } = setup({ sysids: '2' });
  t.after(() => RED.close(node));
  const seen = [];
  node.send = (outs) => seen.push(outs);
  conn.deliver(hb(1));
  assert.strictEqual(seen.length, 0, 'sysid 1 is filtered out');
  conn.deliver(hb(2));
  assert.ok(seen.map((o) => o[0]).find(Boolean), 'sysid 2 passes');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vehicle-state-node.test.js`
Expected: FAIL — `RED.create('mavlink-ai-vehicle-state', ...)` throws (type not registered).

- [ ] **Step 3: Write minimal implementation**

Create `nodes/mavlink-ai-vehicle-state.js`:

```js
'use strict';

const { VehicleStateEngine, diffVehicleState } = require('../lib/state/vehicle-state');

/** Messages the engine ingests (capabilities come from the #233 cache, not here). */
const STATE_MESSAGES = [
  'HEARTBEAT', 'EXTENDED_SYS_STATE', 'SYS_STATUS', 'BATTERY_STATUS',
  'GPS_RAW_INT', 'GLOBAL_POSITION_INT', 'HOME_POSITION', 'STATUSTEXT'
];

/** Parse a comma/space id list to a Set of numbers; blank = empty (all). */
function parseSysids(raw) {
  return new Set(
    String(raw || '')
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n))
  );
}

module.exports = function (RED) {
  function VehicleStateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const allow = parseSysids(config.sysids);
    node.staleMs = Number(config.staleMs) > 0 ? Number(config.staleMs) : 5000;
    const statustextBuffer = Number(config.statustextBuffer) > 0 ? Number(config.statustextBuffer) : 20;
    const intervalMs = Number(config.intervalSeconds) > 0 ? Number(config.intervalSeconds) * 1000 : 0;

    let engine = null;
    let lastSnapshots = new Map();
    let attachedTo;
    let subId = null;
    let onStatus = null;
    const timers = [];

    const wanted = (sysid) => allow.size === 0 || allow.has(sysid);

    function badge() {
      if (!engine) {
        return;
      }
      const snaps = engine.snapshots().filter((s) => wanted(s.sysid));
      const connected = snaps.filter((s) => s.connected).length;
      node.status({ fill: snaps.length ? 'green' : 'grey', shape: 'dot', text: `${snaps.length} vehicles · ${connected} connected` });
    }

    /** Attach capabilities from the connection's #233 cache (engine never parses it). */
    function withCaps(snap) {
      let caps = null;
      if (node.connection && typeof node.connection.getVehicleCapabilities === 'function') {
        caps = node.connection.getVehicleCapabilities(snap.sysid, 1);
      }
      return Object.assign({}, snap, { capabilities: caps === undefined ? null : caps });
    }

    function emitTransitions(sysid) {
      const next = engine.snapshot(sysid);
      if (!next || !wanted(sysid)) {
        return;
      }
      const prev = lastSnapshots.get(sysid) || null;
      const events = diffVehicleState(prev, next, Date.now());
      lastSnapshots.set(sysid, next);
      for (const ev of events) {
        node.send([{ topic: 'vehicle/transition', payload: Object.assign({ contract: 'vehicle-state/1' }, ev) }, null, null]);
      }
      badge();
    }

    function emitSnapshot(sysid) {
      const targets = sysid !== undefined ? [sysid] : engine.sysids();
      for (const id of targets) {
        const snap = engine.snapshot(id);
        if (snap && wanted(id)) {
          node.send([null, { topic: 'vehicle/state', payload: withCaps(snap) }, null]);
        }
      }
    }

    function detach() {
      if (attachedTo) {
        try {
          if (subId != null) {
            attachedTo.unsubscribe(subId);
          }
          if (onStatus) {
            attachedTo.emitter.removeListener('status', onStatus);
          }
        } catch (err) {
          node.error(`Error detaching: ${err && err.message ? err.message : err}`);
        }
      }
      attachedTo = null;
      subId = null;
      onStatus = null;
    }

    function attach() {
      const conn = RED.nodes.getNode(config.connection) || null;
      if (conn === attachedTo && conn === node.connection) {
        return;
      }
      detach();
      node.connection = conn;
      if (!node.connection) {
        node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
        return;
      }
      if (!engine) {
        const profile = node.connection.profile;
        const bundle = profile && typeof profile.getDialect === 'function' ? profile.getDialect() : null;
        engine = new VehicleStateEngine({
          staleMs: node.staleMs,
          statustextBuffer,
          enums: bundle && bundle.valid ? bundle.enums : null
        });
        node.engine = engine;
      }
      subId = node.connection.subscribe({ messageNames: STATE_MESSAGES }, (message) => {
        const res = engine.ingest(message.payload);
        if (!res) {
          return;
        }
        if (message.payload.name === 'STATUSTEXT' && wanted(res.sysid)) {
          const f = message.payload.fields || {};
          const snap = engine.snapshot(res.sysid);
          const st = snap.statustext[snap.statustext.length - 1];
          node.send([null, null, { topic: 'vehicle/statustext', payload: Object.assign({ sysid: res.sysid, contract: 'vehicle-state/1' }, st) }]);
        }
        emitTransitions(res.sysid);
      });
      onStatus = () => badge();
      node.connection.emitter.on('status', onStatus);
      badge();
      attachedTo = node.connection;
    }

    attach();
    if (RED.events && typeof RED.events.on === 'function') {
      RED.events.on('flows:started', attach);
      node.on('close', () => RED.events.removeListener('flows:started', attach));
    }
    if (intervalMs > 0) {
      const t = setInterval(() => engine && emitSnapshot(), intervalMs);
      if (typeof t.unref === 'function') {
        t.unref();
      }
      timers.push(t);
    }

    node.on('input', (msg, send, done) => {
      const command = msg.command || (msg.payload && msg.payload.command);
      if (command === 'snapshot') {
        if (engine) {
          emitSnapshot(msg.sysid !== undefined ? Number(msg.sysid) : undefined);
        }
      }
      done();
    });

    node.on('close', (removed, done) => {
      for (const t of timers) {
        clearInterval(t);
      }
      detach();
      engine = null;
      lastSnapshots = new Map();
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-vehicle-state', VehicleStateNode);
};
```

Create `nodes/mavlink-ai-vehicle-state.html`:

```html
<script type="text/javascript">
  RED.nodes.registerType('mavlink-ai-vehicle-state', {
    category: 'MAVLink AI',
    paletteLabel: 'MAVLink Vehicle State',
    color: '#B3D9FF',
    defaults: {
      name: { value: '' },
      connection: { value: '', type: 'mavlink-ai-connection', required: true },
      sysids: { value: '' },
      intervalSeconds: { value: 0, validate: RED.validators.number(true) },
      staleMs: { value: 5000, validate: RED.validators.number() },
      statustextBuffer: { value: 20, validate: RED.validators.number() }
    },
    inputs: 1,
    outputs: 3,
    outputLabels: ['transitions', 'snapshots', 'statustext'],
    icon: 'font-awesome/fa-heartbeat',
    label: function () {
      return this.name || 'mavlink ai vehicle state';
    }
  });
</script>

<script type="text/html" data-template-name="mavlink-ai-vehicle-state">
  <div class="form-row">
    <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
    <input type="text" id="node-input-name" placeholder="MAVLink Vehicle State">
  </div>
  <div class="form-row">
    <label for="node-input-connection">Connection</label>
    <input type="text" id="node-input-connection">
  </div>
  <div class="form-row">
    <label for="node-input-sysids">Sysids</label>
    <input type="text" id="node-input-sysids" placeholder="blank = all">
  </div>
  <div class="form-row">
    <label for="node-input-intervalSeconds">Snapshot (s)</label>
    <input type="number" id="node-input-intervalSeconds" placeholder="0 = on demand">
  </div>
  <div class="form-row">
    <label for="node-input-staleMs">Stale (ms)</label>
    <input type="number" id="node-input-staleMs" placeholder="5000">
  </div>
  <div class="form-row">
    <label for="node-input-statustextBuffer">Statustext</label>
    <input type="number" id="node-input-statustextBuffer" placeholder="20">
  </div>
</script>

<script type="text/html" data-help-name="mavlink-ai-vehicle-state">
  <p>Aggregates per-vehicle MAVLink state on a shared <b>MAVLink AI Connection</b> into a versioned <code>vehicle-state/1</code> contract, so flows consume state instead of raw packets.</p>
  <h3>Outputs</h3>
  <ol>
    <li><b>transitions</b> — one message per edge (connected/lost, armed/disarmed, mode, landed, GPS fix, home set, component appeared/lost, sensor health).</li>
    <li><b>snapshots</b> — full per-vehicle state on the configured interval or on a <code>{ command: "snapshot" }</code> input (optional <code>sysid</code>).</li>
    <li><b>statustext</b> — live STATUSTEXT feed with severity names.</li>
  </ol>
  <p>Each section (position, GPS, battery, health, …) carries its own freshness: a fresh HEARTBEAT never refreshes another section, and absent sections are <code>null</code>, never zero-filled. HEARTBEAT is component presence — not command delivery, setpoint freshness, sensor health, or authorization.</p>
</script>
```

Register in `package.json` — add the line after `"mavlink-ai-swarm"`:

```json
      "mavlink-ai-vehicle-state": "nodes/mavlink-ai-vehicle-state.js",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/vehicle-state-node.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add nodes/mavlink-ai-vehicle-state.js nodes/mavlink-ai-vehicle-state.html package.json test/unit/vehicle-state-node.test.js
git commit -m "mavlink-ai-vehicle-state node: subscription, three outputs, sysid filter (#208)"
```

---

### Task 7: Example rework + README + full-suite gate

**Files:**
- Modify: `examples/09-observability/21-vehicle-status-web-dashboard.json`
- Modify: `README.md` (node list + a short "Vehicle State" section)
- Test: existing `test/unit/examples.test.js` (validates every example's connection config) must stay green.

**Interfaces:**
- Consumes: the node from Task 6.

- [ ] **Step 1: Confirm the current examples test passes and inspect the dashboard example**

Run: `node --test test/unit/examples.test.js`
Expected: PASS.

Run: `grep -c '"type": "function"' examples/09-observability/21-vehicle-status-web-dashboard.json`
Expected: a nonzero count — these Function nodes rebuild vehicle state and are what the node replaces.

- [ ] **Step 2: Rework the dashboard example onto the node**

Replace the state-rebuilding Function node(s) in `examples/09-observability/21-vehicle-status-web-dashboard.json` with a `mavlink-ai-vehicle-state` node feeding the dashboard widgets from its `snapshots` output. Keep the same connection/profile/identity config nodes (so `examples.test.js` still validates them). Preserve the flow's `id`s where wiring is unchanged; wire the dashboard widgets to read `msg.payload.position`, `msg.payload.battery`, `msg.payload.gps`, etc. from the snapshot.

Minimum viable rework (one vehicle-state node + a change-node/template per widget) is acceptable — the goal is "no hand-rolled correlation in a Function node," not a visual redesign.

- [ ] **Step 3: Run the examples test to verify the reworked flow still validates**

Run: `node --test test/unit/examples.test.js`
Expected: PASS.

- [ ] **Step 4: Update README**

In `README.md`, add `mavlink-ai-vehicle-state` to the node list, and add a short section after the Swarm description:

```markdown
### Vehicle State

`mavlink-ai-vehicle-state` aggregates a connection's telemetry into a versioned
per-vehicle `vehicle-state/1` contract — connected, armed, mode, landed,
position, home, GPS, battery, sensor health, components, and recent STATUSTEXT —
with independent per-section freshness (a fresh HEARTBEAT never refreshes
position or battery). Three outputs: edge-triggered **transitions**, full
**snapshots** (interval or on-demand), and a live **statustext** feed. HEARTBEAT
is treated as component presence only, separate from setpoint freshness and
sensor health.
```

- [ ] **Step 5: Run the full suite and smoke-load**

Run: `npm test`
Expected: PASS, count = previous total + 21 new tests (12 engine + 4 diff + 5 node), 0 failures.

Run: `node -e "require('./nodes/mavlink-ai-vehicle-state.js')"`
Expected: no output, exit 0 (the module loads without a Node-RED runtime — it exports a function).

- [ ] **Step 6: Commit**

```bash
git add examples/09-observability/21-vehicle-status-web-dashboard.json README.md
git commit -m "Rework the vehicle-status dashboard onto the vehicle-state node; document it (#208)"
```

---

## Self-Review Notes

- **Spec coverage:** engine message set (T1-4), per-sysid keying + autopilot ownership + component presence (T1), independent per-section staleness (T2-4), home from HOME_POSITION only (T2), sentinels→null (T2-3), sensor-flag decode (T3), statustext ring (T4), capabilities from #233 cache via the node (T6), contract versioning (T1), three outputs + config + sysid filter + teardown (T6), example rework + README (T7). #205's flow-facing lifecycle events and #225's health input are explicitly out of this PR (PR B / deferred).
- **Type consistency:** `diffVehicleState(prev, next, at)` signature is consistent between its definition (T5) and its two call sites (T6 `emitTransitions`); snapshot section names (`position/home/gps/battery/health/landed/components/statustext`) are identical across T1's shell, T2-4's fills, T5's diff reads, and T6's emit.
- **Post-merge:** after PR A merges, PR B (#225) extends this node's input with health assertions and adds the connection advertised-health store + onboard-companion preset, per the spec.
