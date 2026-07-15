# node-red-contrib-mavlink-ai

A full-featured Node-RED MAVLink module built around a clean v2 architecture:
reusable profiles, shared connections, routed multi-vehicle links, rich message
builders, mission/parameter workflows, command presets, and swarm helpers.

**About the name:** the `-ai` suffix is a disclosure, not a feature. This
package is written by AI, with human direction and review. There is no AI at
runtime — it is a plain MAVLink integration.

This repo is intentionally separate from earlier MAVLink Node-RED experiments so
both versions can coexist in the same Node-RED runtime.

## Status

v2 baseline is implemented: profiles (with a firmware abstraction field), the
protocol/dialect layer, the UDP / TCP / serial connection runtime, routing with
per-profile decode, subscriptions, the in/out/build/filter/command nodes, the
mission download/upload/clear workflows, parameter workflows, guided/offboard
setpoints, payload control, and swarm registry/fan-out helpers. Serial is
optional and lazy-loaded.

Dialect support has two sources: **bundled** dialects and a **custom** MAVLink
XML path. A custom dialect is simply an XML file readable by the Node-RED
process (local or mounted — not separate modes). Custom XML loading resolves the
file's real `<include>` graph, compiles the resulting definitions into the same
runtime bundle shape used by bundled dialects, and fails loudly with structured
errors for invalid XML, missing includes, include cycles, or unsupported remote
includes. There is no silent fallback to `common`.

The profile editor can also **download an official MAVLink XML catalog** into a
local cache (`<userDir>/mavlink-ai/xml/`) and pick a downloaded file as the
custom XML path. Downloaded XMLs are **managed Custom paths, not a replacement
for bundled dialects** — there is no third runtime mode, active profiles are
never auto-updated, and includes are fetched together at download time (the
runtime compiler never fetches remote includes). Each snapshot records its
provenance (repo, ref, resolved commit, timestamp, per-file SHA-256), and the
editor can show whether a same-named bundled dialect exists plus a message/enum
diff against it. See `lib/dialects/xml-catalog.js`.

Remaining release/readiness items live in the open sections of
[`ROADMAP.md`](ROADMAP.md) and the issue tracker. (`RELEASE_SCOPE.md` records
resolved design decisions, not open work.)

## Features

- **MAVLink v1/v2 framing** with per-peer version selection (`v1` / `v2` /
  `auto` on the profile).
- **Multiple connection types**: UDP (in/out/peer), TCP (client/server), and
  optional/lazy-loaded serial.
- **Three-node architecture (#228)**: **Local Identity** (source ids, heartbeat,
  signing policy), **Vehicle Profile** (dialect, firmware, vehicle family, target
  defaults, mission defaults), and **Connection** — so selecting a vehicle can
  never change who Node-RED is on the wire, and one link can deliberately act as
  multiple participants.
- **Connection-based runtime**: one connection owns transport, decode, routing,
  subscriptions, queueing, heartbeat, locks, peer state, and per-link channel
  state (sequence, signing timestamps, replay, detected versions).
- **Bundled and custom XML dialects**: use bundled dialects or compile local or
  mounted MAVLink XML dialects at runtime, with a downloadable official XML
  catalog.
- **No silent dialect fallback**: invalid dialects, bad XML, missing includes,
  include cycles, and unsupported remote includes fail loudly with structured
  errors.
- **Dynamic message builder**: message fields render from dialect metadata, with
  visible descriptions, units, types, and enum dropdowns where metadata exists.
- **Command presets**: arm/disarm, mode, takeoff, land, RTL, guided/autonomy,
  mission, and telemetry/system commands with a friendly, profile-aware UI.
- **COMMAND_ACK workflow**: optionally wait for command acknowledgement with
  timeout/retry behavior and readable `MAV_RESULT_*` names.
- **Mission workflows**: download, upload, and clear with progress output,
  timeout/retry handling, and `MISSION_ITEM_INT` coordinate scaling.
