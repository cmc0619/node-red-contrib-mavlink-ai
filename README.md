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

**Known limitations (not yet complete — see [`RELEASE_SCOPE.md`](RELEASE_SCOPE.md)
and the "Open 1.0 gaps" section of [`ROADMAP.md`](ROADMAP.md)):**

- Dialects load only from the **bundled** set. A custom local/Docker **XML
  dialect path is not compiled at runtime** — it fails loudly rather than
  loading.
- The dialect loader uses fixed include chains (assumes `common` for vehicle
  dialects) rather than resolving the MAVLink include graph.
- The editor's dialect dropdown lists a hand-maintained subset, not every
  bundled dialect the loader can serve.

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
```

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
  dialects/   dialect loader (bundled common/ardupilotmega/... via node-mavlink)
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
