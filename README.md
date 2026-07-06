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

Dialect support now includes both bundled dialects and runtime-compiled custom
local/Docker-mounted MAVLink XML dialects. Custom XML loading resolves the file's
real `<include>` graph, compiles the resulting definitions into the same runtime
bundle shape used by bundled dialects, and fails loudly with structured errors
for invalid XML, missing includes, include cycles, or unsupported remote includes.
There is no silent fallback to `common`.

Remaining release/readiness items live in [`RELEASE_SCOPE.md`](RELEASE_SCOPE.md)
and the open sections of [`ROADMAP.md`](ROADMAP.md).

## Install

```bash
cd ~/.node-red
npm install node-red-contrib-mavlink-ai
```

`serialport` is an **optional** dependency. UDP and TCP work without it; it is
only loaded when a serial transport is actually used.

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

## Quick start

1. Drop a **MAVLink AI In** node onto a flow.
2. Create a **MAVLink AI Profile** (defaults act as a lightweight GCS).
3. Create a **MAVLink AI Connection** referencing the profile, transport
   `udp-peer`, bind `0.0.0.0:14550`.
4. Point SITL or a vehicle at `udp:127.0.0.1:14550` and watch HEARTBEAT decode.

Importable flows live in [`examples/`](examples/).

## Message contracts

Decoded messages and outbound messages use stable shapes (see `DESIGN.md`
§14). In short:

```js
// decoded (from mavlink-ai-in)
{ topic: "mavlink/HEARTBEAT", payload: { name, id, sysid, compid, profile, fields, raw, transport, receivedAt } }

// outbound (into mavlink-ai-out)
{ topic: "mavlink/send", payload: { name: "COMMAND_LONG", target_system, target_component, fields: { ... } } }
```

Enum names such as `MAV_CMD_COMPONENT_ARM_DISARM` or `MAV_TYPE_GCS` are resolved
to numbers automatically when building messages.

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