- **Parameter workflows**: read (by id or index), set (with runtime type
  auto-detection), or fetch the full list with progress and gap refill.
- **Guided/offboard setpoints**: `SET_POSITION_TARGET_LOCAL_NED` /
  `_GLOBAL_INT` with named `type_mask` presets and friendly up-positive
  altitude handling.
- **Payload control**: camera, gimbal (command- and gimbal-manager-based),
  servo, relay, and gripper verbs for any vehicle type.
- **Multi-vehicle routing**: route inbound packets by sysid/compid to the
  correct profile and decode with that profile's dialect.
- **UDP peer tracking by sysid**: `udp-peer` learns multiple vehicle endpoints
  on one port and sends target-specific traffic back to the right sysid.
- **Swarm helpers**: discover active systems from HEARTBEAT, maintain named
  groups, fan out commands per vehicle, convert local meter offsets to global
  targets, and aggregate ACK results.
- **MAVLink 2 signing**: sign outbound, verify/require inbound, with spec
  anti-replay enforcement (freshness window + monotonic timestamps).
- **Importable examples**: connection, message, command, mission, parameter,
  telemetry, move/payload, raw/debug, swarm, and safety-gated workflows.

## Install

From npm:

```bash
cd ~/.node-red
npm install node-red-contrib-mavlink-ai
```

From source:

```bash
cd ~/.node-red
git clone https://github.com/cmc0619/node-red-contrib-mavlink-ai.git
npm install ./node-red-contrib-mavlink-ai
```

`serialport` is an **optional** dependency. UDP and TCP work without it; it is
only loaded when a serial transport is actually used. To enable serial in an
environment where the optional dependency was skipped:

```bash
cd ~/.node-red
npm install serialport
```

## Compatibility

Supported runtime matrix:

| Component | Install floor | CI-tested |
|-----------|---------------|-----------|
| Node.js   | 20+ (`engines.node` `>=20`) | 22.x and 24.x |
| Node-RED  | 4.0+ (`node-red.version` `>=4.0.0`) | 4.x and 5.x |

- **Node.js 20+** is the install floor, enforced by `engines.node` (`>=20`).
  The real constraints are global `fetch` (Node 18+) and the optional
  `serialport@13` dependency (Node 20+), so 20 is the true minimum — this keeps
  officially-supported Node-RED 4 hosts on Node 20 (Debian/Raspberry Pi)
  installable. CI runs on the active LTS majors, 22.x and 24.x.
- **Node-RED 4.x and 5.x** are the tested and supported majors, and CI loads
  the nodes into a real Node-RED runtime for each. The supported runtime range
  is declared via the `node-red.version` packaging field (`>=4.0.0`, no upper
  bound) so a newer Node-RED can still install it; the guaranteed-tested majors
  are the ones in the table. (There is no `node-red` peer dependency — Node-RED
  is the host runtime, not a package to install into the module tree.)
- **Node-RED 3.x and earlier are not supported.** The `node-red.version` gate
  excludes them; while the generic Node-RED APIs the nodes use may happen to
  work on older releases, that is unverified and intentionally not claimed.
