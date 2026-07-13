# node-red-contrib-mavlink-ai

A clean v2-style Node-RED MAVLink module designed around profiles, connections,
routing, and reusable action nodes.

This repo is intentionally separate from earlier MAVLink Node-RED experiments so
both versions can coexist in the same Node-RED runtime.

## Status

v2 baseline is implemented: profiles (with a firmware abstraction field), the
protocol/dialect layer, the UDP / TCP / serial connection runtime, routing with
per-profile decode, subscriptions, the in/out/build/filter/command nodes, and
the mission download/upload/clear workflows. Serial is optional and lazy-loaded.

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

Remaining release/readiness items live in [`RELEASE_SCOPE.md`](RELEASE_SCOPE.md)
and the open sections of [`ROADMAP.md`](ROADMAP.md).

## Install

```bash
cd ~/.node-red
npm install node-red-contrib-mavlink-ai
```

`serialport` is an **optional** dependency. UDP and TCP work without it; it is
only loaded when a serial transport is actually used.

## Compatibility

Supported runtime matrix:

| Component | Supported |
|-----------|-----------|
| Node.js   | 22.x (LTS floor) and 24.x (current) |
| Node-RED  | 4.x and 5.x |

- **Node.js 22+** is the floor. The runtime uses global `fetch` (Node 18+) and
  the optional `serialport@13` dependency requires Node 20+; 22 is chosen as the
  active LTS. This is enforced by `engines.node` (`>=22`).
- **Node-RED 4.x and 5.x** are the tested and supported majors, and CI loads
  the nodes into a real Node-RED runtime for each. `peerDependencies.node-red`
  is `>=4.0.0` (no upper bound) so a newer Node-RED can still install it; the
  guaranteed-tested majors are the ones in the table.
- **Node-RED 3.x and earlier are not supported.** The peer dependency excludes
  them; while the generic Node-RED APIs the nodes use may happen to work on
  older releases, that is unverified and intentionally not claimed.
