# Protocol Data Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed `node-mavlink` generated mappings authoritative for MAVLink enum names and numeric assignments throughout this repository, removing copied protocol tables, numeric fallbacks, and feature-specific aliases as a deliberate breaking change.

**Architecture:** Add a strict `lib/protocol/protocol-values.js` boundary over the existing permissive raw enum resolver. Code with an active Vehicle Profile resolves through that profile's dialect index; pre-profile protocol defaults resolve through a cached `minimal`/`standard`/`common` index built from public `node-mavlink` exports. Project policy remains local, but it is expressed only with exact generated member keys and is converted to numbers at the protocol boundary.

**Tech Stack:** Node.js CommonJS, Node-RED nodes/editor APIs, `node-mavlink` 2.3.0 public dialect exports, generated `mavlink-mappings`, `node:test`, ESLint.

## Global Constraints

- Implement the approved design in [2026-07-20-protocol-data-boundary-design.md](../specs/2026-07-20-protocol-data-boundary-design.md).
- This is a clean break. Do not add aliases, compatibility branches, deprecation warnings, or migrations for old feature-specific names.
- The exact forward key on a generated enum object is canonical: `COMPONENT_ARM_DISARM`, `GLOBAL_INT`, `FLY_BY_WIRE_A`, and so on.
- The generic builder and explicit raw/scoped enum resolver continue accepting fully qualified MAVLink names and raw numeric custom IDs. That is an advanced protocol interface, not compatibility behavior.
- Do not upgrade, fork, patch, or submit changes to `node-mavlink` or `mavlink-mappings`.
- Do not remove the repository's tested `node-mavlink` 2.3.0 codec workarounds or replace its connection, routing, queue, subscription, signing-state, or workflow architecture.
- Keep public decoded and outbound Node-RED message shapes unchanged.
- Use generated exports in assertions. Tests must not replace one copied numeric table with another copied numeric fixture.
- Use `MavlinkError('ENUM_VALUE_UNAVAILABLE', ...)` for missing strict enum data, including `enum`, `member`, `dialect`, and `consumer` in `error.context`.
- After every task, run the listed focused tests and commit only that task's coherent changes.

---

## Task 1: Add the strict protocol-value boundary

**Files:**

- Create: `lib/protocol/protocol-values.js`
- Create: `test/unit/protocol-values.test.js`
- Reference without changing behavior: `lib/protocol/enum-resolver.js:54-106,150-176`
- Reference: `lib/util/errors.js:9-16`
- Fixture: `test/fixtures/dialects/custom_enum.xml`

- [ ] **Step 1: Write failing tests for core, active, merged, and custom dialect resolution**

  Cover these exact contracts:

  ```js
  const { minimal, common } = require('node-mavlink');
  const { loadDialect } = require('../../lib/dialects/dialect-loader');
  const {
    requireEnumMember,
    enumMembers,
    coreEnumMember
  } = require('../../lib/protocol/protocol-values');

  assert.strictEqual(
    coreEnumMember('MavComponent', 'AUTOPILOT1', { consumer: 'test' }),
    minimal.MavComponent.AUTOPILOT1
  );

  const ardu = loadDialect('ardupilotmega');
  assert.strictEqual(
    requireEnumMember(ardu.enums, 'MavCmd', 'COMPONENT_ARM_DISARM', {
      dialect: ardu.name,
      consumer: 'test'
    }),
    common.MavCmd.COMPONENT_ARM_DISARM
  );
  assert.strictEqual(
    requireEnumMember(ardu.enums, 'CopterMode', 'GUIDED', {
      dialect: ardu.name,
      consumer: 'test'
    }),
    require('node-mavlink').ardupilotmega.CopterMode.GUIDED
  );
  ```

  Load `custom_enum.xml` with `loadDialect('custom', { customDialectPath })` and assert that `CustomColor.WHITE` resolves and appears in `enumMembers`.

- [ ] **Step 2: Write failing strictness and diagnostic tests**

  Assert that `requireEnumMember` rejects all of the following with `ENUM_VALUE_UNAVAILABLE`:

  - `MavFrame` + `MAV_FRAME_GLOBAL_INT` (prefixed alternate, not a forward key)
  - `MavFrame` + `'5'`
  - `MavFrame` + `5`
  - an unknown enum
  - an unknown member

  Verify the error context exactly:

  ```js
  assert.deepStrictEqual(err.context, {
    enum: 'MavFrame',
    member: 'NOT_REAL',
    dialect: 'ardupilotmega',
    consumer: 'test'
  });
  ```

  Also prove the intentional raw path remains permissive:

  ```js
  assert.strictEqual(resolveInEnum(ardu.enums, 'MavFrame', 'MAV_FRAME_GLOBAL_INT'), common.MavFrame.GLOBAL_INT);
  assert.strictEqual(resolveInEnum(ardu.enums, 'MavFrame', '230'), 230);
  ```

- [ ] **Step 3: Run the new test and confirm the module is missing**

  Run:

  ```powershell
  node --test test/unit/protocol-values.test.js
  ```

  Expected: FAIL with `MODULE_NOT_FOUND` for `lib/protocol/protocol-values.js`.

