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

### Trusted operator boundary

This package is for a trusted Node-RED operator. The Node-RED editor and its
admin API can configure live vehicle control, so they are not treated as a
multi-tenant or hostile-user boundary. An authorized operator may deliberately
use a local or mounted custom XML path and may download XML or parameter
metadata from a private-network, self-hosted, or HTTP endpoint (for example a
flight-controller or lab device at `10.x.x.x`). Those are supported advanced
workflows, not security defects.

Keep the Node-RED admin interface authenticated and off the public internet.
The driver retains Node-RED permission middleware and does not execute
downloaded XML as code. Vehicle-control safety remains a separate concern:
untrusted MAVLink data, stale control, malformed commands, and unsafe target
selection must still fail closed.

Remaining release/readiness items live in the open sections of
[`ROADMAP.md`](ROADMAP.md) and the issue tracker. (`RELEASE_SCOPE.md` records
resolved design decisions, not open work.)

## Features

- **MAVLink v1/v2 framing** with per-peer version selection (`v1` / `v2` /
  `auto` on the profile).
- **Multiple connection types**: UDP (in/out/peer), TCP (client/server), and
  optional/lazy-loaded serial.
- **Profile-based architecture**: MAVLink identity, dialect, firmware, vehicle
  type, signing, target defaults, and mission defaults live in reusable config
  nodes.
- **Connection-based runtime**: one connection owns transport, decode, routing,
  subscriptions, queueing, heartbeat, locks, and peer state.
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

