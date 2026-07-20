# Protocol Wrapper Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every protocol-boundary behavior while reducing the shipped-code delta against `main` from `+162` lines to no more than `+110` lines.

**Architecture:** Replace repeated one-off enum lookups with one bound function that carries the enum index and error context. Reuse small local editor helpers for dialect loading and error serialization. Keep friendly-name policy in this package, but leave all numeric assignments in `node-mavlink` or the active dialect.

**Tech Stack:** Node.js 20+, CommonJS, `node-mavlink` 2.3.0 generated mappings, Node-RED editor/runtime APIs, `node:test`, ESLint.

## Global Constraints

- Preserve all runtime behavior, editor conveniences, custom-dialect support, error codes, structured error context, endpoints, and Node-RED message shapes.
- Add no aliases, numeric-string fallbacks, deprecation compatibility, or flow migration code.
- Preserve explicit numeric custom/dialect-external values only on existing generic or advanced/raw interfaces.
- Do not change transport, routing, queue, subscription, codec-workaround, or workflow state-machine ownership.
- Each consumer-migration commit must pass its focused tests and reduce or hold shipped line count; the completed plan must reach `+110` shipped lines or less.

---

### Task 1: Add one bound generated-value adapter

**Files:**
- Modify: `lib/protocol/protocol-values.js`
- Modify: `test/unit/protocol-values.test.js`

**Interfaces:**
- Produces: `bindEnumValues(index, context) -> value(enumName, memberKey)`
- Produces: `value.members(enumName) -> Array<{name, value}>`
- Produces: `coreEnumValues(context) -> value`
- Preserves temporarily: `requireEnumMember`, `enumMembers`, and `coreEnumMember` until all consumers migrate in Tasks 2-4

- [ ] **Step 1: Add failing bound-adapter tests**

Add these assertions to `test/unit/protocol-values.test.js` using the existing `ARDU`/generated imports in that file:

```js
test('bindEnumValues carries dialect and consumer context across lookups', () => {
  const value = bindEnumValues(ARDU.enums, {
    dialect: ARDU.name,
    consumer: 'bound-test'
  });
  assert.strictEqual(value('MavCmd', 'COMPONENT_ARM_DISARM'), common.MavCmd.COMPONENT_ARM_DISARM);
  assert.ok(value.members('MavResult').some((entry) => entry.name === 'ACCEPTED'));
  assert.throws(
    () => value('MavCmd', 'NOT_A_MEMBER'),
    (err) =>
      err.code === 'ENUM_VALUE_UNAVAILABLE' &&
      err.context.dialect === ARDU.name &&
      err.context.consumer === 'bound-test'
  );
});

test('coreEnumValues resolves public core mappings through the same adapter', () => {
  const value = coreEnumValues({ consumer: 'core-bound-test' });
  assert.strictEqual(value('MavComponent', 'AUTOPILOT1'), minimal.MavComponent.AUTOPILOT1);
});
```

Update the test import to include `bindEnumValues` and `coreEnumValues`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/unit/protocol-values.test.js
```

Expected: FAIL because `bindEnumValues` and `coreEnumValues` are not exported.

- [ ] **Step 3: Implement the minimal bound adapter**

Add to `lib/protocol/protocol-values.js`:

```js
function bindEnumValues(index, context = {}) {
  const value = (enumName, memberKey) =>
    requireEnumMember(index, enumName, memberKey, context);
  value.members = (enumName) => enumMembers(index, enumName, context);
  return value;
}

function coreEnumValues(context = {}) {
  return bindEnumValues(CORE_ENUMS, { dialect: 'common', ...context });
}
```

Export both functions alongside the temporary existing exports.

- [ ] **Step 4: Run focused tests and lint**

Run:

```powershell
node --test test/unit/protocol-values.test.js
npm.cmd run lint
```

Expected: protocol-value tests PASS and ESLint exits 0.

- [ ] **Step 5: Commit the adapter**

```powershell
git add lib/protocol/protocol-values.js test/unit/protocol-values.test.js
git commit -m "refactor: bind generated protocol value context"
```

---

### Task 2: Bind core values once per module

**Files:**
- Modify: `lib/move/setpoint.js`
- Modify: `lib/payload/components.js`
- Modify: `lib/runtime/send-priority.js`
- Modify: `nodes/mavlink-ai-formation.js`
- Modify: `nodes/mavlink-ai-local-identity.js`
- Test: `test/unit/move-setpoint.test.js`
- Test: `test/unit/payload-components.test.js`
- Test: `test/unit/send-priority.test.js`
- Test: `test/unit/formation-node.test.js`
- Test: `test/unit/profile-identity.test.js`

**Interfaces:**
- Consumes: `coreEnumValues({ consumer })`
- Produces: no public behavior change; existing constants retain generated numeric values

- [ ] **Step 1: Run characterization tests before refactoring**

```powershell
node --test test/unit/move-setpoint.test.js test/unit/payload-components.test.js test/unit/send-priority.test.js test/unit/formation-node.test.js test/unit/profile-identity.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Replace repeated core lookups with one module binding**

