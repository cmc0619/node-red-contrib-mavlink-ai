# Health-Aware Heartbeat & Onboard-Companion Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a flow advertise the health of its own onboard function so the connection's outbound HEARTBEAT reports a truthful `system_status` (nominal→ACTIVE, degraded→CRITICAL, emergency→EMERGENCY, fatal→stops, expired lease→CRITICAL) instead of the hardcoded `MAV_STATE_ACTIVE`, plus an onboard-companion Local Identity preset. (Issue #225, PR B.)

**Architecture:** A pure `lib/health/advertised-health.js` maps a health assertion + wall clock to a heartbeat `system_status` (or a "stop" signal), with no Node-RED or transport dependency — mirroring the `lib/state/vehicle-state.js` engine layering. The connection holds a per-identity assertion store (`node._advertisedHealth`) fed by a new `node.setAdvertisedHealth()`; the existing per-identity heartbeat tick consults it for identities flagged `healthDriven`. The `mavlink-ai-vehicle-state` node's input forwards `{health, ttl_s, note}` assertions to the connection. The Local Identity `companion` role preset gains `healthDriven: true`.

**Tech Stack:** Node.js (CommonJS), Node-RED config/runtime nodes, `node --test` (node:test/node:assert), existing `MockRED` helper, JSDoc house style (`/** */` only).

## Global Constraints

- Node >= 20 (`engines.node`), CommonJS `require`/`module.exports` only.
- Comments are JSDoc `/** */` blocks — never `//`-only doc comments on functions, never plain `/* */`. Inline `//` notes inside function bodies are fine.
- Pure engine files (`lib/**`) must have NO Node-RED, transport, or connection dependency and take an injectable `now` clock — never call `Date.now()` inside pure logic; the caller passes the timestamp.
- MAVLink `system_status` values are the string enum names: `MAV_STATE_STANDBY`, `MAV_STATE_ACTIVE`, `MAV_STATE_CRITICAL`, `MAV_STATE_EMERGENCY` (node-mavlink resolves the string names on encode, as the existing `getHeartbeatFields()` already uses `'MAV_STATE_ACTIVE'`).
- Health states are exactly `'nominal' | 'degraded' | 'emergency' | 'fatal'`.
- A valid non-fatal assertion REQUIRES a positive numeric `ttl_s` (fail-closed: a lease-less "healthy" claim is rejected, so an expired/absent lease can never look healthy). `fatal` ignores ttl (it persists until a fresh non-fatal assertion replaces it).
- Existing (non-health-driven) identities keep today's static `MAV_STATE_ACTIVE` — this must be a pure addition gated on the `healthDriven` flag, with zero behavior change for GCS/default identities.
- Run BOTH `npm run lint` and `npm test` before every commit (CI runs eslint separately from the test matrix; `npm test` alone does not catch lint errors).
- Full suite currently passes at 918 unit + 21 integration on this branch (main includes merged PR A #208).

---

## File Structure

- **Create** `lib/health/advertised-health.js` — pure assertion normalization + heartbeat-status resolution. One responsibility: turn `{health, ttl_s, note}` + `now` into a stored record, and a stored record + `now` into a heartbeat outcome.
- **Create** `test/unit/advertised-health.test.js` — pure-engine unit tests.
- **Modify** `nodes/mavlink-ai-connection.js` — add `node._advertisedHealth` Map, `node.setAdvertisedHealth()`, and health-driven `system_status` override (+ fatal-stop) in the heartbeat tick.
- **Modify** `nodes/mavlink-ai-local-identity.js` — add `healthDriven` config flag; set `healthDriven: true` on the `companion` role preset.
- **Modify** `nodes/mavlink-ai-local-identity.html` — a "Health-driven heartbeat" checkbox, defaulted on when the Companion role is selected.
- **Modify** `nodes/mavlink-ai-vehicle-state.js` — input handler forwards a `{health,...}` assertion to `node.connection.setAdvertisedHealth`.
- **Modify** `nodes/mavlink-ai-vehicle-state.html` — document the health-assertion input.
- **Modify** `test/unit/connection.test.js` (or a new `test/unit/connection-heartbeat-health.test.js`) — store + heartbeat integration behavior.
- **Modify** `test/unit/vehicle-state-node.test.js` — health-forward test.
- **Modify** `test/unit/local-identity.test.js` — companion-preset `healthDriven` default.
- **Modify** `docs/superpowers/specs/2026-07-19-vehicle-state-health-design.md` — mark PR B shipped; **Modify** `README.md` — companion health section.

---

### Task 1: Pure advertised-health engine

**Files:**
- Create: `lib/health/advertised-health.js`
- Test: `test/unit/advertised-health.test.js`

**Interfaces:**
- Produces:
  - `normalizeAssertion(input, now)` → `{ state: string, note: (string|null), expires_at: (number|null) }`; throws `Error` with a `.code` string (`'INVALID_HEALTH'`) on a bad `health` state or a missing/non-positive `ttl_s` for a non-fatal state.
  - `resolveHeartbeatStatus(record, now)` → `{ status: string }` for a status to stamp, or `{ stop: true }` when the heartbeat must not be sent (fatal). `record` is the stored value from `normalizeAssertion` or `undefined` (never asserted).
  - `HEALTH_STATES` → `['nominal','degraded','emergency','fatal']` (array, for the editor/validation).

- [ ] **Step 1: Write the failing tests**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeAssertion, resolveHeartbeatStatus, HEALTH_STATES } = require('../../lib/health/advertised-health');