- [ ] **Step 4: Implement the strict boundary**

  Implement this interface, without exporting the cached index itself:

  ```js
  'use strict';

  const { minimal, standard, common } = require('node-mavlink');
  const { buildEnumIndex } = require('./enum-resolver');
  const { MavlinkError } = require('../util/errors');

  const CORE_ENUMS = buildEnumIndex([minimal, standard, common]);

  function unavailable(enumName, memberKey, context = {}) {
    const errorContext = {
      enum: enumName,
      member: memberKey,
      dialect: context.dialect || 'unknown',
      consumer: context.consumer || 'unknown'
    };
    return new MavlinkError(
      'ENUM_VALUE_UNAVAILABLE',
      `Cannot resolve ${enumName}.${String(memberKey)} for ${errorContext.consumer} in dialect '${errorContext.dialect}'.`,
      errorContext
    );
  }

  function requireEnumMember(index, enumName, memberKey, context = {}) {
    const table = index && index.enumsByName && index.enumsByName[enumName];
    if (!table || typeof memberKey !== 'string' || typeof table[memberKey] !== 'number') {
      throw unavailable(enumName, memberKey, context);
    }
    return table[memberKey];
  }

  function enumMembers(index, enumName, context = {}) {
    const table = index && index.enumsByName && index.enumsByName[enumName];
    if (!table) {
      throw unavailable(enumName, null, context);
    }
    return Object.entries(table)
      .filter(([key, value]) => !/^\d+$/.test(key) && typeof value === 'number')
      .map(([name, value]) => ({ name, value }));
  }

  function coreEnumMember(enumName, memberKey, context = {}) {
    return requireEnumMember(CORE_ENUMS, enumName, memberKey, {
      dialect: 'common',
      ...context
    });
  }

  module.exports = { requireEnumMember, enumMembers, coreEnumMember };
  ```

  Do not uppercase, trim, prefix-strip, or coerce `memberKey`; strict callers must supply the exact generated key.

- [ ] **Step 5: Run focused protocol tests**

  Run:

  ```powershell
  node --test test/unit/protocol-values.test.js test/unit/enum-resolver.test.js test/unit/dialect-loader-cache.test.js
  ```

  Expected: PASS. Existing permissive resolver behavior remains unchanged.

- [ ] **Step 6: Commit**

  ```powershell
  git add lib/protocol/protocol-values.js test/unit/protocol-values.test.js
  git commit -m "feat: add strict protocol value boundary"
  ```

---

## Task 2: Replace copied ArduPilot flight modes with generated enums

**Files:**

- Modify: `lib/command/flight-modes.js:21-116,163-312`
- Modify: `lib/command/param-resolvers.js:1-55`
- Modify: `lib/editor-api.js:3,101-139`
- Modify: `nodes/mavlink-ai-command.js:329-347`
- Modify: `nodes/mavlink-ai-command.html:223-231,301-326`
- Modify: `lib/swarm/vehicle-registry.js:306-322` (call-site only; constant cleanup is Task 8)
- Modify: `test/unit/command-workflow.test.js:262-322`
- Modify: `test/unit/param-controls.test.js:70-76`
- Modify: `test/unit/editor-api.test.js:97-128`
- Modify: `test/unit/vehicle-registry.test.js`

- [ ] **Step 1: Change tests to the new context-object API and generated expectations**

  Replace the positional flight-mode API with a deliberate clean interface:

  ```js
  knownModes({ firmware, vehicleType, enums, dialect })
  modeChoices({ firmware, vehicleType, enums, dialect })
  resolveFlightMode({ firmware, vehicleType, enums, dialect }, modeName)
  modeNameForCustomMode({ firmware, vehicleType, enums, dialect }, customMode)
  ```

  In tests, create:

  ```js
  const { ardupilotmega, common } = require('node-mavlink');
  const ARDU_BUNDLE = loadDialect('ardupilotmega');
  const COPTER = {
    firmware: 'ardupilot',
    vehicleType: 'copter',
    enums: ARDU_BUNDLE.enums,
    dialect: ARDU_BUNDLE.name
  };
  ```

  Assert values against `ardupilotmega.CopterMode`, `PlaneMode`, `RoverMode`, `SubMode`, and `TrackerMode`; assert `base_mode` against `common.MavModeFlag.CUSTOM_MODE_ENABLED`.

- [ ] **Step 2: Add explicit breaking-name tests**

  Verify generated additions and exact spelling:

  - Plane and Rover expose `INITIALIZING`.
  - Sub exposes `SURFTRAK` and `MOTORDETECT`.
  - Plane exposes `FLY_BY_WIRE_A` and `FLY_BY_WIRE_B`.
  - `FBWA`, `FBWB`, `MOTOR_DETECT`, `INITIALISING`, lowercase `guided`, and normalized `alt hold` throw `UNKNOWN_MODE`.
  - PX4's intentional `POSITION` and `RETURN` aliases and main/sub packing still pass.

- [ ] **Step 3: Add editor API tests requiring the profile dialect**

  Call both `/mavlink-ai/modes` and the `profile-flight-mode` `/mavlink-ai/param-choices` resolver with `dialect: 'ardupilotmega'`. Assert `FLY_BY_WIRE_A` is returned and `FBWA` is absent. Add an invalid/missing-dialect assertion that returns `{ ok: false, error }` rather than a copied fallback list.