Use this pattern once in each module:

```js
const { coreEnumValues } = require('../protocol/protocol-values');
const protocolValue = coreEnumValues({ consumer: 'move' });
```

For files under `nodes/`, use the node-layer relative path:

```js
const { coreEnumValues } = require('../lib/protocol/protocol-values');
```

Then replace calls such as:

```js
coreEnumMember('PositionTargetTypemask', 'X_IGNORE', { consumer: 'move' })
```

with:

```js
protocolValue('PositionTargetTypemask', 'X_IGNORE')
```

Use the correct existing consumer string in each module: `move`, `payload-components`, `send-priority`, `formation`, and `local-identity`. Do not add a shared global resolver across consumers because that would lose error attribution.

- [ ] **Step 3: Run characterization tests after refactoring**

Run the Step 1 command again.

Expected: all tests PASS with identical assertions.

- [ ] **Step 4: Check that shipped code did not grow**

```powershell
git diff --numstat HEAD -- lib nodes
```

Expected: additions do not exceed deletions for this task's production files. If they do, simplify the call-site conversion before committing.

- [ ] **Step 5: Commit core consumer migration**

```powershell
git add lib/move/setpoint.js lib/payload/components.js lib/runtime/send-priority.js nodes/mavlink-ai-formation.js nodes/mavlink-ai-local-identity.js
git commit -m "refactor: reuse bound core protocol values"
```

---

### Task 3: Bind active-dialect values once per operation

**Files:**
- Modify: `lib/command/command-workflow.js`
- Modify: `lib/command/flight-modes.js`
- Modify: `lib/command/param-resolvers.js`
- Modify: `lib/mission/mission-state-machine.js`
- Modify: `lib/move/setpoint.js`
- Modify: `lib/param/param-encoding.js`
- Modify: `lib/param/param-workflow.js`
- Modify: `lib/payload/payload.js`
- Modify: `lib/swarm/vehicle-registry.js`
- Modify: `nodes/mavlink-ai-command.js`
- Test: existing focused unit tests for each consumer

**Interfaces:**
- Consumes: `bindEnumValues(index, { dialect, consumer })`
- Produces: the same numeric outputs and `ENUM_VALUE_UNAVAILABLE` context as current `HEAD`

- [ ] **Step 1: Run active-consumer characterization tests**