test('normalizeAssertion computes expires_at from ttl_s and keeps the note', () => {
  const r = normalizeAssertion({ health: 'nominal', ttl_s: 10, note: 'planner ok' }, 1000);
  assert.deepStrictEqual(r, { state: 'nominal', note: 'planner ok', expires_at: 11000 });
});

test('normalizeAssertion rejects an unknown health state', () => {
  assert.throws(() => normalizeAssertion({ health: 'fine', ttl_s: 10 }, 0), (e) => e.code === 'INVALID_HEALTH');
});

test('normalizeAssertion requires a positive ttl_s for a non-fatal assertion (fail-closed)', () => {
  assert.throws(() => normalizeAssertion({ health: 'nominal' }, 0), (e) => e.code === 'INVALID_HEALTH');
  assert.throws(() => normalizeAssertion({ health: 'degraded', ttl_s: 0 }, 0), (e) => e.code === 'INVALID_HEALTH');
  assert.throws(() => normalizeAssertion({ health: 'nominal', ttl_s: -5 }, 0), (e) => e.code === 'INVALID_HEALTH');
});

test('normalizeAssertion allows fatal with no ttl_s (persists until replaced)', () => {
  const r = normalizeAssertion({ health: 'fatal', note: 'planner crash' }, 500);
  assert.deepStrictEqual(r, { state: 'fatal', note: 'planner crash', expires_at: null });
});

test('resolveHeartbeatStatus maps each state and honors expiry', () => {
  assert.deepStrictEqual(resolveHeartbeatStatus(undefined, 0), { status: 'MAV_STATE_STANDBY' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'nominal', expires_at: 100 }, 50), { status: 'MAV_STATE_ACTIVE' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'degraded', expires_at: 100 }, 50), { status: 'MAV_STATE_CRITICAL' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'emergency', expires_at: 100 }, 50), { status: 'MAV_STATE_EMERGENCY' });
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'fatal', expires_at: null }, 50), { stop: true });
  /** An expired non-fatal lease must never look healthy → CRITICAL. */
  assert.deepStrictEqual(resolveHeartbeatStatus({ state: 'nominal', expires_at: 100 }, 101), { status: 'MAV_STATE_CRITICAL' });
});