- [ ] **Step 4: Run the focused tests and confirm failures against copied tables**

  Run:

  ```powershell
  node --test test/unit/command-workflow.test.js test/unit/param-controls.test.js test/unit/editor-api.test.js test/unit/vehicle-registry.test.js
  ```

  Expected: FAIL on the new signatures and generated-only mode names.

- [ ] **Step 5: Implement generated ArduPilot mode lookup**

  Delete `ARDUPILOT_MODES`. Retain the PX4 tables and intentional PX4 aliases. Add only this project-policy mapping:

  ```js
  const ARDUPILOT_MODE_ENUM = {
    copter: 'CopterMode',
    plane: 'PlaneMode',
    rover: 'RoverMode',
    boat: 'RoverMode',
    sub: 'SubMode',
    'antenna-tracker': 'TrackerMode'
  };
  ```

  Use `enumMembers` for choices/reverse lookup and `requireEnumMember` for forward lookup and `MavModeFlag.CUSTOM_MODE_ENABLED`. For ArduPilot, compare `modeName` exactly as supplied; do not normalize case, whitespace, dots, or hyphens. Continue the existing PX4 normalization only inside the PX4 branch.

- [ ] **Step 6: Thread the active dialect context through every caller**

  - Command node: pass the selected profile bundle's `enums` and `name`.
  - Vehicle registry: pass `this.enums` and a constructor `dialect` value into reverse lookup.
  - Parameter resolver: include `enumIndex` and `dialect` in its context; do not confuse the metadata enum arrays currently named `enums` with the runtime dialect index.
  - `/mavlink-ai/modes`: load the requested dialect with `loadDialect`; return the invalid bundle error instead of falling back.
  - `/mavlink-ai/param-choices`: load both metadata and the active dialect bundle and pass `bundle.enums` as `enumIndex`.
  - Command editor: include `currentDialect().dialect` and `customDialectPath` in the modes request.

- [ ] **Step 7: Run flight-mode and node tests**

  Run:

  ```powershell
  node --test test/unit/command-workflow.test.js test/unit/command-node.test.js test/unit/param-controls.test.js test/unit/editor-api.test.js test/unit/vehicle-registry.test.js
  ```

  Expected: PASS. The command node still accepts a raw numeric `custom_mode`, but old ArduPilot names fail.

- [ ] **Step 8: Commit**

  ```powershell
  git add lib/command/flight-modes.js lib/command/param-resolvers.js lib/editor-api.js nodes/mavlink-ai-command.js nodes/mavlink-ai-command.html lib/swarm/vehicle-registry.js test/unit/command-workflow.test.js test/unit/command-node.test.js test/unit/param-controls.test.js test/unit/editor-api.test.js test/unit/vehicle-registry.test.js
  git commit -m "refactor: derive ArduPilot modes from dialect data"
  ```

---

## Task 3: Migrate command results, critical priority, and command comparisons

**Files:**

- Modify: `lib/command/command-workflow.js:23-25,60-107,335-360,458-464`
- Modify: `lib/runtime/send-priority.js:1-72,109`
- Modify: `nodes/mavlink-ai-command.js:458-471,559-579`
- Modify: `nodes/mavlink-ai-formation.js:61,89-93`
- Modify: `test/unit/command-workflow.test.js`
- Modify: `test/unit/send-priority.test.js`
- Modify: `test/unit/command-node.test.js`
- Modify: `test/unit/formation-node.test.js`

- [ ] **Step 1: Write failing generated-value tests**

  - Construct `CommandSend` with `{ enums: bundle.enums, dialect: bundle.name }` and compare ACK behavior to `common.MavResult.ACCEPTED` and `IN_PROGRESS`.
  - Delete imports/assertions against exported local `MAV_RESULT_ACCEPTED` and `MAV_RESULT_IN_PROGRESS` constants.
  - Build the critical command list in tests from `common.MavCmd.COMPONENT_ARM_DISARM`, `DO_SET_MODE`, `DO_FLIGHTTERMINATION`, and `DO_PARACHUTE`.
  - Assert Formation accepts the exact full raw name `MAV_CMD_DO_REPOSITION`, numeric `common.MavCmd.DO_REPOSITION`, and its numeric-string raw form, but rejects the feature alias `DO_REPOSITION`.
  - Add a `CommandSend` construction test where `MavResult` is absent and assert complete `ENUM_VALUE_UNAVAILABLE` context.

- [ ] **Step 2: Run focused tests and confirm failure**

  ```powershell
  node --test test/unit/command-workflow.test.js test/unit/send-priority.test.js test/unit/command-node.test.js test/unit/formation-node.test.js
  ```

  Expected: FAIL because command results and command IDs are still local numbers.

- [ ] **Step 3: Resolve command results at workflow construction**

  In `CommandSend`, set instance values with strict active-dialect lookup:

  ```js
  const context = { dialect: opts.dialect, consumer: 'command' };
  this.acceptedResult = requireEnumMember(opts.enums, 'MavResult', 'ACCEPTED', context);
  this.inProgressResult = requireEnumMember(opts.enums, 'MavResult', 'IN_PROGRESS', context);
  ```

  Branch on those instance fields. Remove the two exported numeric result constants. Preserve ACK matching, retry, confirmation, lock, progress, and output behavior unchanged.