- **Serial support** needs the optional `serialport` dependency and Node.js 20+.
  On an older runtime the serial transport fails with a clear
  `SERIALPORT_UNSUPPORTED_RUNTIME` error (and `SERIALPORT_MISSING` when the
  dependency isn't installed) rather than an opaque native binding failure.

CI runs the full test suite and a Node-RED runtime load check across every
Node.js × Node-RED combination in the table above.

## Core idea

```text
Profile    = what MAVLink identity/protocol defaults mean
Connection = how Node-RED talks to a MAVLink network or device
Route      = how sysid/compid packets map to profiles
Nodes      = what actions or filters happen in a flow
```

## Node types

Config nodes:

```text
mavlink-ai-profile      MAVLink identity, dialect, vehicle/protocol defaults
mavlink-ai-connection   transport/session, decode, routing, queue, heartbeat
```

Regular flow nodes:

```text
mavlink-ai-in        subscribe to decoded messages from a connection
mavlink-ai-out       send normalized messages or raw buffers
mavlink-ai-build     build a normalized outbound message (no send)
mavlink-ai-filter    filter decoded messages, with rate limiting
mavlink-ai-command   build common commands (arm, mode, takeoff, message interval, ...)
mavlink-ai-mission   run mission download/upload/clear workflows
mavlink-ai-param     read/set a parameter or request the full parameter list
mavlink-ai-swarm     registry of active vehicles discovered from HEARTBEAT
mavlink-ai-fanout    expand one command into per-vehicle messages, aggregate ACKs
```

## Swarm orchestration

Multi-vehicle use is a first-class concern, not a hand-rolled pattern: the
**swarm** node maintains a registry of active systems (type, armed state, mode,
position, battery, stale/expired) from HEARTBEAT and telemetry, with named
groups (`{"scouts": [1, 2], "all-copters": {"type": "MAV_TYPE_QUADROTOR"}}`).
The **fanout** node expands one logical command into one message per target
system — *fan-out* — or, explicitly and only when asked, a single
`target_system` 0 message — *broadcast*. These are different things: formation
movement is fan-out, because each vehicle needs its own target position.

Fan-out understands meters: give an `origin` and per-target `north`/`east`/`up`
offsets and it converts to global lat/lon/alt (and degE7 for `COMMAND_INT`)
instead of anyone adding meters to degrees by hand. A dry-run mode shows
exactly what would be sent, and "await acks" runs the COMMAND_ACK workflow per
vehicle and aggregates `{ accepted, failed, timedOut, skipped, results }`
without hiding partial failure.

Pixhawk/ArduPilot/PX4 remains the flight controller: these are high-level
MAVLink orchestration helpers, not a motor-control replacement.

## MAVLink 2 signing

The profile supports minimal MAVLink 2 packet signing, built on the protocol
library's signing primitives (no custom crypto layer):

- **Sign outbound** — appends a valid signature to every encoded packet; this
  forces MAVLink 2 framing, since signed frames are v2-only.
- **Verify inbound** — checks signatures on received signed packets; a bad
  signature is rejected and surfaced on the In node's errors output as
  `mavlink/rejected` (`reason: "signature-invalid"`).
- **Require signature** — with verify on, also rejects *unsigned* inbound
  packets (`reason: "signature-required"`).
- **Link ID** — the 0–255 link id written into outbound signatures.

The shared **passphrase** is the signing key (SHA-256 derived, matching Mission
Planner / QGroundControl). It is stored as an encrypted Node-RED credential, so
it is never written into exported flow JSON. The signature timestamp uses the
protocol library's default; raw `sendRaw` buffers are sent as-is and are not
signed.

**Scope note:** verification checks signature *authenticity* only. MAVLink
signing's optional replay protection — per-`(sysid, compid, linkId)` monotonic
timestamp state and a freshness window — is **not** implemented, because the
protocol library exposes only the authenticity check and stateful, persisted
replay tracking is out of scope for this minimal support. A captured, validly
signed frame can therefore be replayed; do not rely on signing alone as an
anti-replay control.

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
2. Create a **MAVLink AI Profile** (defaults act as a lightweight GCS).
3. Create a **MAVLink AI Connection** referencing the profile, transport
   `udp-peer`, bind `0.0.0.0:14550`.
4. Point SITL or a vehicle at `udp:127.0.0.1:14550` and watch HEARTBEAT decode.

Importable flows live in [`examples/`](examples/).

The examples also include a dependency-free, read-only vehicle status web page,
an advisory safety monitor, a local display geofence, mission upload/clear,
a gated parameter browser, and JSONL telemetry record/replay. After importing
the status flow, open `/mavlink-ai/status` on the Node-RED host. These examples
compose the normalized v2 message contracts; they do not recreate the earlier
package's hidden message bus or require the legacy `node-red-dashboard` palette.

## Message contracts

Decoded messages and outbound messages use stable shapes (see `DESIGN.md`
§14). In short:

```js
// decoded (from mavlink-ai-in)
{ topic: "mavlink/HEARTBEAT", payload: { name, id, sysid, compid, profile, profile_id, fields, raw, transport, receivedAt } }

// outbound (into mavlink-ai-out)
{ topic: "mavlink/send", payload: { name: "COMMAND_LONG", profile, profile_name, target_system, target_component, fields: { ... } } }
```

Enum names such as `MAV_CMD_COMPONENT_ARM_DISARM` or `MAV_TYPE_GCS` are resolved
to numbers automatically when building messages.

64-bit integer fields (`int64_t` / `uint64_t`, e.g. `time_usec`) are decoded as
**decimal strings** so the payload is JSON-serializable and keeps full precision
(a `Number` would lose it above 2^53). When building an outbound message these
fields accept a decimal string, a safe integer, or a `BigInt`. See `DESIGN.md`
§14.1.

Profile references are canonical **by config-node id**. Outbound
`payload.profile` (set by the build/command/fan-out nodes) carries the profile
config-node id the connection resolves a codec by; `profile_name` is the
display name. Decoded payloads keep the display name in `payload.profile`
(what filters and subscriptions historically match — they now match the id
too) and add the canonical `payload.profile_id`. An outbound message that
explicitly references a profile the connection cannot resolve is rejected with
`PROFILE_UNRESOLVED` — it is never silently encoded with the default profile.
A plain profile name is accepted for backward compatibility only while exactly
one profile config node has that name; an ambiguous name is an error.

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
  dialects/   dialect loader (bundled dialects + runtime-compiled custom XML)
  protocol/   codec, normalizer, enum resolver, validator
  transport/  udp / tcp / serial (serial lazy-loaded)
  routing/    route table + packet router
  runtime/    subscription registry, outbound queue, lock manager
  mission/    state machine + download/upload workflows
  util/       structured status/errors, validation
```

Node files never call `node-mavlink` directly — they go through the `lib`
layer. There is no global parser/dialect/connection state; everything is scoped
to a config-node instance.

## Dependency rule

`node-mavlink` is a core runtime dependency. `serialport` must be optional and
lazy-loaded only when a serial transport is configured. UDP/TCP usage must not
require serial support.

## Tests

```bash
npm test            # smoke-load + unit + integration
npm run test:unit
npm run test:integration
```

The integration test runs a UDP loopback against a simulated vehicle: HEARTBEAT
decode, COMMAND_LONG encode, and a full mission download.

## Design docs

- [`DESIGN.md`](DESIGN.md)
- [`RELEASE_SCOPE.md`](RELEASE_SCOPE.md)
- [`ROADMAP.md`](ROADMAP.md)
