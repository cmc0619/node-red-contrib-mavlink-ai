# MAVLink Node-RED Driver — Greenfield Build Specification

> This is the canonical implementation handoff for a clean rebuild of
> node-red-contrib-mavlink-ai. It is an ordered build plan, not a retrospective
> changelog. When older design/roadmap prose conflicts with this document, use
> this document.

## 1. Goal and boundary

Build a Node-RED MAVLink integration that makes a normal setup easy:

    one local Node-RED participant + one connection + one vehicle profile
    -> listen to telemetry, build/send commands, and run workflows

It must also support deliberate advanced use without hidden globals or false
identities:

    one connection + multiple remote SysIDs + routed Vehicle Profiles
    one Node-RED runtime + Connections reused across flow tabs
    one connection + intentionally separate GCS and companion identities

This is supervisory MAVLink orchestration, not a real-time flight-control inner
loop. Any streamed-setpoint workflow must have explicit freshness, ownership,
stop/cancel, and safety behavior. Never imply that Node-RED is a hard-real-time
controller.

Make the single-vehicle GCS and onboard-companion experience excellent first.
Multi-vehicle routing is core plumbing. Swarm, fan-out, and formation are later,
experimental supervisory features until they have their own fleet safety and
lifecycle model.

Use the mavlink-ai-* Node-RED type prefix so the module can coexist with older
MAVLink nodes.

## 2. External authority and implementation substrate

Do not recreate MAVLink rules from memory. Refer to the official MAVLink
specification for framing, IDs, routing, heartbeat, missions, offboard control,
message signing, and anti-replay details.

Build on the libraries already selected for this package:

- node-mavlink for MAVLink packet framing, encode/decode, and signing
  primitives.
- mavlink-mappings for bundled dialect definitions and generated metadata.
- mavlink-mappings-gen for generation/build support for that metadata shape.
- An XML parser only for MAVLink XML loading and include-graph resolution.

Do not write a custom crypto/signing implementation. If the protocol library
cannot safely do an operation, surface a structured unsupported error.

## 3. Non-negotiable development DNA

### 3.1 JSDoc is the JavaScript comment format

Use useful JSDoc for exported functions/classes, public runtime methods,
config/message schemas, non-obvious state machines, safety-sensitive behavior,
and tricky MAVLink transformations. Explain purpose, ownership, units, range,
side effects, and error behavior where it matters. Keep it current. Do not add
empty boilerplate to trivial private one-liners simply to inflate comment count.

### 3.2 Context-driven, metadata-first Node-RED UX

The UI should reveal the next useful choice from the user's existing selections.

- Use pulldowns wherever a value is known or enumerable.
- Render fields from the selected dialect's metadata.
- Render enums as human labels with descriptions, not anonymous numeric values.
- Dynamically update dependent choices after selecting dialect, message, command,
  firmware, vehicle family, transport, or workflow action.
- Preserve saved selections while asynchronous metadata loads; a late menu load
  must never overwrite a valid value with empty configuration.
- Keep Advanced/Raw escape hatches for power users, but make the simple path
  obvious.

Never make “param7” the normal UX. Generic/raw command construction can retain
raw parameters, but the friendly UI must show each parameter's semantic name,
description, units, valid range, and enum choices wherever metadata supports it.
Do the same for bitmasks, coordinate frames, mission types, target components,
and message fields.

### 3.3 State has one visible owner

No global parser, global active dialect, global current vehicle, or hidden
singleton transport.

| State | Owner |
| --- | --- |
| Source IDs, role, local heartbeat identity | Local Identity |
| Target defaults, dialect, firmware, modes/params/missions | Vehicle Profile |
| Transport, queues, peer tracking, routes, subscriptions | Connection |
| Sequence, signing timestamp, replay memory, peer version | Connection/channel, keyed by local identity as required |
| Mission/parameter/ACK/control state | Workflow service/node |

### 3.4 Serial is optional

Serialport must be an optional dependency and lazy-loaded only when a serial
Connection is used. UDP and TCP installations must load, operate, and test
without it. Selecting serial when it is absent must produce a clear
SERIALPORT_MISSING-style error, not an opaque native-module failure.

### 3.5 Fail closed where it matters