- [ ] **Step 4: Express critical priority as generated policy**

  Keep the local priority bands, but replace `CRITICAL_COMMANDS` numeric literals with exact generated keys resolved through `coreEnumMember('MavCmd', key, { consumer: 'send-priority' })`. Keep `commandPriorityFor` scoped to `MavCmd`, and keep unresolvable raw names at normal priority so encoding remains the error owner.

- [ ] **Step 5: Remove copied comparisons in Command and Formation nodes**

  - Command node: resolve `MavCmd.DO_SET_MODE` from the active bundle and compare only the resolved numeric command.
  - Pass `dialect: bundle.name` into `CommandSend`.
  - Formation: derive the reposition numeric ID with `coreEnumMember`; compare the exact fully qualified raw name or an explicitly numeric value/string to that generated ID. Delete the feature alias and copied numeric string from the local set.

- [ ] **Step 6: Run focused tests**

  ```powershell
  node --test test/unit/command-workflow.test.js test/unit/send-priority.test.js test/unit/command-node.test.js test/unit/formation-node.test.js test/unit/fanout.test.js
  ```

  Expected: PASS, including explicit raw numeric commands.

- [ ] **Step 7: Commit**

  ```powershell
  git add lib/command/command-workflow.js lib/runtime/send-priority.js nodes/mavlink-ai-command.js nodes/mavlink-ai-formation.js test/unit/command-workflow.test.js test/unit/send-priority.test.js test/unit/command-node.test.js test/unit/formation-node.test.js test/unit/fanout.test.js
  git commit -m "refactor: resolve command protocol values from mappings"
  ```

---

## Task 4: Migrate mission types, results, and coordinate frames

**Files:**

- Modify: `lib/mission/mission-state-machine.js:42-92,100-118,438-447`
- Modify: `lib/mission/mission-download.js:3-8,120-130,163,183,214-238`
- Modify: `lib/mission/mission-upload.js:3,169-188`
- Modify: `lib/mission/mission-clear.js:3,60-78`
- Modify: `nodes/mavlink-ai-mission.js:226-275`
- Modify: `test/unit/mission-workflow.test.js`
- Modify: `test/unit/mission-node.test.js`
- Modify: `test/unit/lock-mission.test.js`

- [ ] **Step 1: Replace numeric mission expectations with generated exports**

  Use `common.MavMissionType`, `common.MavMissionResult`, and `common.MavFrame` in tests. Ensure the shared mission test-option helper supplies both `enums` and `dialect` by default.

  Add failure tests for a dialect index missing each required enum. Preserve tests proving raw numeric mission types still work as explicit advanced identifiers.

- [ ] **Step 2: Change `extractItem` tests to receive a generated global-frame set**

  Change the pure helper contract to:

  ```js
  extractItem(fields, messageName, globalFrames)
  ```

  Build the test set from generated `common.MavFrame` values. Assert local frames retain local coordinates and every generated global frame converts `x/y` from degE7.

- [ ] **Step 3: Run focused mission tests and confirm failure**

  ```powershell
  node --test test/unit/mission-workflow.test.js test/unit/mission-node.test.js test/unit/lock-mission.test.js
  ```

  Expected: FAIL on removed module constants and the new `extractItem` contract.

- [ ] **Step 4: Resolve mission policy in `MissionWorkflow`**

  Replace numeric maps with project policy expressed as member keys:

  ```js
  const MISSION_TYPE_MEMBERS = {
    mission: 'MISSION',
    fence: 'FENCE',
    rally: 'RALLY',
    all: 'ALL'
  };

  const GLOBAL_FRAME_MEMBERS = [
    'GLOBAL',
    'GLOBAL_RELATIVE_ALT',
    'GLOBAL_INT',
    'GLOBAL_RELATIVE_ALT_INT',
    'GLOBAL_TERRAIN_ALT',
    'GLOBAL_TERRAIN_ALT_INT'
  ];
  ```

  During construction, strictly resolve `MavMissionResult.ACCEPTED`, `MavMissionType.ALL`, and every global frame against `opts.enums`. Make `missionTypeToNumber(value, enums, context)` translate friendly names to exact members, while continuing to send explicit numeric custom IDs through unchanged and fully qualified raw names through `resolveInEnum`.

- [ ] **Step 5: Use instance protocol values in all mission subclasses**

  - Download, Upload, and Clear compare with `this.missionAccepted`.
  - Download sends its ACK with `this.missionAccepted` and passes `this.globalFrames` into `extractItem`.
  - Download's special ALL behavior uses `this.missionTypeAll`.
  - Remove `MAV_MISSION_ACCEPTED` and `GLOBAL_FRAMES` exports.
  - Mission node passes `dialect: bundle.name`; compare the friendly name `missionTypeName !== 'all'` when choosing the clear wait default instead of comparing to `255`.

- [ ] **Step 6: Run mission tests**

  ```powershell
  node --test test/unit/mission-workflow.test.js test/unit/mission-node.test.js test/unit/lock-mission.test.js
  ```

  Expected: PASS with sequencing, retries, address matching, and output shapes unchanged.

- [ ] **Step 7: Commit**

  ```powershell
  git add lib/mission nodes/mavlink-ai-mission.js test/unit/mission-workflow.test.js test/unit/mission-node.test.js test/unit/lock-mission.test.js
  git commit -m "refactor: derive mission values from active dialect"
  ```

---

## Task 5: Migrate parameter types and capability bits