- **Serial support** needs the optional `serialport` dependency and Node.js 20+.
  On an older runtime the serial transport fails with a clear
  `SERIALPORT_UNSUPPORTED_RUNTIME` error (and `SERIALPORT_MISSING` when the
  dependency isn't installed) rather than an opaque native binding failure.

CI runs the full test suite and a Node-RED runtime load check across every
Node.js × Node-RED combination in the table above.

## Core idea

Three config nodes, one question each (issue #228):

```text
Local Identity  = who Node-RED IS on the wire  (source ids, heartbeat, signing)
Vehicle Profile = what vehicle is ADDRESSED     (dialect, targets, vehicle family)
Connection      = how traffic MOVES + channel state (transport, link id, sequence/replay)
Route           = how sysid/compid packets map to Vehicle Profiles
Nodes           = what actions or filters happen in a flow
```

A Vehicle Profile never changes the local identity, and a Connection resolves
every message to exactly one permitted identity — its default, or an explicitly
bound additional identity.

## Node reference

### `mavlink-ai-local-identity` (config)

Who this Node-RED runtime is when it transmits. Multiple identities may coexist;
a Connection uses exactly one as its required default.

- role preset: GCS, companion / onboard controller, or custom
- source system/component id (GCS suggests `255/190`; companion suggests sharing
  the vehicle sysid with CompID `191`)
- HEARTBEAT identity (`MAV_TYPE`, autopilot)
- MAVLink 2 signing credential + policy (sign / verify / require)

### `mavlink-ai-profile` — Vehicle Profile (config)

What vehicle is being addressed and how its protocol metadata is interpreted.
Target-facing only; it owns no local identity, heartbeat, or signing.

- dialect: bundled, or custom XML (local path or a catalog download)
- MAVLink version: v1, v2, or auto
- vehicle family: copter, plane, rover, boat, sub, tracker, or generic
  (drives ArduPilot mode tables and parameter metadata)
- firmware: generic, ArduPilot, PX4, custom
- default target system/component id
- mission defaults (mission type, preferred item format)

### `mavlink-ai-connection` (config)

Transport, decode, routing, subscriptions, queueing, heartbeat, and runtime
state. The connection is the shared wire/runtime object — multiple tabs and
flow nodes reference the same connection without hidden global state.

- **required default Local Identity**; optional **Additional Local Identities**
  (advanced, disabled by default) so one link can transmit as several
  participants
- signing **link id** (channel-owned; distinct per connection)
- UDP in / out / peer
- TCP client / server
- serial, when `serialport` is installed
- heartbeat enable/interval (per identity)
- single-profile or routed mode
- accepted sysids/compids
- route table (sysid/compid pattern → Vehicle Profile)
- unmatched packet policy
- outbound queue settings

### `mavlink-ai-in`

Subscribes to decoded MAVLink messages from a connection. This is a
**connection subscription**, not a socket of its own. Filter by message name
and sysid/compid, with optional raw output, optional diagnostics/errors output,
rate limiting, and changed-only mode. Output shape is the decoded message
contract (see [Message contracts](#message-contracts)).

### `mavlink-ai-out`

Sends normalized outbound messages or raw MAVLink buffers through a connection.

```js
msg.topic = "mavlink/send";
msg.payload = {
  name: "COMMAND_LONG",
  target_system: 1,
  target_component: 1,
  fields: {
    command: "MAV_CMD_COMPONENT_ARM_DISARM",
    param1: 1
  }
};
```

Raw buffers can be sent with `topic: "mavlink/raw"`, but raw sends are
intentionally not signed or normalized.

### `mavlink-ai-build`

Builds a normalized outbound message without sending it — for raw/advanced
message construction, custom dialect messages, and wire-level control. Fields
render dynamically from the selected profile's dialect with visible help and
enum dropdowns; `COMMAND_LONG`/`COMMAND_INT` selection shows a visible pointer
at the command node. Output goes to `mavlink-ai-out`.

### `mavlink-ai-filter`

Filters decoded MAVLink messages in a flow: by message name, by sysid/compid
(comma lists supported), rate limit per message/sysid/compid, and changed-only
filtering. Useful after `mavlink-ai-in` or any decoded MAVLink stream.

### `mavlink-ai-command`

Friendly command builder for common vehicle commands, grouped by workflow:

```text
Basic Flight        Arm · Disarm · Set Mode · Takeoff · Land · RTL
Guided / Autonomy   Go To / Reposition · Change Speed · Condition Yaw · Spin / Rotate
Mission             Mission Start · Pause Mission · Resume Mission
Telemetry / System  Request Message · Set Message Interval · Stop Message Interval · Reboot Autopilot
Advanced            Raw MAV_CMD_* escape hatch with metadata-driven parameter help
```

Features: preset-specific editor fields, profile-aware flight-mode names for
ArduPilot and PX4, `COMMAND_LONG` and `COMMAND_INT` support, lat/lon float
degrees converted to degE7 for `COMMAND_INT`, optional await-ACK mode with
timeout/retry, readable `MAV_RESULT_*` names, and a confirmation gate on
reboot. Camera and gimbal control live in `mavlink-ai-payload`.

### `mavlink-ai-mission`

Runs the mission protocol state machine (download / upload / clear) so flows do
not hand-wire `MISSION_*` messages.

```js
msg.payload = {
  action: "upload",
  target_system: 1,
  items: [
    { lat: 37.7749, lon: -122.4194, alt: 15, command: "MAV_CMD_NAV_TAKEOFF" },
    { lat: 37.7750, lon: -122.4195, alt: 50, command: "MAV_CMD_NAV_WAYPOINT" },
    { lat: 37.7751, lon: -122.4196, alt: 0,  command: "MAV_CMD_NAV_LAND" }
  ]
};
```

Outputs: **1** final result (`mission/downloaded`, `mission/uploaded`,
`mission/cleared`), **2** progress events, **3** structured errors/timeouts.

Notes: `lat`/`lon` are float degrees (converted to degE7 automatically for
`MISSION_ITEM_INT`; raw `x`/`y` accepted for advanced callers); upload answers
`MISSION_REQUEST` with `MISSION_ITEM` and `MISSION_REQUEST_INT` with
`MISSION_ITEM_INT` per request; clear supports an optional acknowledged mode;
operations are locked per connection/profile/mission type.

### `mavlink-ai-param`

Parameter protocol workflows: **read one** (by id, or by index), **set one**,
or **request the full list**.

```js
msg.payload = { action: "read", param_id: "ARMING_CHECK" };
msg.payload = { action: "set", param_id: "ARMING_CHECK", param_value: 1 };
msg.payload = { action: "list" };
```

Features: timeout/retry, progress output and gap refill for full-list reads on
lossy links, case-insensitive param ids, float32-aware applied checks,
PX4 byte-union integer handling, and a param type dropdown with
**Auto (detect from vehicle)** — the set workflow reads the parameter first to
learn its real `MAV_PARAM_TYPE`, so a wrong manual type can't corrupt a PX4
integer parameter.

### `mavlink-ai-move`

Guided/offboard position-target setpoints (`SET_POSITION_TARGET_LOCAL_NED` /
`SET_POSITION_TARGET_GLOBAL_INT`) with named `type_mask` presets — Position,
Position + Yaw, Velocity, Velocity + Yaw rate, Position + Velocity, Yaw only,
Yaw-rate only, or a raw custom mask. Local NED and global frames (relative and
terrain altitude variants), with up-positive altitude/climb inputs mapped to
NED `-z`/`-vz`. One message per input; pair with an inject loop for the
continuous streams offboard control needs (built-in streaming is tracked in
issue [#128](https://github.com/cmc0619/node-red-contrib-mavlink-ai/issues/128)).

### `mavlink-ai-payload`

Payload control verbs for any vehicle type, with the target component
first-class: take photo, start/stop video, set camera mode, trigger-by-distance,
gimbal aim (`DO_MOUNT_CONTROL` or the gimbal-manager
`GIMBAL_MANAGER_SET_PITCHYAW` message), servo, relay, and gripper.

### `mavlink-ai-swarm`

Registry of active MAVLink systems discovered from HEARTBEAT and telemetry:
sysid/compid, vehicle type, autopilot, armed state, mode (via the vehicle's own
autopilot/type), system status, position, battery summary, last-seen, and
stale/expired state. Named groups can be static or type-based:

```json
{ "scouts": [1, 2], "all-copters": { "type": "MAV_TYPE_QUADROTOR" } }
```

### `mavlink-ai-fanout`

Expands one logical command into one message per target vehicle. Targets come
from explicit sysids, per-target objects, or swarm registry output; supports
dry-run, pacing, per-target overrides, await-ACK aggregation, and
stop-on-first-error or continue-on-error.

```js
msg.payload = {
  command: "MAV_CMD_DO_REPOSITION",
  command_int: true,
  origin: { lat: 39.1, lon: -75.1, alt: 40 },
  targets: [
    { sysid: 1, north: 0, east: 0,   up: 0 },
    { sysid: 2, north: 0, east: 10,  up: 0 },
    { sysid: 3, north: 0, east: -10, up: 0 }
  ]
};
```

## Swarm orchestration

Multi-vehicle use is a first-class concern, not a hand-rolled pattern: the
**swarm** node maintains the registry, and the **fanout** node expands one
logical command into one message per target system — *fan-out* — or, explicitly
and only when asked, a single `target_system` 0 message — *broadcast*. These
are different things: formation movement is fan-out, because each vehicle needs
its own target position.

Fan-out understands meters: give an `origin` and per-target `north`/`east`/`up`
offsets and it converts to global lat/lon/alt (and degE7 for `COMMAND_INT`)
instead of anyone adding meters to degrees by hand. A dry-run mode shows
exactly what would be sent, and "await acks" runs the COMMAND_ACK workflow per
vehicle and aggregates `{ accepted, failed, timedOut, skipped, results }`
without hiding partial failure.

Pixhawk/ArduPilot/PX4 remains the flight controller: these are high-level
MAVLink orchestration helpers, not a motor-control replacement.

## MAVLink 2 signing

The **Local Identity** owns the signing credential + policy; the **Connection**
owns the signing **link id** and the channel state (issue #192). Built on the
protocol library's signing primitives (no custom crypto layer):

- **Sign outbound** (on the Local Identity) — appends a valid signature to every
  encoded packet; this forces MAVLink 2 framing, since signed frames are v2-only.
- **Verify inbound** (on the Local Identity) — checks signatures on received
  signed packets; a bad signature is rejected and surfaced on the In node's
  errors output as `mavlink/rejected` (`reason: "signature-invalid"`).
  Verification also enforces the signing spec's **anti-replay** rule (below).
- **Require signature** (on the Local Identity) — with verify on, also rejects
  *unsigned* inbound packets (`reason: "signature-required"`).
- **Link ID** (on the Connection) — the 0–255 link id written into outbound
  signatures; channel-owned, so one identity reused on two connections gets a
  distinct link id per link.

The shared **passphrase** is the signing key (SHA-256 derived, matching Mission
Planner / QGroundControl). It is stored as an encrypted Node-RED credential on
the Local Identity, so it is never written into exported flow JSON. Signing
timestamps are made strictly monotonic per `(sysid, compid, link id)` by the
connection's `LinkState`; raw `sendRaw` buffers are sent as-is and are not
signed.

**Anti-replay.** Verification is not authenticity-only. As the signing spec
requires, a validly signed frame is discarded when either:

- its timestamp is **older than the last accepted timestamp** for its
  `(sysid, compid, link_id)` stream (the monotonic rule), or
- its timestamp is **more than one minute behind the receiver's clock** (the
  freshness window).

Both are rejected with `reason: "signature-replayed"`. This is part of
verification — there is no separate switch; enabling *Verify inbound* enables it.

State is **in-memory** and needs no persistence: the freshness window is what
covers a Node-RED restart. After a restart the receiver has no stored per-stream
timestamps, but a captured frame replayed later is still more than a minute old,
so the freshness window drops it; the monotonic rule then catches any replay
*within* the minute once a fresh frame re-establishes the stream baseline.

This assumes the sender's signing timestamp tracks real time (10 µs units since
2015-01-01) — which the spec requires senders to bootstrap from their clock, a
stored maximum, or GPS. A vehicle with no valid time source is out of scope by
design; it should not be signing (or flying) with an untrustworthy clock.

## Validation model

Two layers, on purpose:

- The **raw/advanced builder** (`mavlink-ai-build`) and the low-level encoder stay
  permissive. MAVLink zero-fills absent fields, so under-specified messages are
  valid wire traffic — unknown field names are reported as warnings, not errors,
  so wire-level experimentation and custom dialects keep working.
- The **workflow/action nodes** validate more strictly, because a vehicle-control
  action built with an out-of-range or nonsensical value should fail loudly, not
  encode as "valid" MAVLink with unsafe defaults. `mavlink-ai-command`,
  `mavlink-ai-mission` (upload items), `mavlink-ai-fanout` (coordinate targets),
  and `mavlink-ai-param` reject out-of-range `target_system`/`target_component`
  (0–255) and out-of-range `lat`/`lon` (±90 / ±180), and require a command on
  each mission item. Failures are structured `mavlink/error` payloads with
  `code: "INVALID_FIELD"` and a context naming the field, the offending value,
  and the expected range — not opaque serialization errors. Reusable helpers live
  in `lib/util/field-validation.js`.

## Quick start

1. Drop a **MAVLink AI In** node onto a flow.
2. Create a **MAVLink AI Local Identity** (pick the **GCS** role — it suggests
   source id `255/190` and a `MAV_TYPE_GCS` heartbeat).
3. Create a **MAVLink AI Profile** — the target vehicle (Vehicle Profile).
   - For ArduPilot, start with the `ardupilotmega` dialect and set the vehicle
     family (e.g. Copter); for generic MAVLink-only traffic, `common` is fine.
4. Create a **MAVLink AI Connection** referencing the Vehicle Profile and the
   Local Identity, transport `udp-peer`, bind `0.0.0.0:14550`. Enable heartbeat
   if this node should act like a lightweight GCS.
5. Point SITL or a vehicle at `udp:127.0.0.1:14550` and watch HEARTBEAT decode.
6. Add a **MAVLink AI Command** node (Arm, Set Mode, Takeoff, Request Message,
   Set Message Interval, …) and wire it to a **MAVLink AI Out** node.

Importable flows live in [`examples/`](examples/).

The examples also include a dependency-free, read-only vehicle status web page,
an advisory safety monitor, a local display geofence, mission upload/clear,
a gated parameter browser, JSONL telemetry record/replay, offboard/guided move
sequences, and payload control. After importing the status flow, open
`/mavlink-ai/status` on the Node-RED host. These examples compose the
normalized v2 message contracts; they do not recreate the earlier package's
hidden message bus or require the legacy `node-red-dashboard` palette.
Safety-sensitive examples are debug-wired or dry-run by default until
deliberately connected to a real vehicle.

## Message contracts

Decoded messages and outbound messages use stable shapes (see `DESIGN.md`
§14). In short:

```js
// decoded (from mavlink-ai-in)
{ topic: "mavlink/HEARTBEAT", payload: { name, id, sysid, compid, profile, profile_id, fields, raw, transport, receivedAt } }

// outbound (into mavlink-ai-out)
{ topic: "mavlink/send", payload: { name: "COMMAND_LONG", vehicleProfile, vehicleProfileName, localIdentity, target_system, target_component, fields: { ... } } }
```

Enum names such as `MAV_CMD_COMPONENT_ARM_DISARM` or `MAV_TYPE_GCS` are resolved
to numbers automatically when building messages.

64-bit integer fields (`int64_t` / `uint64_t`, e.g. `time_usec`) are decoded as
**decimal strings** so the payload is JSON-serializable and keeps full precision
(a `Number` would lose it above 2^53). When building an outbound message these
fields accept a decimal string, a safe integer, or a `BigInt`. See `DESIGN.md`
§14.1.

Vehicle Profile references are canonical **by config-node id**. Outbound
`payload.vehicleProfile` (set by the build/command/fan-out nodes) carries the
Vehicle Profile config-node id the connection resolves a codec by;
`vehicleProfileName` is the display name. The field `profile` remains a
documented, temporary compatibility alias for `vehicleProfile` (setting both to
different values is a `VEHICLE_PROFILE_CONFLICT`). Decoded payloads keep the
matched profile's display name in `payload.profile` and add the canonical
`payload.profile_id`. An outbound message that explicitly references a Vehicle
Profile the connection cannot resolve is rejected with `PROFILE_UNRESOLVED` — it
is never silently encoded with the default profile. A plain profile name is
accepted for backward compatibility only while exactly one profile config node
has that name; an ambiguous name is an error.

The **local identity** an outbound message transmits as is separate from the
Vehicle Profile (issue #228). Omit it and the message uses the connection's
required default identity; set `payload.localIdentity` to a config-node id (or
unique name) to transmit as an *attached* additional identity. A Vehicle Profile
never selects the local identity, and an unattached/ambiguous/disabled identity
request fails closed (`LOCAL_IDENTITY_NOT_ATTACHED`, `LOCAL_IDENTITY_AMBIGUOUS`,
`MULTI_IDENTITY_DISABLED`) rather than transmitting as the wrong participant.

The same rule applies to **routes**: in routed mode each route entry maps a
`sysid`/`compid` pattern to a profile config node, picked in the connection
editor (stored by id). A matched route whose profile cannot be resolved
rejects its packets (`reason: "profile-unresolved"`) and raises errors at
deploy time and once per packet identity — routed traffic is never silently
decoded, signature-checked, or labeled with the wrong profile.

## Architecture

```text
nodes/   Node-RED node registration + editor HTML (thin)
lib/
  dialects/   dialect loader (bundled dialects + runtime-compiled custom XML + XML catalog)
  protocol/   codec, normalizer, enum resolver, validator, replay tracker
  transport/  udp / tcp / serial (serial lazy-loaded)
  routing/    route table + packet router
  runtime/    subscription registry, outbound queue, lock manager
  command/    command presets, COMMAND_ACK workflow, flight modes
  mission/    state machine + download/upload/clear workflows
  param/      parameter workflows
  move/       position-target setpoint builder
  payload/    payload control verbs
  swarm/      vehicle registry, fan-out, coordinate helpers
  util/       structured status/errors, validation
  editor-api.js  shared /mavlink-ai/* admin endpoints
```

Node files never call `node-mavlink` directly — they go through the `lib`
layer. There is no global parser/dialect/connection state; everything is scoped
to a config-node instance.

## Dependencies

Required:

- `node-mavlink` — MAVLink parser/serializer and protocol primitives
- `mavlink-mappings` — bundled dialect mappings
- `mavlink-mappings-gen` — custom XML dialect compilation
- `xml2js` — XML parsing for custom dialects

Optional:

- `serialport` — only required for serial connections; lazy-loaded when a
  serial transport is configured. UDP/TCP usage must not require serial
  support.

## Tests

```bash
npm test            # smoke-load + unit + integration
npm run test:unit
npm run test:integration
```

The integration test runs a UDP loopback against a simulated vehicle: HEARTBEAT
decode, COMMAND_LONG encode, signing/verification, peer learning, and a full
mission download.

**Real hardware validation is welcome.** If you test this with ArduPilot, PX4,
SITL, a Pixhawk-class flight controller, a companion computer, a MAVLink
camera/gimbal, or a multi-vehicle setup, please open an issue with what worked,
what failed, and what hardware/firmware was involved.

## Design docs

- [`DESIGN.md`](DESIGN.md)
- [`RELEASE_SCOPE.md`](RELEASE_SCOPE.md)
- [`ROADMAP.md`](ROADMAP.md)

## Support

- Issues: https://github.com/cmc0619/node-red-contrib-mavlink-ai/issues
- MAVLink protocol: https://mavlink.io/
- ArduPilot: https://ardupilot.org/
- PX4: https://px4.io/

## License

MIT