Editor validation improves setup; runtime validation is authoritative because
imported or hand-edited flow JSON can bypass the editor. Missing, ambiguous,
malformed, stale, unauthorised, or unsafe action input must fail closed with a
stable machine-readable error code plus a human repair instruction.

The raw builder is deliberately more permissive than friendly nodes, but it
still validates wire types and numeric precision safely.

## 4. Architecture: three config nodes, one question each

Do not collapse these concerns back into a combined profile.

| Question | Config node | Owns |
| --- | --- | --- |
| Who is Node-RED on the wire? | Local Identity | source SysID/CompID, local role, heartbeat identity, signing policy/credential reference |
| What remote vehicle is addressed/interpreted? | Vehicle Profile | targets, vehicle family, firmware, dialect, version preference, modes, parameter/mission metadata |
| How does traffic move and remain channel-correct? | Connection | transport, routing, queue, peers, subscriptions, heartbeats, signing link ID and channel state |

Visible nodes own behavior: receive, filter, build, send, command, move,
parameter, payload, mission, then later fleet operations.

### 4.1 Local Identity

Suggested type: mavlink-ai-local-identity.

It owns name; source system/component IDs; role preset; heartbeat defaults; and
a signing credential/policy reference.

Role presets are sensible defaults, not lies:

- GCS commonly suggests SysID 255 / CompID 190.
- Companion/onboard controller normally shares the vehicle SysID but uses its
  own component ID, commonly 191. It is not the autopilot or vehicle.
- Custom exposes the source and heartbeat values explicitly.

Reject source SysID 0 and invalid source component IDs. A selected target
vehicle type must never determine the local identity.

### 4.2 Vehicle Profile

Suggested type: mavlink-ai-vehicle.

It owns name; default target system/component IDs; vehicle family; firmware;
dialect source and choice; v1/v2/auto preference; mode/parameter metadata; and
mission defaults.

It must never own source IDs, local heartbeat role, signing channel state, or
the Local Identity used for transmission. Inbound routes map remote SysID/CompID
to a Vehicle Profile so the correct dialect and firmware metadata decode it.

### 4.3 Connection

Suggested type: mavlink-ai-connection.

It owns UDP in/out/peer, TCP client/server, and optional serial transport;
routing and peer tracking; outbound queues/lifecycle/locks; a subscriber API;
one required default Local Identity; explicit additional identity bindings;
per-identity heartbeats; signing link ID; and all per-link channel state.

One UDP port is one socket, not one vehicle. A routed Connection can receive
many remote systems and send target-specific packets to learned peers.

### 4.4 Safe identity resolution

A Connection requires one default Local Identity. The editor may suggest the
only available identity but must persist the reference.

Additional identities are an explicit Advanced capability, disabled by default.
For every outbound normalized message:

1. Resolve an explicit localIdentity if the message specifies one.
2. Verify that it is the default or an allowed additional binding.
3. If there is no override, use the Connection default.
4. Never derive source identity from vehicleProfile or an inbound route.
5. Never fall back to the default after an invalid explicit override.

Normal node UI inherits the Connection default. Power users deliberately opt
into multi-identity transmission, such as a GCS plus companion on one link.
Additional identity heartbeats are separately opt-in. Heartbeat queue
coalescing must include identity.

Missing identity, unattached identity, duplicate local SysID/CompID on a link,
ambiguous identity name, and disabled multi-identity usage all fail closed with
actionable errors. The safety comes from explicit bindings and unambiguous
resolution, not from forbidding valid advanced MAVLink use.

## 5. Protocol, dialect, metadata, and signing foundations

### 5.1 Dialect and metadata system

Vehicle Profile owns dialect selection; Connection owns bytes. Do not make every
transport/action node choose a dialect.

Support discovered bundled dialects; local or mounted custom MAVLink XML;
dependency-ordered XML include-graph resolution; loud invalid/missing/cyclic
include errors; and a downloadable official MAVLink XML catalog.

Catalog downloads go into a managed local cache and retain provenance:
repository, requested ref, resolved commit, download time, and per-file hash.
An editor picker can select a download and show a useful diff against the
same-named bundled dialect.

Downloaded XML is a managed custom path: not a third runtime mode, not a
replacement for bundled definitions, and never silently auto-updated while a
profile is active. Runtime XML compilation never fetches remote includes.