**Files:**

- Modify: `lib/param/param-workflow.js:28-58,60-139,257-281,602-724,966-978`
- Modify: `lib/param/param-encoding.js:15-57`
- Modify: `nodes/mavlink-ai-param.js:180-195`
- Modify: `test/unit/param-workflow.test.js`
- Modify: `test/unit/param-node.test.js`
- Modify: `test/unit/param-encoding.test.js`

- [ ] **Step 1: Write tests around generated parameter values**

  Derive type IDs from `common.MavParamType` and capability bits from `standard.MavProtocolCapability` (or the public dialect export that owns them). Remove raw type numbers such as `1`, `4`, and `6` from conversion assertions.

  Add tests proving:

  - the active dialect supplies all fixed-width integer types;
  - an absent `MavParamType.INT32` fails before send with `ENUM_VALUE_UNAVAILABLE`;
  - missing capability members fail with the same structured error;
  - exact-float-bit handling for NaN-pattern integers remains byte-exact.

- [ ] **Step 2: Run focused tests and confirm failure**

  ```powershell
  node --test test/unit/param-workflow.test.js test/unit/param-node.test.js test/unit/param-encoding.test.js
  ```

  Expected: FAIL because integer maps and capability bits are still copied numbers.

- [ ] **Step 3: Build integer conversion policy from exact `MavParamType` keys**

  Retain JavaScript accessors and ranges as local policy:

  ```js
  const INTEGER_PARAM_POLICY = {
    UINT8:  { view: 'Uint8',  range: [0, 0xff] },
    INT8:   { view: 'Int8',   range: [-0x80, 0x7f] },
    UINT16: { view: 'Uint16', range: [0, 0xffff] },
    INT16:  { view: 'Int16',  range: [-0x8000, 0x7fff] },
    UINT32: { view: 'Uint32', range: [0, 0xffffffff] },
    INT32:  { view: 'Int32',  range: [-0x80000000, 0x7fffffff] }
  };
  ```

  Add `buildIntegerParamPolicy(enums, dialect)` which resolves those keys with `requireEnumMember` and returns maps keyed by the generated numeric values. Construct it once per workflow and pass it explicitly to `projectParam`, `unionFloatToInt`, `unionIntToFloat`, `unionBitsToInt`, and `unionIntToBits`. This intentionally changes the internal/exported helper signatures; do not retain optional fallback behavior. Pass `bundle.name` into every Param workflow from `mavlink-ai-param.js`.

- [ ] **Step 4: Resolve capability bits from the active dialect**

  Change `resolveParamEncoding` to require `enums` and `dialect` in its options. Resolve `PARAM_ENCODE_BYTEWISE` and `PARAM_ENCODE_C_CAST` from `MavProtocolCapability`, convert each result with `BigInt`, and preserve the current bytewise-first precedence and firmware fallback when capability data itself is absent/unparseable.

  Pass the active profile bundle from `mavlink-ai-param.js`.

- [ ] **Step 5: Run focused parameter tests**

  ```powershell
  node --test test/unit/param-workflow.test.js test/unit/param-node.test.js test/unit/param-encoding.test.js test/unit/vehicle-capabilities.test.js
  ```

  Expected: PASS. Range policy and byte-union codec repairs remain unchanged.

- [ ] **Step 6: Commit**

  ```powershell
  git add lib/param/param-workflow.js lib/param/param-encoding.js nodes/mavlink-ai-param.js test/unit/param-workflow.test.js test/unit/param-node.test.js test/unit/param-encoding.test.js test/unit/vehicle-capabilities.test.js
  git commit -m "refactor: derive parameter protocol values from dialect"
  ```

---

## Task 6: Migrate move masks and frames

**Files:**

- Modify: `lib/move/setpoint.js:1-129,286,390-418`
- Modify: `nodes/mavlink-ai-move.js:525`
- Modify: `nodes/mavlink-ai-move.html:23-47,305`
- Modify: `test/unit/move-setpoint.test.js`
- Modify: `test/unit/move-node.test.js`
- Modify: `examples/02-vehicle-control/27-offboard-guided-move-sequence.json`

- [ ] **Step 1: Rewrite mask expectations from `PositionTargetTypemask`**

  Build expected masks using `common.PositionTargetTypemask.X_IGNORE`, `Y_IGNORE`, `Z_IGNORE`, `VX_IGNORE`, `VY_IGNORE`, `VZ_IGNORE`, `AX_IGNORE`, `AY_IGNORE`, `AZ_IGNORE`, `YAW_IGNORE`, `YAW_RATE_IGNORE`, and `FORCE_SET`. Do not assert copied binary masks.

- [ ] **Step 2: Make feature frame names canonical and add break tests**

  Change Move-node frame values from fully qualified source names to exact generated member keys:

  - `LOCAL_NED`
  - `LOCAL_OFFSET_NED`
  - `BODY_NED`
  - `BODY_OFFSET_NED`
  - `GLOBAL_INT`
  - `GLOBAL_RELATIVE_ALT_INT`
  - `GLOBAL_TERRAIN_ALT_INT`

  Assert `resolveFrame('LOCAL_NED', bundle.enums, context)` succeeds, while `MAV_FRAME_LOCAL_NED`, a numeric string, and a missing enum all fail. This is a feature-specific clean break; raw builder frame fields remain permissive elsewhere.