```powershell
node --test test/unit/command-workflow.test.js test/unit/mission-workflow.test.js test/unit/move-setpoint.test.js test/unit/param-encoding.test.js test/unit/param-workflow.test.js test/unit/payload-node.test.js test/unit/vehicle-registry.test.js test/unit/command-node.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Bind once in stateful constructors**

For `CommandSend`, mission state machines, parameter workflows, and `VehicleRegistry`, create one resolver after `this.enums` and `this.dialect` are assigned:

```js
const value = bindEnumValues(this.enums, {
  dialect: this.dialect,
  consumer: 'vehicle-registry'
});
```

Resolve every constructor-owned constant through `value(...)`. Keep the resolved numbers on the existing instance properties so workflow behavior and hot paths remain unchanged.

- [ ] **Step 3: Bind once in pure operations**

For flight modes, move, parameter encoding, payload building, parameter choices, and the command node, bind at the outermost function that already receives the enum index:

```js
const value = bindEnumValues(opts.enums, {
  dialect: opts.dialect || 'unknown',
  consumer: 'payload'
});
```

Pass `value` through the existing options object only where nested builders need it. Delete local helpers whose only job was rebuilding the same context, including `protocolValue` in `lib/payload/payload.js`.

Simplify payload action resolution to:

```js
function resolveAction(table, name, enumName, value, code, label) {
  const member = table[String(name || '').toLowerCase()];
  if (member === undefined) {
    throw new MavlinkError(code, `${label} must be one of ${Object.keys(table).join('/')} (got '${name}').`);
  }
  return value(enumName, member);
}
```

- [ ] **Step 4: Use the bound member-list API**

Replace `enumMembers(index, enumName, context)` with `value.members(enumName)` in flight-mode and parameter-choice code. Do not change filtering, ordering, or returned editor choice shapes.

- [ ] **Step 5: Run active-consumer tests after refactoring**

Run the Step 1 command again.

Expected: all tests PASS, including the existing missing-member context tests.

- [ ] **Step 6: Check the production line delta**

```powershell
git diff --numstat HEAD -- lib nodes
```

Expected: this task deletes more shipped lines than it adds. If not, remove pass-through helpers and repeated context objects before committing.

- [ ] **Step 7: Commit active-dialect migration**

```powershell
git add lib/command/command-workflow.js lib/command/flight-modes.js lib/command/param-resolvers.js lib/mission/mission-state-machine.js lib/move/setpoint.js lib/param/param-encoding.js lib/param/param-workflow.js lib/payload/payload.js lib/swarm/vehicle-registry.js nodes/mavlink-ai-command.js
git commit -m "refactor: reuse bound dialect protocol values"
```

---

### Task 4: Consolidate editor dialect and error plumbing

**Files:**
- Modify: `lib/editor-api.js`
- Modify: `test/unit/editor-api.test.js`

**Interfaces:**
- Preserves: `GET /mavlink-ai/modes`
- Preserves: `GET /mavlink-ai/param-choices`
- Preserves: `GET /mavlink-ai/protocol-values`
- Produces local helper: `editorDialect(req, required)` returning a valid bundle or `null`
- Produces local helper: `editorFailure(res, err, fallbackCode)` returning the existing 400 response shape

- [ ] **Step 1: Run editor characterization tests**

```powershell
node --test test/unit/editor-api.test.js
```

Expected: all tests PASS, including missing/invalid dialect and protocol-value endpoint cases.

- [ ] **Step 2: Add local editor helpers**

Add `MavlinkError` to the imports and define:

```js
function editorDialect(req, required = false) {
  const dialect = String(req.query.dialect || '');
  if (!dialect) {
    if (required) {
      throw new MavlinkError(
        'DIALECT_REQUIRED',
        'Flight-mode choices require the active Vehicle Profile dialect.'
      );
    }
    return null;
  }
  const customDialectPath = req.query.customDialectPath
    ? String(req.query.customDialectPath)
    : '';
  const bundle = loadDialect(dialect, customDialectPath ? { customDialectPath } : {});
  if (!bundle.valid) {
    throw bundle.error;
  }
  return bundle;
}