Build one shared metadata service that supplies editor and runtime validation
with dialects, messages, fields, enums, descriptions, units, bitmasks, command
metadata, and firmware mode tables. Do not hand-maintain separate editor and
runtime schemas.

### 5.2 Signing is day-one architecture

Signing must shape the config model, APIs, state ownership, and tests from the
start. It is not a late roadmap phase.

Use node-mavlink primitives and refer to the MAVLink message-signing
specification for exact cryptographic, timestamp, and anti-replay mechanics.

- Sign outbound MAVLink 2 packets when Connection policy requires it.
- Verify inbound signed packets when configured; optionally require signatures
  and reject unsigned traffic.
- Store secrets only in encrypted Node-RED credentials, never exported flow JSON
  or logs.
- Explain that signing requires MAVLink 2.
- A Local Identity may select reusable signing policy/credential intent, but the
  signing link ID, outgoing sequence, monotonic timestamp, replay memory, and
  detected peer wire version are Connection/channel state.
- Preserve this state across Vehicle Profile reloads and codec rebuilds.
- Key outgoing state at least by connection/channel and local source identity;
  do not put it in a replaceable dialect codec.
- Reusing a Local Identity on multiple Connections must not silently share
  channel state or link IDs.

### 5.3 Normalized contracts and errors

All build/workflow nodes talk to the Out/Connection layer through a documented,
unambiguous envelope. Its core fields are message name, vehicleProfile,
optional localIdentity, target system/component, and semantic fields.

Use vehicleProfile rather than a legacy overloaded profile field. Decoded output
contains message name, source IDs, matched Vehicle Profile, decoded fields, raw
packet metadata where useful, and timestamps.

Errors use stable codes plus repair instructions. Status, node.error, Catch
semantics, and dedicated error outputs must be predictable and consistent.

## 6. Friendly visible-node model

The Build node is the complete metadata-driven escape hatch: any message in the
dialect, dynamic field help, enum choices, and advanced raw control.

Common work should be semantic/contextual nodes:

- In and Out for connection subscriptions and normalized/raw transmission.
- Filter with safe ID parsing, per-Connection state isolation, rate limiting, and
  changed-only behavior.
- Command with workflow-grouped presets, semantic fields, readable MAV_RESULT
  results, confirmation gates, and optional ACK wait/retry.
- Move with named position-target presets and frames rather than user-calculated
  bitmasks. It needs TTL/deadman, ownership, stop/cancel, and no zero-filling of
  absent active fields into an origin command.
- Param for read/set/list workflows, with type detection before a write when
  possible so PX4 integer/byte-union parameters are not corrupted.
- Payload for camera, gimbal, servo, relay, and gripper verbs with target
  component first-class.

Workflow state machines do not live in the transport handler. They subscribe to
decoded messages and send through the Connection API. Connection locks prevent
conflicting operations, but workflows must also respect routed-mode target
policy and reject broadcasts when a single responder is required.

## 7. Build roadmap — dependency order, not history

Testing is pervasive from Phase 0 onward. Phase 4 expands the full acceptance
matrix; it is not the first time tests are written.

### Phase 0 — charter, skeleton, executable contracts

Create the package skeleton, Node-RED registration, editor/runtime load checks,
basic layout, CI, test runners, this document, shared schemas/contracts,
error-code conventions, JSDoc standard, and state ownership rules.

Deliver a minimal package that really loads in Node-RED, with smoke and runtime
load tests. Do not create fake feature nodes just to fill the palette.

### Phase 1 — foundations: config, protocol, metadata, security

Build the substrate every visible node consumes:

1. Local Identity, Vehicle Profile, and Connection config nodes with strict
   ownership and helpful validation.
2. Default/additional identity resolution and per-identity heartbeat scheduling.
3. Protocol facade, bundled/custom dialects, XML include graphs, normalizer, and
   shared message/enum/field metadata service.
4. UDP peer transport, route matching, routed decode, subscribers, bounded
   queue/teardown behavior, and lifecycle observability.
5. Signing credentials/policy, connection-owned link/channel state, real
   sign/verify/require behavior, and replay architecture.
6. Hardened editor APIs for metadata/XML catalog menus: permissions, bounded
   input, safe error detail, and non-blocking work.
7. Optional serial lazy-load/error behavior and TCP interface design.

Phase 1 proves receiving a heartbeat, selecting a Vehicle Profile by route,
publishing a normalized event, and sending one normalized packet under exactly
one valid Local Identity—signed when policy requires it.