- [ ] **Step 3: Run move tests and confirm failure**

  ```powershell
  node --test test/unit/move-setpoint.test.js test/unit/move-node.test.js
  ```

  Expected: FAIL because masks and `FRAME_FALLBACK` are still local and the editor defaults use prefixed names.

- [ ] **Step 4: Compose masks from generated members**

  Resolve mask bits once from `coreEnumMember('PositionTargetTypemask', ...)`. Retain only the dimension grouping as project policy. Build `DIM_BITS` by OR-ing generated members, and set `FORCE_BIT` from generated `FORCE_SET`.

- [ ] **Step 5: Delete the frame fallback and use strict active lookup**

  Implement:

  ```js
  function resolveFrame(memberKey, enums, context) {
    return requireEnumMember(enums, 'MavFrame', memberKey, {
      ...context,
      consumer: 'move'
    });
  }
  ```

  Update warning comparisons, error text, node defaults, editor options, and the bundled move example to canonical member keys. Pass `bundle.name` as the Move builder's dialect context. Keep numeric `type_mask` custom input because it is explicitly a raw bitmask escape hatch, not an enum alias.

- [ ] **Step 6: Run focused move tests**

  ```powershell
  node --test test/unit/move-setpoint.test.js test/unit/move-node.test.js
  ```

  Expected: PASS with NED conversions, finite-field validation, and PX4 warnings unchanged.

- [ ] **Step 7: Commit**

  ```powershell
  git add lib/move/setpoint.js nodes/mavlink-ai-move.js nodes/mavlink-ai-move.html test/unit/move-setpoint.test.js test/unit/move-node.test.js examples/02-vehicle-control/27-offboard-guided-move-sequence.json
  git commit -m "refactor: derive move masks and frames from mappings"
  ```

---

## Task 7: Migrate payload actions and component choices

**Files:**

- Modify: `lib/payload/payload.js:1-68,120-342`
- Modify: `lib/payload/components.js:24-42`
- Modify: `lib/editor-api.js`
- Modify: `nodes/mavlink-ai-payload.js:140-155,225-275`
- Modify: `nodes/mavlink-ai-payload.html:32-43,120-150,201-215`
- Modify: `test/unit/payload-node.test.js`
- Modify: `test/unit/payload-components.test.js`
- Modify: `test/unit/editor-api.test.js`

- [ ] **Step 1: Replace payload numeric assertions with public generated exports**

  Cover `MavMountMode`, `GripperActions`, `GimbalManagerFlags`, `CameraMode`, `CameraZoomType`, `SetFocusType`, `WinchActions`, `ParachuteAction`, `MavCmd`, and `MavComponent` from `node-mavlink`.

  Add one missing-member test for a friendly action and assert `ENUM_VALUE_UNAVAILABLE` identifies `consumer: 'payload'`. Keep separate tests for an unknown friendly verb/action, which must retain its existing `BAD_*` error code.

- [ ] **Step 2: Add an editor protocol-values endpoint test**

  Add `GET /mavlink-ai/protocol-values` returning the small pre-profile subset the browser cannot import directly:

  ```json
  {
    "ok": true,
    "components": [
      { "name": "AUTOPILOT1", "value": 1 },
      { "name": "CAMERA", "value": 100 },
      { "name": "GIMBAL", "value": 154 },
      { "name": "MISSIONPLANNER", "value": 190 },
      { "name": "ONBOARD_COMPUTER", "value": 191 }
    ]
  }
  ```

  The test values must come from `node-mavlink`, not the literal example above. This endpoint will also remove Local Identity's browser-side copied component IDs in Task 8.

- [ ] **Step 3: Run focused tests and confirm failure**

  ```powershell
  node --test test/unit/payload-node.test.js test/unit/payload-components.test.js test/unit/editor-api.test.js
  ```

  Expected: FAIL on missing endpoint and generated-only payload mapping behavior.

- [ ] **Step 4: Express friendly payload policy with member keys**

  Convert maps to names, for example:

  ```js
  const CAMERA_MODES = { image: 'IMAGE', video: 'VIDEO', survey: 'IMAGE_SURVEY' };
  const CAMERA_ZOOM_TYPES = { step: 'STEP', continuous: 'CONTINUOUS', range: 'RANGE', focal: 'FOCAL_LENGTH' };
  const WINCH_ACTIONS = { relax: 'RELAXED', length: 'RELATIVE_LENGTH_CONTROL', rate: 'RATE_CONTROL' };
  ```

  Do the same for every payload action table. Change the builders' internal command policy from full source strings to exact `MavCmd` member keys. `buildPayload` must strictly resolve every command/action through `opts.enums`; delete `resolveCommand`'s string fallback. Pass `bundle.name` as `dialect` from the Payload node so strict errors identify the selected profile.

- [ ] **Step 5: Resolve component constants through the core boundary**

  Construct `MAV_COMP_ID.AUTOPILOT1`, `.CAMERA`, and `.GIMBAL` with `coreEnumMember('MavComponent', key, { consumer: 'payload-components' })`. Keep the exported plain numeric object so existing runtime consumers exchange no generated dependency objects.