test('HEALTH_STATES lists the four contract states', () => {
  assert.deepStrictEqual(HEALTH_STATES, ['nominal', 'degraded', 'emergency', 'fatal']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/advertised-health.test.js`
Expected: FAIL — `Cannot find module '../../lib/health/advertised-health'`.

- [ ] **Step 3: Write the implementation**

```javascript
'use strict';

/**
 * Advertised-health contract for the outbound HEARTBEAT (#225). A flow asserts
 * the health of its own onboard function; this pure module turns that assertion
 * into a stored record and, later, into a heartbeat `system_status` (or a signal
 * to stop heartbeating). No Node-RED, transport, or connection dependency; the
 * caller supplies the wall clock `now`.
 */

/** The four health states a flow may assert, in escalating severity. */
const HEALTH_STATES = ['nominal', 'degraded', 'emergency', 'fatal'];

/** Non-fatal, non-expired health state → HEARTBEAT system_status. */
const STATUS_BY_STATE = {
  nominal: 'MAV_STATE_ACTIVE',
  degraded: 'MAV_STATE_CRITICAL',
  emergency: 'MAV_STATE_EMERGENCY'
};

/**
 * Validate and normalize a raw health assertion into a stored record.
 *
 * @param {{health: string, ttl_s?: number, note?: string}} input
 * @param {number} now  wall clock (ms)
 * @returns {{state: string, note: ?string, expires_at: ?number}}
 * @throws {Error} with `.code === 'INVALID_HEALTH'` on a bad state or, for a
 *   non-fatal state, a missing/non-positive ttl_s (fail-closed lease).
 */
function normalizeAssertion(input, now) {
  const state = input && input.health;
  if (!HEALTH_STATES.includes(state)) {
    const err = new Error(`health must be one of ${HEALTH_STATES.join(', ')}`);
    err.code = 'INVALID_HEALTH';
    throw err;
  }
  const note = input.note === undefined || input.note === null ? null : String(input.note);
  if (state === 'fatal') {
    return { state, note, expires_at: null };
  }
  const ttl = Number(input.ttl_s);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    const err = new Error('a non-fatal health assertion requires a positive ttl_s (an expired or lease-less claim must never look healthy)');
    err.code = 'INVALID_HEALTH';
    throw err;
  }
  return { state, note, expires_at: now + ttl * 1000 };
}

/**
 * Resolve a stored assertion record to a heartbeat outcome.
 *
 * @param {?{state: string, expires_at: ?number}} record  or undefined if never asserted
 * @param {number} now  wall clock (ms)
 * @returns {{status: string}|{stop: true}} a status to stamp, or a stop signal
 *   (fatal: a faulted component must not keep heartbeating as if healthy).
 */
function resolveHeartbeatStatus(record, now) {
  if (!record) {
    return { status: 'MAV_STATE_STANDBY' };
  }
  if (record.state === 'fatal') {
    return { stop: true };
  }
  if (record.expires_at != null && now > record.expires_at) {
    return { status: 'MAV_STATE_CRITICAL' };
  }
  return { status: STATUS_BY_STATE[record.state] || 'MAV_STATE_STANDBY' };
}

module.exports = { normalizeAssertion, resolveHeartbeatStatus, HEALTH_STATES };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/advertised-health.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add lib/health/advertised-health.js test/unit/advertised-health.test.js
git commit -m "Advertised-health engine: assertion normalize + heartbeat status mapping (#225)"
```

---

### Task 2: Connection advertised-health store + setAdvertisedHealth()

**Files:**
- Modify: `nodes/mavlink-ai-connection.js`
- Test: `test/unit/connection-heartbeat-health.test.js` (create)

**Interfaces:**
- Consumes: `normalizeAssertion` from Task 1; the existing `node.resolveLocalIdentity(ref)` (throws on unresolvable) and `node.localIdentity` (default identity).
- Produces:
  - `node._advertisedHealth` — `Map<identityId, {state, note, expires_at}>`.
  - `node.setAdvertisedHealth(identityRef, input)` → the stored record. `identityRef` may be omitted/`null`/`undefined` to target the connection's default local identity (`node.localIdentity`). Throws the `INVALID_HEALTH` error from `normalizeAssertion` on a bad assertion, or an `Error` with `.code === 'UNKNOWN_IDENTITY'` if the ref does not resolve to a bound identity.

**Notes for the implementer:** Place `node._advertisedHealth = new Map();` near the other per-connection state maps (search for `node._heartbeatTimers = new Map();` around line 280 and add it adjacent). `setAdvertisedHealth` uses `Date.now()` (the impure boundary — the pure normalize takes it as an argument). The store is per-connection state; it is naturally rebuilt when the connection node is redeployed (a fresh node instance = fresh Map), satisfying the spec's "resets with the connection". Do NOT clear it on a profile-only reconcile.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/** Minimal identity stand-in with the methods the connection calls. */
function identity(id) {
  return { id, describe: () => id, getHeartbeatFields: () => ({ type: 'MAV_TYPE_ONBOARD_CONTROLLER', autopilot: 'MAV_AUTOPILOT_INVALID', base_mode: 0, custom_mode: 0, system_status: 'MAV_STATE_ACTIVE', mavlink_version: 3 }), healthDriven: true };
}

test('setAdvertisedHealth stores a normalized record for the default identity', () => {
  const RED = new MockRED().loadNodes();
  const def = identity('id-default');
  const conn = RED.create('mavlink-ai-connection', { id: 'c1', /* minimal valid config; see existing connection tests for the required fields */ });
  conn.localIdentity = def;
  conn.resolveLocalIdentity = (ref) => (ref == null || ref === def.id ? def : (() => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; })());
  const rec = conn.setAdvertisedHealth(undefined, { health: 'degraded', ttl_s: 10, note: 'watchdog' });
  assert.strictEqual(rec.state, 'degraded');
  assert.strictEqual(conn._advertisedHealth.get('id-default').state, 'degraded');
});

test('setAdvertisedHealth rejects an unknown identity ref', () => {
  const RED = new MockRED().loadNodes();
  const conn = RED.create('mavlink-ai-connection', { id: 'c1' });
  conn.localIdentity = identity('id-default');
  conn.resolveLocalIdentity = (ref) => { const e = new Error('no'); e.code = 'UNKNOWN_IDENTITY'; throw e; };
  assert.throws(() => conn.setAdvertisedHealth('ghost', { health: 'nominal', ttl_s: 5 }), (e) => e.code === 'UNKNOWN_IDENTITY');
});

test('setAdvertisedHealth propagates the INVALID_HEALTH validation error', () => {
  const RED = new MockRED().loadNodes();
  const conn = RED.create('mavlink-ai-connection', { id: 'c1' });
  const def = identity('id-default');
  conn.localIdentity = def;
  conn.resolveLocalIdentity = () => def;
  assert.throws(() => conn.setAdvertisedHealth(undefined, { health: 'nominal' }), (e) => e.code === 'INVALID_HEALTH');
});
```

> **Implementer note:** the exact `mavlink-ai-connection` config required by `MockRED.create` is non-trivial — copy the minimal valid-config setup from the top of the existing `test/unit/connection*.test.js` files (transport/identity fields) rather than guessing. If constructing a full connection node in the mock is too heavy for a focused unit test, instead export/test `setAdvertisedHealth` behavior by asserting on `_advertisedHealth` after calling it on a constructed node, and rely on Task 3's heartbeat test for end-to-end coverage. Keep the three assertions above (store, unknown-identity, invalid-health).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/connection-heartbeat-health.test.js`
Expected: FAIL — `conn.setAdvertisedHealth is not a function`.

- [ ] **Step 3: Implement the store and method**

Add the require near the other `lib/` requires at the top of `nodes/mavlink-ai-connection.js`:

```javascript
const { normalizeAssertion } = require('../lib/health/advertised-health');
```

Add the Map beside `node._heartbeatTimers = new Map();`:

```javascript
/**
 * Advertised-health assertions per outbound identity id (#225). A flow asserts
 * the health of its own onboard function via setAdvertisedHealth; the heartbeat
 * tick consults this for health-driven identities. Per-connection state — a
 * redeploy of this connection node rebuilds it empty (resets with the link).
 */
node._advertisedHealth = new Map();
```

Add the method (place it near `resolveLocalIdentity`/the heartbeat helpers):

```javascript
/**
 * Record a flow's health assertion for an outbound identity (#225). The
 * periodic heartbeat maps it to system_status for identities in health-driven
 * mode. `identityRef` omitted/null targets the connection's default local
 * identity.
 *
 * @param {?string} identityRef  a Local Identity config-node id, or null for the default
 * @param {{health: string, ttl_s?: number, note?: string}} input
 * @returns {{state: string, note: ?string, expires_at: ?number}} the stored record
 * @throws {Error} `.code` 'UNKNOWN_IDENTITY' (unresolvable ref) or
 *   'INVALID_HEALTH' (bad assertion).
 */
node.setAdvertisedHealth = (identityRef, input) => {
  const identity = identityRef == null ? node.localIdentity : node.resolveLocalIdentity(identityRef);
  if (!identity) {
    const err = new Error('no local identity to advertise health for');
    err.code = 'UNKNOWN_IDENTITY';
    throw err;
  }
  const record = normalizeAssertion(input, Date.now());
  node._advertisedHealth.set(identity.id, record);
  return record;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/connection-heartbeat-health.test.js`
Expected: PASS.

- [ ] **Step 5: Lint, full suite, commit**

```bash
npm run lint && npm test
git add nodes/mavlink-ai-connection.js test/unit/connection-heartbeat-health.test.js
git commit -m "Connection: advertised-health store + setAdvertisedHealth (#225)"
```

---

### Task 3: Health-driven system_status in the heartbeat tick

**Files:**
- Modify: `nodes/mavlink-ai-connection.js` (the `tick` closure inside `startHeartbeats`, ~line 2187)
- Test: `test/unit/connection-heartbeat-health.test.js` (extend)

**Interfaces:**
- Consumes: `resolveHeartbeatStatus` from Task 1; `node._advertisedHealth` from Task 2; the identity's `healthDriven` flag (Task 4 sets it on real identities; tests set it directly).
- Produces: heartbeat frames whose `system_status` reflects the resolved health for `healthDriven` identities, and NO frame on a fatal assertion.

**Behavior:** In the `tick`, before `node.send(...)`, compute the fields once and, when the identity is health-driven, override `system_status` (or skip the send entirely on `{stop:true}`):

```javascript
const tick = () => {
  const fields = identity.getHeartbeatFields();
  if (identity.healthDriven) {
    const outcome = resolveHeartbeatStatus(node._advertisedHealth.get(identity.id), Date.now());
    if (outcome.stop) {
      // fatal: a faulted component must not keep heartbeating as if present.
      // node status shows the declared fault; recovery needs a fresh assertion.
      node.status({ fill: 'red', shape: 'ring', text: `${identity.describe()}: health fatal — heartbeat stopped` });
      return;
    }
    fields.system_status = outcome.status;
  }
  node
    .send(
      { name: 'HEARTBEAT', fields, localIdentity: identity.id },
      { priority: PRIORITY.BACKGROUND, coalesceKey: `heartbeat:${identity.id}` }
    )
    .catch((err) => { /* unchanged existing catch */ });
};
```

Add the require at the top (extend Task 2's import line):

```javascript
const { normalizeAssertion, resolveHeartbeatStatus } = require('../lib/health/advertised-health');
```

- [ ] **Step 1: Write the failing test** (extend the Task 2 test file)

Drive the heartbeat tick with a fake/controlled send capture. Since the tick calls `node.send`, stub it and invoke one tick. The cleanest approach mirrors existing heartbeat tests — search `test/unit/connection*.test.js` for how they capture `node.send` and advance timers. Assert:

```javascript
test('a health-driven identity stamps the mapped system_status and stops on fatal', () => {
  // Construct a connection with a health-driven default identity, stub node.send
  // to capture frames, start heartbeats (or invoke the tick), then:
  // 1. no assertion  -> system_status 'MAV_STATE_STANDBY'
  // 2. setAdvertisedHealth degraded -> 'MAV_STATE_CRITICAL'
  // 3. setAdvertisedHealth fatal    -> NO frame sent that tick
  // (Use the existing connection-test scaffold for send capture + timer control.)
});
```

> **Implementer note:** if end-to-end timer driving is too heavy, refactor the status decision into a tiny named helper `heartbeatFieldsFor(identity, now)` on the node (returns `null` to mean "skip") and unit-test that helper directly, then have `tick` call it. Prefer whichever gives a deterministic, non-flaky test. Keep the three assertions (standby default, degraded→CRITICAL, fatal→no-send).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/unit/connection-heartbeat-health.test.js`
Expected: FAIL (system_status still `MAV_STATE_ACTIVE` / frame still sent on fatal).

- [ ] **Step 3: Implement the tick override** (as shown above).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/unit/connection-heartbeat-health.test.js`
Expected: PASS.

- [ ] **Step 5: Lint, full suite, commit**

```bash
npm run lint && npm test
git add nodes/mavlink-ai-connection.js test/unit/connection-heartbeat-health.test.js
git commit -m "Connection heartbeat: health-driven system_status + fatal stop (#225)"
```

---

### Task 4: Local Identity healthDriven flag + companion preset default-on

**Files:**
- Modify: `nodes/mavlink-ai-local-identity.js` (ROLE_PRESETS ~line 26; constructor ~line 90)
- Modify: `nodes/mavlink-ai-local-identity.html`
- Test: `test/unit/local-identity.test.js` (extend; if absent, create)

**Interfaces:**
- Produces: `node.healthDriven` (boolean) on the Local Identity node — read by the connection heartbeat tick (Task 3). Default: the role preset's `healthDriven` (companion → `true`), overridable by `config.healthDriven`.

- [ ] **Step 1: Write the failing test**

```javascript
test('the companion role defaults healthDriven on; gcs stays off', () => {
  const RED = new MockRED().loadNodes();
  const comp = RED.create('mavlink-ai-local-identity', { id: 'i1', role: 'companion' });
  assert.strictEqual(comp.healthDriven, true);
  const gcs = RED.create('mavlink-ai-local-identity', { id: 'i2', role: 'gcs' });
  assert.strictEqual(gcs.healthDriven, false);
});

test('an explicit healthDriven config overrides the preset default', () => {
  const RED = new MockRED().loadNodes();
  const comp = RED.create('mavlink-ai-local-identity', { id: 'i3', role: 'companion', healthDriven: false });
  assert.strictEqual(comp.healthDriven, false);
});
```

> **Implementer note:** check whether `test/unit/local-identity.test.js` exists and how it constructs the node (MockRED usage); mirror it. Confirm the node exposes a `toBool`-style helper or import the shared one the codebase already uses for boolean config coercion (search the repo for `toBool`).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/unit/local-identity.test.js`
Expected: FAIL — `comp.healthDriven` is `undefined`.

- [ ] **Step 3: Implement**

In `ROLE_PRESETS.companion` add `healthDriven: true`:

```javascript
  companion: {
    sysid: 1,
    compid: 191,
    heartbeatType: 'MAV_TYPE_ONBOARD_CONTROLLER',
    healthDriven: true
  },
```

In the constructor (after `node.heartbeatAutopilot = ...`), add — using the codebase's boolean coercion helper (replace `toBool` with the actual imported helper name if different):

```javascript
    /**
     * Health-driven heartbeat (#225): when on, the connection maps this
     * identity's advertised health to HEARTBEAT.system_status instead of the
     * static MAV_STATE_ACTIVE. Defaults to the role preset (companion → on).
     */
    node.healthDriven = toBool(config.healthDriven, !!preset.healthDriven);
```

In `nodes/mavlink-ai-local-identity.html`, add a checkbox to the edit template and a `healthDriven` default in `defaults` (`{ value: false }`), and wire the role-preset `onchange` (if the HTML already switches presets) to check the box for `companion`. Mirror the existing checkbox pattern in the file.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/unit/local-identity.test.js`
Expected: PASS.

- [ ] **Step 5: Lint, full suite, commit**

```bash
npm run lint && npm test
git add nodes/mavlink-ai-local-identity.js nodes/mavlink-ai-local-identity.html test/unit/local-identity.test.js
git commit -m "Local Identity: health-driven flag + companion preset default-on (#225)"
```

---

### Task 5: vehicle-state node forwards health assertions to the connection

**Files:**
- Modify: `nodes/mavlink-ai-vehicle-state.js` (the `node.on('input', ...)` handler)
- Modify: `nodes/mavlink-ai-vehicle-state.html` (help text)
- Test: `test/unit/vehicle-state-node.test.js` (extend)

**Interfaces:**
- Consumes: `node.connection.setAdvertisedHealth(identityRef, input)` from Task 2.
- Produces: on an input message carrying `health` (top-level `msg.health` or `msg.payload.health`), the node calls `node.connection.setAdvertisedHealth(msg.identity ?? (msg.payload && msg.payload.identity), { health, ttl_s, note })` and, on an `INVALID_HEALTH`/`UNKNOWN_IDENTITY`/missing-connection error, emits a structured error on output 2 (the same output the `INVALID_CONFIG`/`CONNECTION_UNAVAILABLE` snapshot errors already use). A successful assertion sends nothing (fire-and-forget; the heartbeat reflects it).

**Behavior:** In the input handler, handle the health branch alongside the existing `command === 'snapshot'` branch. Read fields from `msg` first, then `msg.payload`:

```javascript
node.on('input', (msg, send, done) => {
  const command = msg.command || (msg.payload && msg.payload.command);
  const health = msg.health || (msg.payload && msg.payload.health);
  if (health !== undefined) {
    if (!node.connection || typeof node.connection.setAdvertisedHealth !== 'function') {
      send([null, { topic: 'mavlink/error', payload: errorPayload({
        node: 'mavlink-ai-vehicle-state', code: 'CONNECTION_UNAVAILABLE',
        message: 'mavlink-ai-vehicle-state: no connection to advertise health to'
      }) }, null]);
      done();
      return;
    }
    const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    try {
      node.connection.setAdvertisedHealth(msg.identity !== undefined ? msg.identity : p.identity, {
        health,
        ttl_s: msg.ttl_s !== undefined ? msg.ttl_s : p.ttl_s,
        note: msg.note !== undefined ? msg.note : p.note
      });
    } catch (err) {
      send([null, { topic: 'mavlink/error', payload: errorPayload({
        node: 'mavlink-ai-vehicle-state', code: err && err.code ? err.code : 'INVALID_HEALTH',
        message: `mavlink-ai-vehicle-state: ${err && err.message ? err.message : err}`
      }) }, null]);
    }
    done();
    return;
  }
  if (command === 'snapshot') {
    // ... existing snapshot handling unchanged ...
  }
  done();
});
```

**Note:** keep the existing snapshot branch exactly as-is; only add the `health` branch before it. `errorPayload` is already imported in this file (used by the snapshot error paths).

- [ ] **Step 1: Write the failing test** (extend `test/unit/vehicle-state-node.test.js`)

```javascript
test('a health input is forwarded to connection.setAdvertisedHealth', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  const calls = [];
  conn.setAdvertisedHealth = (ref, input) => { calls.push({ ref, input }); return input; };
  await RED.inject(node, { payload: { health: 'degraded', ttl_s: 10, note: 'watchdog' } });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].input.health, 'degraded');
  assert.strictEqual(calls[0].input.ttl_s, 10);
});

test('a rejected health assertion surfaces a structured error on output 2', async (t) => {
  const { RED, conn, node } = setup();
  t.after(() => RED.close(node));
  conn.setAdvertisedHealth = () => { const e = new Error('bad'); e.code = 'INVALID_HEALTH'; throw e; };
  const { collected } = await RED.inject(node, { payload: { health: 'fine' } });
  const err = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(err.payload.code, 'INVALID_HEALTH');
});
```

> **Implementer note:** the `setup()` helper and `stubConnection` live at the top of `test/unit/vehicle-state-node.test.js`. Add `setAdvertisedHealth` to the stub connection's default methods (a no-op returning its input) so other tests are unaffected, then override per-test as above.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/unit/vehicle-state-node.test.js`
Expected: FAIL (no forward happens; `calls` empty).

- [ ] **Step 3: Implement the input branch** (as shown) and add `setAdvertisedHealth: (ref, input) => input` to `stubConnection` defaults.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/unit/vehicle-state-node.test.js`
Expected: PASS.

- [ ] **Step 5: Document + lint + suite + commit**

Add a "Health assertions" section to the `data-help-name="mavlink-ai-vehicle-state"` help in the `.html`: sending `{ health: 'nominal'|'degraded'|'emergency'|'fatal', ttl_s, note }` advertises the flow's own onboard health on the connection's companion heartbeat; non-fatal requires `ttl_s`; `fatal` stops the heartbeat until a fresh assertion.

```bash
npm run lint && npm test
git add nodes/mavlink-ai-vehicle-state.js nodes/mavlink-ai-vehicle-state.html test/unit/vehicle-state-node.test.js
git commit -m "Vehicle state node: forward health assertions to the connection (#225)"
```

---

### Task 6: Docs, example, and #225 close-out

**Files:**
- Modify: `docs/superpowers/specs/2026-07-19-vehicle-state-health-design.md` (mark PR B shipped)
- Modify: `README.md` (companion health section)
- Optional Create: `examples/09-observability/22-onboard-companion-health.json` (a minimal flow: an Inject → vehicle-state health input; a Local Identity companion bound to a connection with heartbeat on). Only add if it can be validated by `node -e "JSON.parse(...)"` and matches the example schema of the sibling files.

- [ ] **Step 1: README** — add a short "Onboard companion health" subsection near the connection/identity docs: the companion role preset, the health-driven heartbeat mapping table (never→STANDBY, nominal→ACTIVE, degraded→CRITICAL, emergency→EMERGENCY, fatal→stops, expired-TTL→CRITICAL), and the documented separations (HEARTBEAT is component presence, not command delivery / setpoint freshness (#216) / GCS failsafe).

- [ ] **Step 2: Spec** — in `2026-07-19-vehicle-state-health-design.md`, note PR B as shipped and keep the "#225 coverage boundary" section (unified four-signal surface → #205; stale-setpoint control-coupling → #216 ownership; identity-model rework → #195).

- [ ] **Step 3: (Optional) example** — if added, validate:

```bash
node -e "JSON.parse(require('fs').readFileSync('examples/09-observability/22-onboard-companion-health.json','utf8')); console.log('ok')"
```

- [ ] **Step 4: Lint, full suite, commit**

```bash
npm run lint && npm test
git add README.md docs/superpowers/specs/2026-07-19-vehicle-state-health-design.md examples/ 2>/dev/null || git add README.md docs/superpowers/specs/2026-07-19-vehicle-state-health-design.md
git commit -m "Docs: onboard-companion health-driven heartbeat; #225 close-out (#225)"
```

- [ ] **Step 5: PR body close-out language** — when the PR is opened, the body states: "Addresses the heartbeat-health + companion-preset core of #225 completely. The unified four-signal health-event surface is #205 (deferred post-1.0); automatic stale-setpoint → control-health coupling is #216's control-ownership scope; the reworked identity model is #195. Closes #225." So #225 closes without implying those deferred items were built.

---

## Self-Review

**Spec coverage (PR B section of the design spec):**
- Health assertion contract `{health, ttl_s, note}` → Task 1 (normalize) + Task 5 (input). ✓
- Forward to `connection.setAdvertisedHealth(identityRef, assertion)` → Task 2 + Task 5. ✓
- Store `{state, note, expires_at}` per identity → Task 2. ✓
- Heartbeat mapping table (never/nominal/degraded/emergency/fatal/expired) → Task 1 `resolveHeartbeatStatus` + Task 3 tick. ✓
- Fatal stops the heartbeat; recovery needs a fresh assertion → Task 3 (`{stop:true}` returns before send; a later non-fatal assertion overwrites the record). ✓
- Expired lease → CRITICAL → Task 1 (expiry check) + Task 3. ✓
- Existing GCS/default identities untouched (static ACTIVE) → gated on `healthDriven`; Task 4 keeps gcs off; Task 3 only overrides when `healthDriven`. ✓
- Onboard companion preset (sysid+191, ONBOARD_CONTROLLER, AUTOPILOT_INVALID, health-driven on) → Task 4 (companion preset already had sysid/compid/type; adds healthDriven). ✓
- Documented separations → Task 6 (README). ✓
- Tests: flow-fault (fatal stops), stale assertion (expiry→CRITICAL), recovery, reconnect/redeploy store reset, event-loop-delay tolerance (expiry checked at tick, not its own timer — inherent: `resolveHeartbeatStatus` is evaluated inside the tick with `Date.now()`) → Tasks 1–5. ✓
- #225 coverage boundary (option B, #205/#195/#216 cross-refs) → Task 6. ✓

**Placeholder scan:** Task 2 and Task 3 test steps intentionally defer to the existing connection-test scaffold for send-capture/timer control rather than inventing a possibly-wrong harness — the *assertions* to make are spelled out explicitly, and an implementer note gives a concrete fallback (a named `heartbeatFieldsFor`/`heartbeatStatusFor` helper unit-tested directly). This is a deliberate, bounded instruction, not a vague placeholder. All pure-logic code (Task 1) and node-wiring code (Tasks 2–5) is shown in full.

**Type consistency:** `normalizeAssertion(input, now) → {state, note, expires_at}` and `resolveHeartbeatStatus(record, now) → {status}|{stop}` are used consistently in Tasks 2/3. `node._advertisedHealth` (Map), `node.setAdvertisedHealth(identityRef, input)`, and `identity.healthDriven` names match across Tasks 2/3/4/5. Health states array `HEALTH_STATES` shared. ✓