### Phase 2 — essential visible nodes

Implement In, Out, Build, Filter, Command, Move, Param, and Payload over the
Phase 1 APIs. Complete UDP behavior, then TCP client/server and serial against
the stable Connection interface.

Every editor control maps to a runtime-validated MAVLink semantic. Metadata,
not a manually maintained table of magic numbers, drives the menus.

### Phase 3 — stateful workflows and deferred fleet work

Implement the mission state machine: download, upload, clear, progress,
timeouts/retries, request-format handling, and ACK-safe destructive behavior.

Only after single-vehicle UX is excellent, add experimental fleet primitives:

- a registry with one vehicle record per SysID and nested components;
- explicit group selection;
- batch/fan-out with dry run, pacing, overrides, deadlines, cancellation, and
  partial result aggregation;
- coordinate-frame helpers for meter offsets and correct global conversion;
- formation/follow-leader only as supervisory target generation, never
  collision avoidance or a tight control loop.

Fleet work must progress toward: select -> validate -> dry run -> acquire
control lease/operator enable -> execute -> monitor -> abort/complete -> release.
Until that lifecycle and multi-vehicle SITL evidence exist, label it experimental
and keep it off the simple path.

### Phase 4 — verification and acceptance

Keep unit/integration coverage throughout; now finish the full quality matrix:

- unit tests for config/identity validation, metadata, fields/enums/bitmasks,
  XML include graphs, normalization, signing/replay state, routing, peers,
  teardown, filters, locks, and workflow transitions;
- deterministic test fixtures for heartbeat, mission sequences, malformed data,
  bad signatures, replays, and mixed routes;
- UDP loopback, custom XML failure, missing serial, TCP/serial lifecycle, and
  Node-RED runtime-load integration tests;
- ArduPilot and PX4 SITL journeys for GCS and companion identity, telemetry,
  commands, parameter behavior, mission behavior, streamed-setpoint freshness/
  cancel, and signing where supported;
- a regression test for every bug, safety, and UX review finding.

**The examples directory is a user-facing product area, never a test-development
directory.** Do not put test files, synthetic fixtures, snapshots, harnesses, or
experimental flows there. Put those under test/. Tests may externally parse and
import-validate examples once Phase 5 creates them, but examples stay clean.

### Phase 5 — examples and learning path

Create examples only after node contracts stabilize. Each is small, importable,
has named config prerequisites, uses safe defaults, and is Debug-wired rather
than live/destructive by default.

Start with UDP heartbeat; routed multi-vehicle telemetry; build/send; arm/disarm;
request message; GLOBAL_POSITION_INT filter; parameter read/set; mission
download/upload/clear; raw debug; serial; companion-computer; signing; then a
clearly experimental fleet example only when Phase 3 earns it.

Examples explain use. They do not hide setup in Function-node magic or replace
tests.

### Phase 6 — polish, audit, release readiness

Perform fresh code, UX, MAVLink-convention, Node-RED-convention, security, and
safety reviews. Resolve stale help/status, i18n, accessibility, editor-load
races, numeric-domain mismatch, queue priority, health observability, and
structured error consistency. Add screenshots and complete package readiness
only after simulator, safety, and regression standards pass.

## 8. Release definition of done

The greenfield driver is ready for a stable single-vehicle release when:

- selecting a target vehicle can never change Node-RED's source identity or
  heartbeat role;
- GCS and onboard companion setup are obvious and work without hidden overrides;
- a routed Connection handles multiple remote systems/profiles correctly;
- UDP/TCP work without serialport, and serial failure is explicit;
- signing is real, credential-safe, channel-correct, and tested (or explicitly
  unsupported by the library);
- friendly nodes are metadata-driven semantic UI, not anonymous wire fields;
- control/mission/destructive paths fail closed on missing, stale, malformed, or
  unconfirmed input;
- state is instance scoped and shared Connections work across Node-RED tabs;
- automated tests plus ArduPilot/PX4 SITL journeys pass;
- examples are produced after testing and remain product artifacts;
- maintained public/runtime JavaScript has useful JSDoc.

The final architectural test is simple: **Local Identity owns who Node-RED is;
Vehicle Profile owns what it addresses; Connection owns the wire and channel
correctness; visible nodes own behavior.**