function editorFailure(res, err, fallbackCode) {
  res.status(400).json({
    ok: false,
    error: {
      code: err.code || fallbackCode,
      message: err.message,
      context: err.context || {}
    }
  });
}
```

- [ ] **Step 3: Replace route duplication**

In `/mavlink-ai/modes`, call `editorDialect(req, true)` inside the existing `try` and use `editorFailure(res, err, 'MODE_CHOICES_FAILED')` in `catch`.

In `/mavlink-ai/param-choices`, call `editorDialect(req)` once. When it returns a bundle, use `bundle.enums` for `enumIndex` and retain `buildMetadata(...)` for the metadata enum shape. Use `editorFailure(res, err, 'PARAM_CHOICES_FAILED')` in `catch`.

Bind `/mavlink-ai/protocol-values` once at module scope with `coreEnumValues({ consumer: 'editor-api' })` and preserve the exact JSON response.

- [ ] **Step 4: Run editor tests and lint**

```powershell
node --test test/unit/editor-api.test.js
npm.cmd run lint
```

Expected: tests PASS and lint exits 0.

- [ ] **Step 5: Verify editor code shrank and commit**

```powershell
git diff --numstat HEAD -- lib/editor-api.js
git add lib/editor-api.js test/unit/editor-api.test.js
git commit -m "refactor: consolidate editor dialect handling"
```

Expected: `lib/editor-api.js` has a negative net line delta for this task.

---

### Task 5: Remove transitional lookup APIs and shorten touched fixtures

**Files:**
- Modify: `lib/protocol/protocol-values.js`
- Modify: `test/unit/protocol-values.test.js`

**Interfaces:**
- Removes: `requireEnumMember`, `enumMembers`, and `coreEnumMember` exports
- Keeps: `bindEnumValues` and `coreEnumValues`

- [ ] **Step 1: Prove no production consumer uses transitional APIs**

```powershell
rg -n "requireEnumMember|enumMembers|coreEnumMember" lib nodes -g "*.js"
```

Expected: hits only inside `lib/protocol/protocol-values.js`. If consumers remain, migrate them before proceeding.

- [ ] **Step 2: Replace direct-helper tests with bound-adapter tests**

Keep the same success, missing enum/member context, exact-key rejection, and member-list assertions, but exercise them through `bindEnumValues` and `coreEnumValues`. Do not combine or delete test cases.

- [ ] **Step 3: Remove transitional exports**

Make `requireEnumMember` and `enumMembers` private implementation details and delete `coreEnumMember`. Export only:

```js
module.exports = { bindEnumValues, coreEnumValues };
```

- [ ] **Step 4: Run protocol and affected focused tests**

```powershell
node --test test/unit/protocol-values.test.js test/unit/editor-api.test.js test/unit/command-workflow.test.js test/unit/mission-workflow.test.js test/unit/move-setpoint.test.js test/unit/param-workflow.test.js test/unit/payload-node.test.js test/unit/vehicle-registry.test.js
npm.cmd run lint
```

Expected: all tests PASS and lint exits 0.

- [ ] **Step 5: Commit final API cleanup**

```powershell
git add lib/protocol/protocol-values.js test
git commit -m "refactor: remove unbound protocol lookup API"
```

---

### Task 6: Audit, measure, verify, and update PR #309

**Files:**
- Modify only if measurement wording changes: `README.md`, `CHANGELOG.md`
- Do not modify: approved protocol-boundary or slimming design specs except to fix a discovered contradiction

**Interfaces:**
- Produces: verified branch pushed to `origin/refactor/protocol-data-boundary`
- Updates: existing ready-for-review PR #309; does not open a second PR

- [ ] **Step 1: Run the copied-assignment audit**

```powershell
rg -n "const MAV_[A-Z0-9_]*\s*=\s*(0x[0-9A-Fa-f]+|[0-9]+)|Number\([^)]*command[^)]*\)\s*===\s*[0-9]+|new Set\(\[[0-9, ]+\]\)" lib nodes -g "*.js" -g "*.html"
```

Expected: no copied MAVLink enum assignment or numeric command comparison.

- [ ] **Step 2: Measure shipped-code delta**

```powershell
$rows = git diff --numstat main...HEAD | ForEach-Object {
  $p = $_ -split "`t"
  if ($p[2] -like 'lib/*' -or $p[2] -like 'nodes/*' -or $p[2] -like 'examples/*') {
    [pscustomobject]@{ Add = [int]$p[0]; Del = [int]$p[1] }
  }
}
$added = ($rows | Measure-Object Add -Sum).Sum
$deleted = ($rows | Measure-Object Del -Sum).Sum
"shipped added=$added deleted=$deleted net=$($added - $deleted)"
```

Expected: shipped net is `+110` or lower. If it is higher, inspect remaining repeated bindings and editor plumbing; do not remove behavior or code-golf to hit the number.

- [ ] **Step 3: Run complete verification**

```powershell
npm.cmd test
npm.cmd run lint
git diff --check main...HEAD
git status --short
```

Expected: smoke loads 15 node types; 884 or more unit tests pass; 21 integration tests pass; lint and whitespace checks exit 0; worktree is clean after the final commit.

- [ ] **Step 4: Commit any final documentation-only correction**

Only if Step 2 or the audit requires a wording correction:

```powershell
git add README.md CHANGELOG.md
git commit -m "docs: clarify thin protocol wrapper boundary"
```

- [ ] **Step 5: Push and verify PR head**

```powershell
git push origin refactor/protocol-data-boundary
$localHead = git rev-parse HEAD
$remoteHead = git ls-remote origin refs/heads/refactor/protocol-data-boundary | ForEach-Object { ($_ -split "`t")[0] }
if ($localHead -ne $remoteHead) { throw "remote head does not match local head" }
gh pr view 309 --repo cmc0619/node-red-contrib-mavlink-ai --json url,isDraft,state,headRefOid
```

Expected: local and remote SHA match; PR #309 is open and not a draft.