- [ ] **Step 6: Remove browser-side component-number ownership**

  Populate the Payload component datalist from `/mavlink-ai/protocol-values` during `oneditprepare`. The persisted field remains a numeric component address and explicit custom component IDs remain valid. Remove hardcoded datalist values and numeric placeholder suggestions; descriptive help may mention protocol values but must not drive runtime behavior.

- [ ] **Step 7: Run payload/editor tests**

  ```powershell
  node --test test/unit/payload-node.test.js test/unit/payload-components.test.js test/unit/editor-api.test.js
  ```

  Expected: PASS. Friendly action labels remain, while their wire values come from the active dialect.

- [ ] **Step 8: Commit**

  ```powershell
  git add lib/payload/payload.js lib/payload/components.js lib/editor-api.js nodes/mavlink-ai-payload.js nodes/mavlink-ai-payload.html test/unit/payload-node.test.js test/unit/payload-components.test.js test/unit/editor-api.test.js
  git commit -m "refactor: resolve payload values from dialect data"
  ```

---

## Task 8: Migrate swarm classification, Local Identity defaults, and the signed flag

**Files:**

- Modify: `lib/swarm/vehicle-registry.js:1-58,99-113,127,151,306-322,347`
- Modify: `nodes/mavlink-ai-swarm.js` (registry construction site)
- Modify: `nodes/mavlink-ai-formation.js:375-390` (registry construction site)
- Modify: `nodes/mavlink-ai-local-identity.js:1-44`
- Modify: `nodes/mavlink-ai-local-identity.html:17-43,48-75`
- Modify: `nodes/mavlink-ai-connection.js:3-35,1935-1948`
- Modify: `test/unit/vehicle-registry.test.js`
- Modify: `test/unit/swarm-node.test.js`
- Modify: `test/unit/local-identity.test.js`
- Modify: `test/unit/profile-identity.test.js`
- Modify: `test/unit/connection-incompat-flags.test.js`

- [ ] **Step 1: Write generated-value tests and missing-enum failures**

  Use `common.MavModeFlag`, `MavType`, `MavAutopilot`, `MavComponent`, and `MavLinkProtocolV2.IFLAG_SIGNED` in assertions. Add strict constructor tests for a registry missing required classification enum data.

  Assert the Local Identity runtime presets use generated `MISSIONPLANNER` and `ONBOARD_COMPUTER` values. Keep system IDs `255` and `1` as local address policy.

- [ ] **Step 2: Run focused tests and confirm failure**

  ```powershell
  node --test test/unit/vehicle-registry.test.js test/unit/swarm-node.test.js test/unit/local-identity.test.js test/unit/profile-identity.test.js test/unit/connection-incompat-flags.test.js
  ```

  Expected: FAIL because swarm, identity, and connection still own copied values.

- [ ] **Step 3: Build swarm classification from the active dialect**

  Retain the application mapping from vehicle type member keys to internal families, but resolve each key at `VehicleRegistry` construction:

  ```js
  const TYPE_FAMILY_MEMBERS = {
    FIXED_WING: 'plane',
    QUADROTOR: 'copter',
    // ...all currently supported types...
    GROUND_ROVER: 'rover',
    SURFACE_BOAT: 'boat',
    SUBMARINE: 'sub'
  };
  ```

  Similarly resolve `MavType.GCS`, `MavModeFlag.SAFETY_ARMED`, and `MavAutopilot.ARDUPILOTMEGA`/`PX4`. Store the resulting plain maps/values on the registry. Pass the active dialect name from both the Swarm and Formation nodes and from tests.

- [ ] **Step 4: Resolve Local Identity component defaults and update its editor**

  Build runtime `ROLE_PRESETS` component IDs with `coreEnumMember`. In the browser editor, remove the copied `190`/`191` role table and load them from `/mavlink-ai/protocol-values`. Make the HTML default component blank until the generated role preset is applied; do not add a fallback number if the endpoint fails. Preserve the user-entered custom component ID and role-switch overwrite rules.

- [ ] **Step 5: Use node-mavlink's public signed incompatibility constant**

  Import `MavLinkProtocolV2` from `node-mavlink`, delete `KNOWN_INCOMPAT_FLAGS = 0x01`, and test unsupported-bit rejection using `MavLinkProtocolV2.IFLAG_SIGNED`. Keep every byte-level validation and signing path otherwise unchanged.

- [ ] **Step 6: Run focused tests**

  ```powershell
  node --test test/unit/vehicle-registry.test.js test/unit/swarm-node.test.js test/unit/local-identity.test.js test/unit/profile-identity.test.js test/unit/connection-incompat-flags.test.js
  ```

  Expected: PASS with registry filtering, mode naming, identity validation, and signed-frame acceptance unchanged.

- [ ] **Step 7: Commit**

  ```powershell
  git add lib/swarm/vehicle-registry.js nodes/mavlink-ai-swarm.js nodes/mavlink-ai-formation.js nodes/mavlink-ai-local-identity.js nodes/mavlink-ai-local-identity.html nodes/mavlink-ai-connection.js test/unit/vehicle-registry.test.js test/unit/swarm-node.test.js test/unit/local-identity.test.js test/unit/profile-identity.test.js test/unit/connection-incompat-flags.test.js
  git commit -m "refactor: derive identity and swarm values from mappings"
  ```

---

## Task 9: Audit remaining assignments, document the break, and verify everything

**Files:**

