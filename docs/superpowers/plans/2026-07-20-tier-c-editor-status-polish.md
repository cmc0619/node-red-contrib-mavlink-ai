# Tier C PR1 — Editor numeric validation, concise status, #225 loose ends

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the node editors reject the numeric values the runtime silently clamps (#210), cap over-long status badges through one shared helper (#221 sliver), and close two small #225 follow-ups (gate `heartbeatSpecs()` warnings to the start path; document the `IDENTITY_NOT_HEALTH_DRIVEN` rejection in the vehicle-state help).

**Architecture:** Two new pure `lib/util` helpers are the source of truth. `numeric-bounds.js` exposes acceptance predicates that mirror the *existing* runtime clamps; the browser editors (which cannot `require`) inline a byte-mirrored copy referenced from each field's `validate:`, and a new editor-spec test extracts each inline copy and asserts it agrees with the module — the same drift-guard pattern already used by `connection-editor-spec.test.js` and the bitmask editor spec. `truncateStatus()` in the existing `lib/util/status.js` caps badge text; the 20 offending `node.status({...text})` call sites wrap their text in it. The two #225 items are localized edits to `mavlink-ai-connection.js` and `mavlink-ai-vehicle-state.html`.

**Tech Stack:** Node.js ≥20 CommonJS, `node --test`, Node-RED 4.x editor `defaults`/`validate`, MockRED test helper.

## Global Constraints

- **No new bounds (#210).** Editor validators mirror ONLY the clamp rules the runtime already enforces. Do not invent stricter/looser limits. Blank (empty/`null`/`undefined`) is always accepted — every field has a runtime default it falls back to.
- **Source of truth is `lib/`.** Editors inline a mirror of `lib/util/numeric-bounds.js`; the mirror must stay behaviorally identical, enforced by `test/unit/numeric-bounds-editor-spec.test.js`.
- **Comments are JSDoc `/** */` only.** Match surrounding style; no `//` block headers on functions.
- **Every task runs `npm run lint` and `npm test` before its commit** (lint is not part of `npm test`). `npm test` = smoke + unit + integration.
- **Status badge cap is `truncateStatus(text, 24)`** — 24 chars max, trailing `…`. Rationale: 24 preserves the fixed-skeleton informative badges (`"3 vehicles · 2 connected"` = 24) while bounding the genuinely-unbounded interpolations (MAVLink message/command names, error codes, param ids at 25–40+ chars). Detail lives in structured outputs/logs per the issue.
- **Do not reword status text** beyond wrapping it in `truncateStatus`; the helper is the single mechanism (#221 asks for one shared helper).
- Worktree: `/home/user/node-red-contrib-mavlink-ai/.worktrees/route-reject`, branch `claude/greenfield-build-spec-review-3kzv6m` (already reset onto merged `main`).

---

### Task 1: `truncateStatus` helper

**Files:**
- Modify: `lib/util/status.js` (add + export `truncateStatus`)
- Test: `test/unit/status-truncate.test.js` (create)

**Interfaces:**
- Produces: `truncateStatus(text, maxLen = 24) → string` — returns `''` for `null`/`undefined`; coerces non-strings via `String()`; returns the input unchanged when `length <= maxLen`; otherwise returns the first `maxLen - 1` characters plus `'…'` (total length exactly `maxLen`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/status-truncate.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { truncateStatus } = require('../../lib/util/status');

test('truncateStatus passes short text through unchanged', () => {
  assert.strictEqual(truncateStatus('tx 5'), 'tx 5');
  assert.strictEqual(truncateStatus('waiting for link'), 'waiting for link');
});

test('truncateStatus leaves text exactly at the cap unchanged', () => {
  const s = '3 vehicles · 2 connect'; // 22 chars, <= 24
  assert.ok(s.length <= 24);
  assert.strictEqual(truncateStatus(s), s);
});

test('truncateStatus caps overlong text at maxLen with a trailing ellipsis', () => {
  const out = truncateStatus('SET_POSITION_TARGET_GLOBAL_INT'); // 30 chars
  assert.strictEqual(out.length, 24);
  assert.ok(out.endsWith('…'));
  assert.strictEqual(out, 'SET_POSITION_TARGET_GLO…');
});

test('truncateStatus respects an explicit maxLen', () => {
  assert.strictEqual(truncateStatus('abcdefghij', 5), 'abcd…');
});

test('truncateStatus tolerates non-string and empty input', () => {
  assert.strictEqual(truncateStatus(undefined), '');
  assert.strictEqual(truncateStatus(null), '');
  assert.strictEqual(truncateStatus(123), '123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/status-truncate.test.js`
Expected: FAIL — `truncateStatus is not a function`.

- [ ] **Step 3: Implement the helper**

In `lib/util/status.js`, add this function (JSDoc, matching the file's style) and add `truncateStatus` to the `module.exports`:

```js
/**
 * Cap node status badge text so it stays glanceable and does not truncate
 * mid-glyph in the editor (#221). Node-RED badges are a status indicator, not
 * a data channel — the full detail lives on the node's structured outputs and
 * in the runtime log. Overlong text (a MAVLink message/command name, an error
 * code, a param id) is cut to `maxLen - 1` characters plus a single-glyph
 * ellipsis so the result is never longer than `maxLen`.
 *
 * @param {*} text  the badge text (coerced to string; null/undefined → '')
 * @param {number} [maxLen=24]  maximum result length in characters
 * @returns {string}
 */
function truncateStatus(text, maxLen = 24) {
  const s = text === null || text === undefined ? '' : String(text);
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen - 1)}…`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/status-truncate.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add lib/util/status.js test/unit/status-truncate.test.js
git commit -m "feat(status): add truncateStatus badge-text cap helper (#221)"
```

---

### Task 2: Cap the over-long status badges

**Files:**
- Modify (wrap each listed `text:` in `truncateStatus(...)`):
  - `nodes/mavlink-ai-build.js:128`
  - `nodes/mavlink-ai-command.js:663, 732, 771`
  - `nodes/mavlink-ai-payload.js:320, 352, 438`
  - `nodes/mavlink-ai-vehicle-state.js:70`
  - `nodes/mavlink-ai-swarm.js:90-91, 270`
  - `nodes/mavlink-ai-formation.js:192, 214, 242, 265, 267, 307`
  - `nodes/mavlink-ai-move.js:329, 555`
  - `nodes/mavlink-ai-out.js:143`
  - `nodes/mavlink-ai-param.js:138` (the `progressText` return, defined ~`336-341`)
- Test: `test/unit/status-truncate.test.js` (add an integration-style assertion)

**Interfaces:**
- Consumes: `truncateStatus` from Task 1.

**Note on `require`:** each of these node files already imports from `lib/util/status.js` (they use `badgeForState`). Add `truncateStatus` to that existing destructure, e.g. `const { badgeForState, truncateStatus } = require('../lib/util/status');`. If a file imports `badgeForState` from a different path or not at all, add a `truncateStatus` import consistent with that file's existing requires. Verify per file — do not assume.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/status-truncate.test.js`. This drives one representative unbounded offender (the command node's raw-command "accepted" badge) through a real node run and asserts the badge is capped. Model the harness on the existing `test/unit/command-node.test.js` (MockRED + `RED.inject`). Read that file first for the exact setup; the assertion to add is:

```js
const { MockRED } = require('../helpers/mock-red');

test('command node caps a long raw-command status badge at 24 chars (#221)', async () => {
  // Arrange a command node whose "selected" resolves to a long raw MAV_CMD name,
  // driven exactly like the accepted-path cases in command-node.test.js.
  // After a successful send/ack, the last status badge text must be <= 24 chars.
  // (See command-node.test.js for building the node, connection stub, and inject.)
  //
  // Pseudocode for the assertion once you have `node` and have injected a
  // COMMAND_LONG whose command name is e.g. 'MAV_CMD_COMPONENT_ARM_DISARM':
  //   const badges = node.statusHistory; // array of status() args captured by MockRED
  //   const last = badges[badges.length - 1];
  //   assert.ok(last.text.length <= 24, `badge too long: ${last.text}`);
  //   assert.ok(last.text.startsWith('MAV_CMD_COMPONENT_ARM'));
  assert.ok(true); // replace with the real harness assertion above
});
```

Implementer: replace the placeholder with the concrete harness from `command-node.test.js`. If `MockRED` does not already record status history, capture it in the test by wrapping `node.status`. The binding requirement is: **the last badge's `text.length <= 24`** for a long raw-command name.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/status-truncate.test.js`
Expected: FAIL — the badge is currently the untruncated `"MAV_CMD_COMPONENT_ARM_DISARM accepted"` (37 chars).

- [ ] **Step 3: Wrap every listed status text**

For each site, wrap the existing `text:` expression in `truncateStatus(...)`, leaving `fill`/`shape` untouched. Examples (apply the same transform at every listed line):

```js
// nodes/mavlink-ai-build.js
node.status({ fill: 'green', shape: 'dot', text: truncateStatus(clazz.MSG_NAME) });

// nodes/mavlink-ai-command.js:663
node.status({ fill: 'green', shape: 'dot', text: truncateStatus(`${selected} accepted`) });

// nodes/mavlink-ai-formation.js:214
node.status({ fill: 'red', shape: 'ring', text: truncateStatus(e.code) });

// nodes/mavlink-ai-move.js:555
node.status({ fill: 'red', shape: 'ring', text: truncateStatus(`stream: ${e.code}`) });

// nodes/mavlink-ai-out.js:143
node.status({ fill: 'red', shape: 'ring', text: truncateStatus(err.code || 'send error') });

// nodes/mavlink-ai-param.js — inside progressText(...), wrap the returned string:
return truncateStatus(`${p.state} ${p.param_id}`);
```

Do not change any `text` that is not in the file/line list (short badges stay as-is). Preserve exact wording inside the template literals.

- [ ] **Step 4: Run the full suite to verify no badge assertions broke**

Run: `npm test`
Expected: PASS. If any existing node test asserts an exact long badge string that is now truncated, update that assertion to the truncated value (search results at plan time found no such exact-literal assertions, but confirm per failing test).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add nodes/ test/unit/status-truncate.test.js
git commit -m "fix(status): cap over-long node status badges via truncateStatus (#221)"
```

---

### Task 3: `numeric-bounds` acceptance module

**Files:**
- Create: `lib/util/numeric-bounds.js`
- Test: `test/unit/numeric-bounds.test.js`

**Interfaces:**
- Produces (all pure; blank input `''`/`null`/`undefined` → `true`):
  - `acceptsPositive(v) → boolean` — finite `> 0`
  - `acceptsNonNegativeInteger(v) → boolean` — integer `>= 0`
  - `acceptsNonNegative(v) → boolean` — finite `>= 0`
  - `acceptsAtLeast(min) → (v) => boolean` — finite `>= min`
  - `acceptsIntegerAtLeast(min) → (v) => boolean` — integer `>= min`
  - `isBlank(v) → boolean`

These mirror the runtime clamps exactly (verified against current `main`):
| Predicate | Runtime clamp it mirrors |
|---|---|
| `acceptsPositive` | command/mission/fanout timeout (`isFinite && >0 ? : DEFAULT`); swarm `staleMs` (`>0 ? : 5000`) |
| `acceptsNonNegativeInteger` | command/mission/fanout `maxRetries` (`isFinite && >=0 ? trunc : DEFAULT`) |
| `acceptsNonNegative` | fanout `spacingMs`, swarm `expireMs` (0 = never expire), swarm `intervalMs` (0 = off) |
| `acceptsAtLeast(1000)` | connection `heartbeatIntervalMs` (`Math.max(1000, toInt(x,1000))`) |
| `acceptsIntegerAtLeast(1)` | fanout `concurrency` (`Math.max(1, toInt(x,1))`) |

- [ ] **Step 1: Write the failing test**

Create `test/unit/numeric-bounds.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const nb = require('../../lib/util/numeric-bounds');

test('isBlank treats empty/whitespace/null/undefined as blank', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.strictEqual(nb.isBlank(v), true, `blank: ${JSON.stringify(v)}`);
  }
  for (const v of ['0', 0, '5']) {
    assert.strictEqual(nb.isBlank(v), false, `not blank: ${JSON.stringify(v)}`);
  }
});

test('acceptsPositive: finite > 0, blank allowed', () => {
  for (const v of ['', 1, '3000', 0.5]) assert.strictEqual(nb.acceptsPositive(v), true, `ok: ${v}`);
  for (const v of [0, '0', -1, '-5', 'abc', Infinity, -Infinity, NaN]) {
    assert.strictEqual(nb.acceptsPositive(v), false, `rejected: ${v}`);
  }
});

test('acceptsNonNegativeInteger: integer >= 0, blank allowed, fractional rejected', () => {
  for (const v of ['', 0, '0', 3, '10']) assert.strictEqual(nb.acceptsNonNegativeInteger(v), true, `ok: ${v}`);
  for (const v of [-1, '-1', 2.5, '2.5', 'x', Infinity, NaN]) {
    assert.strictEqual(nb.acceptsNonNegativeInteger(v), false, `rejected: ${v}`);
  }
});

test('acceptsNonNegative: finite >= 0, blank allowed, negative rejected', () => {
  for (const v of ['', 0, '0', 0.5, 30000]) assert.strictEqual(nb.acceptsNonNegative(v), true, `ok: ${v}`);
  for (const v of [-0.1, '-1', 'x', Infinity, NaN]) {
    assert.strictEqual(nb.acceptsNonNegative(v), false, `rejected: ${v}`);
  }
});

test('acceptsAtLeast(1000): finite >= 1000, blank allowed', () => {
  const f = nb.acceptsAtLeast(1000);
  for (const v of ['', 1000, '1000', 2500]) assert.strictEqual(f(v), true, `ok: ${v}`);
  for (const v of [999, '500', 0, -1, 'x', Infinity, NaN]) assert.strictEqual(f(v), false, `rejected: ${v}`);
});

test('acceptsIntegerAtLeast(1): integer >= 1, blank allowed, fractional/sub-min rejected', () => {
  const f = nb.acceptsIntegerAtLeast(1);
  for (const v of ['', 1, '1', 8]) assert.strictEqual(f(v), true, `ok: ${v}`);
  for (const v of [0, '0', 0.5, 2.5, -3, 'x', Infinity, NaN]) assert.strictEqual(f(v), false, `rejected: ${v}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/numeric-bounds.test.js`
Expected: FAIL — `Cannot find module '../../lib/util/numeric-bounds'`.

- [ ] **Step 3: Implement the module**

Create `lib/util/numeric-bounds.js`:

```js
'use strict';

/**
 * Editor↔runtime numeric acceptance rules (#210). Each predicate answers one
 * question: would the runtime use this raw field value verbatim, or silently
 * clamp/default it? The node editors mirror these in their `validate:`
 * functions so the edit dialog rejects exactly the values the runtime would
 * quietly replace — the editor stops lying about what the runtime accepts.
 *
 * Blank (empty string / null / undefined) is always acceptable: every field
 * covered here has a runtime default that a blank value falls back to, so the
 * editor must not block an intentionally-empty field.
 *
 * This module is the SOURCE OF TRUTH. The node .html editors run in the
 * browser and cannot `require` it, so each inlines a byte-mirror copy;
 * test/unit/numeric-bounds-editor-spec.test.js extracts every inline copy and
 * asserts it agrees with this module (same drift guard as the transport-field
 * and bitmask editor specs).
 */

/**
 * @param {*} v
 * @returns {boolean} true when v should fall back to the runtime default
 */
function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

/**
 * @param {*} v
 * @returns {boolean} finite and strictly greater than zero (blank allowed)
 */
function acceptsPositive(v) {
  if (isBlank(v)) {
    return true;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/**
 * @param {*} v
 * @returns {boolean} an integer >= 0 (blank allowed; fractional rejected)
 */
function acceptsNonNegativeInteger(v) {
  if (isBlank(v)) {
    return true;
  }
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}

/**
 * @param {*} v
 * @returns {boolean} finite and >= 0 (blank allowed; zero allowed)
 */
function acceptsNonNegative(v) {
  if (isBlank(v)) {
    return true;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

/**
 * @param {number} min
 * @returns {function(*): boolean} finite and >= min (blank allowed)
 */
function acceptsAtLeast(min) {
  return function accepts(v) {
    if (isBlank(v)) {
      return true;
    }
    const n = Number(v);
    return Number.isFinite(n) && n >= min;
  };
}

/**
 * @param {number} min
 * @returns {function(*): boolean} an integer >= min (blank allowed)
 */
function acceptsIntegerAtLeast(min) {
  return function accepts(v) {
    if (isBlank(v)) {
      return true;
    }
    const n = Number(v);
    return Number.isInteger(n) && n >= min;
  };
}

module.exports = {
  isBlank,
  acceptsPositive,
  acceptsNonNegativeInteger,
  acceptsNonNegative,
  acceptsAtLeast,
  acceptsIntegerAtLeast
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/numeric-bounds.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add lib/util/numeric-bounds.js test/unit/numeric-bounds.test.js
git commit -m "feat(editor): add numeric-bounds acceptance module mirroring runtime clamps (#210)"
```

---

### Task 4: Wire editor validators + drift-guard spec

**Files:**
- Modify (add inline `mavlinkNumericBounds()` mirror + rewire numeric `validate:` fields):
  - `nodes/mavlink-ai-command.html` — `timeoutMs` (:30 → positive), `maxRetries` (:31 → nonNegativeInteger)
  - `nodes/mavlink-ai-mission.html` — `timeoutMs` (:12 → positive), `maxRetries` (:13 → nonNegativeInteger)
  - `nodes/mavlink-ai-fanout.html` — `timeoutMs` (:31 → positive), `maxRetries` (:32 → nonNegativeInteger), `spacingMs` (:33 → nonNegative), `concurrency` (:35 → integerAtLeast(1))
  - `nodes/mavlink-ai-swarm.html` — `staleMs` (:9 → positive), `expireMs` (:10 → nonNegative), `intervalMs` (:12 → nonNegative)
  - `nodes/mavlink-ai-connection.html` — `heartbeatIntervalMs` (:325 → atLeast(1000))
- Create: `test/unit/numeric-bounds-editor-spec.test.js`

**Interfaces:**
- Consumes: `lib/util/numeric-bounds.js` (Task 3), for the spec test's expected behavior.

**The inline mirror.** In each of the five HTML files, add this `<script>` block *before* the `RED.nodes.registerType` call that references it (a node HTML may have multiple `<script>` blocks; place it in, or immediately before, the block containing `registerType`). It must be **identical** across all five files:

```html
<script type="text/javascript">
  // #210: browser mirror of lib/util/numeric-bounds.js. Kept in sync by
  // test/unit/numeric-bounds-editor-spec.test.js — edit both together.
  function mavlinkNumericBounds() {
    function isBlank(v) { return v === undefined || v === null || String(v).trim() === ''; }
    return {
      positive: function (v) { if (isBlank(v)) { return true; } var n = Number(v); return isFinite(n) && n > 0; },
      nonNegativeInteger: function (v) { if (isBlank(v)) { return true; } var n = Number(v); return Number.isInteger(n) && n >= 0; },
      nonNegative: function (v) { if (isBlank(v)) { return true; } var n = Number(v); return isFinite(n) && n >= 0; },
      atLeast: function (min) { return function (v) { if (isBlank(v)) { return true; } var n = Number(v); return isFinite(n) && n >= min; }; },
      integerAtLeast: function (min) { return function (v) { if (isBlank(v)) { return true; } var n = Number(v); return Number.isInteger(n) && n >= min; }; }
    };
  }
</script>
```

**The rewiring.** Replace each numeric field's `validate: RED.validators.number()` with the mapped predicate. Examples:

```js
// command.html
timeoutMs: { value: 3000, validate: function (v) { return mavlinkNumericBounds().positive(v); } },
maxRetries: { value: 3, validate: function (v) { return mavlinkNumericBounds().nonNegativeInteger(v); } },

// fanout.html
spacingMs: { value: 0, validate: function (v) { return mavlinkNumericBounds().nonNegative(v); } },
concurrency: { value: 1, validate: function (v) { return mavlinkNumericBounds().integerAtLeast(1)(v); } },

// swarm.html
staleMs: { value: 5000, validate: function (v) { return mavlinkNumericBounds().positive(v); } },
expireMs: { value: 30000, validate: function (v) { return mavlinkNumericBounds().nonNegative(v); } },
intervalMs: { value: 0, validate: function (v) { return mavlinkNumericBounds().nonNegative(v); } },

// connection.html — heartbeatIntervalMs only (leave bindPort/serialBaud on requiredNumberValidator)
heartbeatIntervalMs: { value: 1000, validate: function (v) { return mavlinkNumericBounds().atLeast(1000)(v); } },
```

Keep each field's existing `value:` default. Do not touch non-numeric fields or the connection's `requiredNumberValidator`-based fields. Leave existing HTML `min`/`step` attributes as-is (secondary affordances); do not add or assert new ones.

- [ ] **Step 1: Write the failing spec test**

Create `test/unit/numeric-bounds-editor-spec.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const nb = require('../../lib/util/numeric-bounds');

/**
 * The node editors run in the browser and cannot require lib/util/numeric-bounds.js,
 * so each inlines an identical `mavlinkNumericBounds()` mirror. This test extracts
 * that mirror from every editor that uses it and asserts it agrees with the module
 * across a value matrix, then asserts each numeric field is wired to the right
 * predicate. Guards against editor/runtime drift (#210).
 */

const NODES_DIR = path.join(__dirname, '..', '..', 'nodes');

const EDITOR_FILES = [
  'mavlink-ai-command.html',
  'mavlink-ai-mission.html',
  'mavlink-ai-fanout.html',
  'mavlink-ai-swarm.html',
  'mavlink-ai-connection.html'
];

// (file, field, module-expression) — module-expression evaluated against nb.
const FIELD_RULES = [
  ['mavlink-ai-command.html', 'timeoutMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-command.html', 'maxRetries', (v) => nb.acceptsNonNegativeInteger(v)],
  ['mavlink-ai-mission.html', 'timeoutMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-mission.html', 'maxRetries', (v) => nb.acceptsNonNegativeInteger(v)],
  ['mavlink-ai-fanout.html', 'timeoutMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-fanout.html', 'maxRetries', (v) => nb.acceptsNonNegativeInteger(v)],
  ['mavlink-ai-fanout.html', 'spacingMs', (v) => nb.acceptsNonNegative(v)],
  ['mavlink-ai-fanout.html', 'concurrency', (v) => nb.acceptsIntegerAtLeast(1)(v)],
  ['mavlink-ai-swarm.html', 'staleMs', (v) => nb.acceptsPositive(v)],
  ['mavlink-ai-swarm.html', 'expireMs', (v) => nb.acceptsNonNegative(v)],
  ['mavlink-ai-swarm.html', 'intervalMs', (v) => nb.acceptsNonNegative(v)],
  ['mavlink-ai-connection.html', 'heartbeatIntervalMs', (v) => nb.acceptsAtLeast(1000)(v)]
];

// Values exercised at every field to prove editor == module.
const MATRIX = ['', '   ', null, undefined, 0, '0', 1, '1', -1, '-5', 0.5, 2.5, 1000, '2500', 999, 'abc', Infinity, NaN];

function read(file) {
  return fs.readFileSync(path.join(NODES_DIR, file), 'utf8');
}

/** Extract and evaluate the inline mavlinkNumericBounds() factory from an editor. */
function extractBounds(html) {
  const match = /function mavlinkNumericBounds\(\)\s*\{[\s\S]*?\n  \}/.exec(html);
  assert.ok(match, 'expected the editor to inline mavlinkNumericBounds()');
  return new Function(`${match[0]}; return mavlinkNumericBounds();`)();
}

/** Extract a field's validate function body from the editor's defaults block. */
function extractFieldValidate(html, field) {
  // Matches:  field: { value: X, validate: function (v) { return <BODY>; } }
  const re = new RegExp(`${field}:\\s*\\{[^}]*?validate:\\s*(function \\(v\\) \\{ return [^}]*?\\})`);
  const match = re.exec(html);
  assert.ok(match, `expected ${field} to have an inline validate function`);
  return new Function('mavlinkNumericBounds', `return (${match[1]});`);
}

test('each editor inlines mavlinkNumericBounds() matching the module', () => {
  const factory = {
    positive: (b) => b.positive,
    nonNegativeInteger: (b) => b.nonNegativeInteger,
    nonNegative: (b) => b.nonNegative,
    atLeast1000: (b) => b.atLeast(1000),
    integerAtLeast1: (b) => b.integerAtLeast(1)
  };
  const moduleFns = {
    positive: nb.acceptsPositive,
    nonNegativeInteger: nb.acceptsNonNegativeInteger,
    nonNegative: nb.acceptsNonNegative,
    atLeast1000: nb.acceptsAtLeast(1000),
    integerAtLeast1: nb.acceptsIntegerAtLeast(1)
  };
  for (const file of EDITOR_FILES) {
    const bounds = extractBounds(read(file));
    for (const key of Object.keys(factory)) {
      const editorFn = factory[key](bounds);
      for (const v of MATRIX) {
        assert.strictEqual(
          Boolean(editorFn(v)),
          Boolean(moduleFns[key](v)),
          `${file} ${key}(${JSON.stringify(v)}) editor != module`
        );
      }
    }
  }
});

test('each numeric field is wired to the runtime-matching predicate', () => {
  const cache = {};
  for (const [file, field, moduleRule] of FIELD_RULES) {
    const html = (cache[file] = cache[file] || read(file));
    const bounds = extractBounds(html);
    const build = extractFieldValidate(html, field);
    const editorValidate = build(() => bounds); // mavlinkNumericBounds() → bounds
    for (const v of MATRIX) {
      assert.strictEqual(
        Boolean(editorValidate(v)),
        Boolean(moduleRule(v)),
        `${file} field ${field} validate(${JSON.stringify(v)}) != runtime rule`
      );
    }
  }
});
```

Note for the implementer: the two regexes assume the exact inline forms shown in this task (the `mavlinkNumericBounds()` block indented under two spaces, and single-line `validate: function (v) { return ...; }`). Keep the editor code in those forms, or adjust the regex to match what you wrote — the test must actually extract and execute the shipped editor code, not a re-typed copy.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/numeric-bounds-editor-spec.test.js`
Expected: FAIL — editors do not yet inline `mavlinkNumericBounds()`.

- [ ] **Step 3: Add the inline mirror + rewire validators**

Apply the inline `<script>` block and the per-field `validate:` rewiring described above to all five HTML files.

- [ ] **Step 4: Run the spec + full suite**

Run: `node --test test/unit/numeric-bounds-editor-spec.test.js`
Expected: PASS (2 tests).
Then run: `npm test`
Expected: PASS (existing editor/connection specs unaffected).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add nodes/mavlink-ai-command.html nodes/mavlink-ai-mission.html nodes/mavlink-ai-fanout.html nodes/mavlink-ai-swarm.html nodes/mavlink-ai-connection.html test/unit/numeric-bounds-editor-spec.test.js
git commit -m "feat(editor): mirror runtime numeric clamps in node validators (#210)"
```

---

### Task 5: #225 follow-ups — quiet heartbeatSpecs probe + document IDENTITY_NOT_HEALTH_DRIVEN

**Files:**
- Modify: `nodes/mavlink-ai-connection.js` (`heartbeatSpecs()` ~:2198–2245; call sites :746 and :2416)
- Modify: `nodes/mavlink-ai-vehicle-state.html` (Health assertions help, ~:60–61)
- Test: `test/unit/connection-heartbeat-health.test.js` (add a case)

**Background (verified on current `main`):** `heartbeatSpecs()` emits two `node.warn(...)` calls (":2218 cannot start heartbeat for additional Local Identity", ":2225 heartbeat enabled but outbound disabled") for skipped additional identities. It is called from the actual (re)start path (`startHeartbeats`, :2416) **and** from `setAdvertisedHealth`'s eligibility probe (:746). The probe is not a start, so those start-phrased warnings should not fire from it — otherwise every health assertion re-warns.

**Interfaces:**
- `heartbeatSpecs(options)` — `options.warnSkips` (default `false`) gates the two skip warnings. `startHeartbeats` passes `{ warnSkips: true }`; the eligibility probe at :746 calls `heartbeatSpecs()` (silent).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/connection-heartbeat-health.test.js`. Read that file first for its connection-build harness (identity bindings, `node.setAdvertisedHealth`). The new test builds a connection whose heartbeat is enabled and that has an **additional Local Identity binding with heartbeat on but outbound disabled** (the :2225 skip case), captures `node.warn`, and asserts:

```js
test('setAdvertisedHealth probe does not emit start-phrased heartbeat warnings (#225)', async () => {
  // Build a connection with heartbeatEnabled true, allowMultipleIdentities true,
  // and one additional identity binding { heartbeat: true, allowOutbound: false }
  // (see this file's existing multi-identity setup). Capture warnings:
  const warnings = [];
  node.warn = (m) => warnings.push(String(m));

  // A health assertion to the (health-driven) default identity runs the
  // eligibility probe, which calls heartbeatSpecs() — it must stay silent.
  node.setAdvertisedHealth(node.localIdentity, { state: 'nominal', ttl_s: 30 });
  assert.ok(
    !warnings.some((w) => /cannot start heartbeat|outbound disabled/.test(w)),
    `probe should not warn about skipped identities, got: ${JSON.stringify(warnings)}`
  );
});

test('the heartbeat start path still warns about skipped additional identities (#225)', async () => {
  const warnings = [];
  node.warn = (m) => warnings.push(String(m));
  // Drive the start path (startHeartbeats) the way this file already does, or
  // call node’s exposed start; the outbound-disabled additional identity must
  // still produce the ":2225" warning.
  // ...start heartbeats...
  assert.ok(
    warnings.some((w) => /outbound disabled/.test(w)),
    `start path should warn, got: ${JSON.stringify(warnings)}`
  );
});
```

Implementer: adapt to the file's actual harness (how it constructs the node, whether `startHeartbeats` is reachable or driven via a lifecycle hook). The binding requirements are the two assertions above: **probe silent, start path warns.** If the start path is not directly callable in this harness, assert the start-path warning by calling the internal `heartbeatSpecs({ warnSkips: true })` if the test can reach it, or by the existing start lifecycle; keep the probe-silent assertion as the primary guard.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/connection-heartbeat-health.test.js`
Expected: FAIL — the probe currently emits the "outbound disabled" warning.

- [ ] **Step 3: Gate the warnings**

In `nodes/mavlink-ai-connection.js`, change `heartbeatSpecs()` to accept options and guard both `node.warn` calls:

```js
function heartbeatSpecs(options) {
  const warnSkips = Boolean(options && options.warnSkips);
  const specs = [];
  // ...unchanged default-identity push...
  if (node.allowMultipleIdentities) {
    for (const spec of node._identityBindings) {
      if (!spec.heartbeat) {
        continue;
      }
      let identity;
      try {
        identity = node.resolveLocalIdentity(spec.identity);
      } catch (err) {
        if (warnSkips) {
          node.warn(
            `mavlink-ai-connection '${node.name || node.id}': cannot start heartbeat for additional ` +
              `Local Identity '${spec.identity}': ${err.message}`
          );
        }
        continue;
      }
      if (spec.allowOutbound === false) {
        if (warnSkips) {
          node.warn(
            `mavlink-ai-connection '${node.name || node.id}': additional Local Identity ` +
              `'${identity.describe()}' has heartbeat enabled but outbound disabled; not sending its heartbeats.`
          );
        }
        continue;
      }
      // ...unchanged duplicate-default guard + push...
    }
  }
  return specs;
}
```

At the `startHeartbeats` call site (:2416), pass `{ warnSkips: true }`:

```js
const specs = heartbeatSpecs({ warnSkips: true });
```

Leave the eligibility-probe call at :746 as `heartbeatSpecs()` (silent). Update the `heartbeatSpecs()` JSDoc to note the `warnSkips` option and that the probe path is intentionally silent.

- [ ] **Step 4: Document IDENTITY_NOT_HEALTH_DRIVEN in the vehicle-state help**

In `nodes/mavlink-ai-vehicle-state.html`, replace the final Health-assertions sentence (currently: *"A rejected assertion (unknown identity or invalid health) is reported as a structured error on output 2."*) with wording that names the health-driven requirement:

```html
  <p>The target identity must be a <b>health-driven</b> Local Identity that this connection actually sends heartbeats for — e.g. the onboard-companion preset (CompID 191), which is health-driven by default. An assertion to a non-health-driven identity is rejected with <code>IDENTITY_NOT_HEALTH_DRIVEN</code>; an unknown identity or invalid <code>health</code> value is rejected with the corresponding code. All rejections are reported as a structured error on output 2.</p>
```

- [ ] **Step 5: Run tests, lint, commit**

Run: `node --test test/unit/connection-heartbeat-health.test.js`
Expected: PASS.
Then: `npm test`
Expected: PASS.

```bash
npm run lint
git add nodes/mavlink-ai-connection.js nodes/mavlink-ai-vehicle-state.html test/unit/connection-heartbeat-health.test.js
git commit -m "fix(#225): silence heartbeatSpecs probe warnings; document IDENTITY_NOT_HEALTH_DRIVEN"
```

---

## Self-Review

**Spec coverage (against Tier C #210 + #221 sliver + #225 follow-ups):**
- #210 editor validators mirror runtime clamps — Tasks 3 (module) + 4 (all 12 fields across 5 editors + drift/wiring spec). ✅ Covered every field the issue lists (command/mission timeout+retries, fanout timeout+retries+spacing+concurrency, swarm stale+expiry+interval, connection heartbeat).
- #210 "shared editor/runtime validation rules" + "editor-spec and runtime tests proving identical acceptance/normalization" — shared `lib/util/numeric-bounds.js` is the single rule source; `numeric-bounds-editor-spec.test.js` proves editor == module; `numeric-bounds.test.js` proves the module encodes the runtime rules. ✅
- #221 sliver "keep status text concise via one shared helper" — Tasks 1 (helper) + 2 (all 20 Group-A sites). ✅ (i18n and stale-help parts of #221 are out of scope per the roadmap plan — declined/tracked separately.)
- #225 follow-up (a) heartbeatSpecs warn wording/spam — Task 5. ✅
- #225 follow-up (b) document IDENTITY_NOT_HEALTH_DRIVEN — Task 5. ✅

**Placeholder scan:** Task 2 Step 1 and Task 5 Step 1 intentionally hand the implementer a harness-adaptation instruction (the exact MockRED/connection setup lives in the referenced existing test files) rather than a fabricated harness that might not match. The *binding assertions* are concrete in both. No TBD/"add error handling"/vague steps elsewhere.

**Type/name consistency:** `truncateStatus` (Tasks 1–2) consistent. `mavlinkNumericBounds()` factory + method names `positive`/`nonNegativeInteger`/`nonNegative`/`atLeast`/`integerAtLeast` consistent between Task 4's editor mirror and its spec test. Module exports `acceptsPositive`/`acceptsNonNegativeInteger`/`acceptsNonNegative`/`acceptsAtLeast`/`acceptsIntegerAtLeast`/`isBlank` consistent between Tasks 3 and 4. `heartbeatSpecs({ warnSkips })` consistent between the two call sites in Task 5.

**Scope:** One focused PR (editor validation + status caps + two #225 doc/wording fixes). #212 (MAVLink In picker) is a separate PR with its own plan.