- Modify: `README.md:260-275,550-565` and any protocol-value guidance found by the audit
- Modify: `nodes/mavlink-ai-command.html:1008-1014`
- Modify: `nodes/mavlink-ai-move.html:300-310`
- Modify: `CHANGELOG.md:1-8`
- Modify: production/test files identified by the audit only when they still violate the approved boundary
- Do not modify: codec workaround logic except comments that identify why a surviving number is wire structure rather than enum data

- [ ] **Step 1: Run a production assignment audit**

  Run:

  ```powershell
  rg -n "const MAV_[A-Z0-9_]*\s*=\s*(0x[0-9A-Fa-f]+|[0-9]+)|Number\([^)]*command[^)]*\)\s*===\s*[0-9]+|new Set\(\[[0-9, ]+\]\)" lib nodes -g "*.js" -g "*.html"
  rg -n "FBWA|FBWB|MOTOR_DETECT|INITIALISING|MAV_FRAME_LOCAL_NED|MAV_FRAME_GLOBAL_RELATIVE_ALT_INT" README.md nodes examples test -g "*.md" -g "*.js" -g "*.html" -g "*.json"
  rg -n "MAV_(CMD|RESULT|MISSION|FRAME|TYPE|AUTOPILOT|COMP_ID|MODE_FLAG|PARAM_TYPE|PROTOCOL_CAPABILITY).*\b(0x[0-9A-Fa-f]+|[0-9]+)\b" lib nodes -g "*.js" -g "*.html"
  ```

  Classify every surviving hit as one of:

  - project timing/queue/geographic policy;
  - JavaScript or MAVLink wire-type range;
  - configurable address rather than enum assignment;
  - tested codec frame offset/workaround.

  If a hit is protocol data, migrate it through `protocol-values` and add a focused test before proceeding. Do not exempt a hit merely because the current numeric value is correct.

- [ ] **Step 2: Clean protocol-number copies out of behavior tests**

  Production-behavior fixtures that assert enum meaning must derive from public generated exports. In particular, inspect `test/sitl/virtual-fleet.js`, command/fanout ACK fixtures, mission result fixtures, payload result fixtures, heartbeat classification fixtures, and editor API assertions. Leave byte-level golden packets numeric where exact wire bytes are the subject of the test.

- [ ] **Step 3: Update documentation without publishing an alias table**

  Document:

  - feature-specific enum input uses exact generated member keys;
  - examples such as Plane `FLY_BY_WIRE_A` and Move `LOCAL_NED`;
  - the generic Build/raw path separately accepts `MAV_CMD_*`, other fully qualified source names, and numeric custom/dialect-external IDs;
  - raw numeric values are an advanced escape hatch;
  - PX4 mode aliases remain intentional firmware UX;
  - no codec/transport ownership changed.

  Do not list old-to-new aliases; the clean-break policy explicitly rejects a migration table.

- [ ] **Step 4: Add a breaking CHANGELOG entry**

  Add an `Unreleased` section describing:

  - generated mappings are now authoritative;
  - copied protocol assignments and fallbacks were removed;
  - feature-specific names must be exact generated members;
  - affected flows fail instead of being silently aliased;
  - raw numeric custom IDs remain supported only on explicit raw interfaces.

- [ ] **Step 5: Run the complete test suite**

  ```powershell
  npm.cmd test
  ```

  Expected: smoke, unit, and integration suites all PASS.

- [ ] **Step 6: Run lint and whitespace validation**

  ```powershell
  npm.cmd run lint
  git diff --check
  ```

  Expected: both commands exit 0 with no ESLint or whitespace errors.

- [ ] **Step 7: Re-run the audit and inspect the final diff**

  ```powershell
  rg -n "const MAV_[A-Z0-9_]*\s*=\s*(0x[0-9A-Fa-f]+|[0-9]+)|Number\([^)]*command[^)]*\)\s*===\s*[0-9]+|new Set\(\[[0-9, ]+\]\)" lib nodes -g "*.js" -g "*.html"
  git diff --stat
  git diff -- docs/superpowers/specs/2026-07-20-protocol-data-boundary-design.md README.md CHANGELOG.md
  git status --short
  ```

  Expected: no unexplained protocol-assignment hit; only intended repository files changed; the approved spec itself remains unchanged.

- [ ] **Step 8: Commit the audit and documentation**

  ```powershell
  git add README.md CHANGELOG.md nodes examples test lib
  git commit -m "docs: describe generated protocol value contract"
  ```

- [ ] **Step 9: Final verification from committed HEAD**

  ```powershell
  npm.cmd test
  npm.cmd run lint
  git diff --check 1f0094d..HEAD
  git status --short
  ```

  Expected: all checks PASS and the worktree is clean.

## Completion Criteria

- Every production MAVLink enum assignment in scope comes from an active dialect index or the cached public `node-mavlink` core exports.
- ArduPilot modes are generated, complete for the installed mappings, and accept no local aliases.
- Move and other feature-specific enum inputs use exact generated member keys.
- Explicit generic/raw interfaces still accept fully qualified names and numeric custom IDs.
- Missing required protocol data fails with complete `ENUM_VALUE_UNAVAILABLE` context.
- All documented codec workarounds and project-owned state machines remain present.
- `npm.cmd test`, `npm.cmd run lint`, and `git diff --check` pass from committed HEAD.
