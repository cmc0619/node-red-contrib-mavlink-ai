# 1.0 Release Scope and Design Decisions

This document captures follow-up decisions that refine `DESIGN.md`.

> **v3 architecture reset (issue #228).** The single combined profile was split
> into three config nodes — **Local Identity** (source ids, heartbeat, signing
> policy), **Vehicle Profile** (dialect, firmware, vehicle family, target
> defaults, mission prefs), and **Connection** (transport + channel state /
> signing link id). Where sections below say "profile owns dialect / identity",
> read: the **Vehicle Profile** owns dialect and target metadata, the **Local
> Identity** owns source identity + heartbeat + signing policy, and the
> **Connection** owns the signing link id and per-link sequence/replay state.
> `DESIGN.md` §5.5 is the authoritative model.

## 1. Dialects and `common.xml`

A MAVLink dialect is an XML message definition file.

Most public dialects include `common.xml`, then add system-specific messages/enums. That means a dialect such as `ardupilotmega.xml` should be treated as:

```text
common.xml + ArduPilot-specific additions
```

But `common.xml` is not mandatory. MAVLink dialects can remove the include and define their own base set. The module must not assume every dialect includes `common.xml`.

Design rule:

```text
Profile owns dialect.
Dialect loader resolves the full include graph allowed by MAVLink rules.
The generated/loaded message set is dialect + included files.
```

## 2. MAVLink 2 Message Extensions vs Dialects

Do not confuse these two concepts:

```text
Dialect file = XML file defining messages/enums and possibly including other XML files.
MAVLink 2 extension fields = fields after <extensions/> inside a message definition.
```

A dialect may add new messages/enums. MAVLink 2 extension fields add fields to an existing message in a compatibility-preserving way.

The module should support extension fields if the underlying protocol library exposes them.

## 3. Dialect Bound to sysid/compid Profiles

The profile should own dialect, and routes should map sysid/compid pairs to profiles.

That means the user should not need to select dialect in every comms/message node.

Correct model:

```text
Route 1:* -> Copter Profile -> ardupilotmega dialect
Route 2:* -> Rover Profile  -> ardupilotmega dialect
Route 3:* -> PX4 Profile    -> common or PX4-compatible dialect
Route 4:* -> Custom Payload -> custom dialect
```

Visible nodes select a connection and optionally a profile/filter. They do not manually select dialect unless they are specifically overriding or building against a different profile.

## 4. Connection Decode Strategy

A connection owns the wire, but a profile owns the dialect.

For a single-profile connection:

```text
socket/serial receives bytes
connection frames packet
connection decodes using default profile dialect
connection emits normalized message
```

For a routed connection:

```text
socket/serial receives bytes
connection frames packet enough to read sysid/compid/msgid
route table selects profile by sysid/compid
connection decodes packet using that profile's dialect
connection emits normalized message with profile attached
```

If the packet cannot be decoded with the selected profile dialect, the connection should emit a structured decode error with raw packet metadata.

## 5. Why We Went From 3 Nodes to 5+ Nodes

The original mental model was roughly:

```text
mavlink-comms
mavlink-msg
mavlink-mission
```

That is compact, but it mixes concerns.

The v2 model separates concerns:

```text
mavlink-ai-profile     config: protocol identity and defaults
mavlink-ai-connection  config: transport/session/resource owner
mavlink-ai-in          visible: subscribe/receive decoded messages
mavlink-ai-out         visible: send normalized/raw messages
mavlink-ai-build       visible: construct normalized messages
mavlink-ai-filter      visible: filter/rate-limit messages
mavlink-ai-command     visible: build common commands
mavlink-ai-mission     visible: mission protocol workflow
mavlink-ai-param       visible: parameter read/set/list workflow
```

This is more node types, but not necessarily more nodes in a simple flow.

Simple listen flow:

```text
[MAVLink AI In] -> [debug]
```

The profile and connection are config nodes, not visible flow clutter.

Simple command flow:

```text
[inject] -> [MAVLink AI Command] -> [MAVLink AI Out]
```

Mission flow:

```text
[inject] -> [MAVLink AI Mission]
```

The extra node types keep the architecture clean while allowing simple flows to stay simple.

## 6. Original 10 Design Goals

The original 10 design goals are retained except migration.

1. Shared MAVLink profile/config node for dialect, MAVLink version, system ID, component ID, and protocol behavior.
2. Transport details belong in connection/comms, not message nodes.
3. Message construction/filtering/decoding logic should stay out of transport-specific code where practical.
4. Serial, UDP, and TCP should be supported without changing message nodes.
5. ArduPilot-friendly defaults, while supporting common and custom dialects.
6. Mission download/upload behavior must be explicit and testable.
7. Logs and status must be useful without flooding Node-RED.
8. No hidden global state.
9. Testability with recorded MAVLink buffers and simulated transports.
10. Migration from v1 is not a 1.0 goal.

Design implication:

```text
Do not reduce node count merely to resemble v1.
Reduce visible flow clutter by using config nodes and sane defaults.
```

## 7. 1.0 Dialect Target

1.0 should support every dialect that can reasonably be loaded by the selected MAVLink library and our loader.

Minimum 1.0 dialect support:

```text
- bundled official MAVLink dialects where licensing/distribution is acceptable
- custom local XML dialect path
- custom mounted Docker path
- dialect include resolution
- dialect validation errors surfaced clearly
```

The UI should not hard-code only `common`, `minimal`, and `ardupilotmega` forever.

Preferred UI shape:

```text
Dialect source:
  bundled
  local path
  custom path

Bundled dialect:
  ardupilotmega
  common
  minimal
  ASLUAV
  AVSSUAS
  cubepilot
  icarous
  matrixpilot
  paparazzi
  storm32
  uAvionix
  ...whatever the bundled loader exposes
```

The loader should discover bundled dialects rather than require hand-editing the UI every time a dialect is added.

## 8. Firmware Abstraction Target

1.0 should include a firmware abstraction layer, but not necessarily deep polished behavior for every firmware.

Support levels:

```text
Level 0: generic MAVLink, no firmware assumptions
Level 1: ArduPilot-friendly defaults and commands
Level 1: PX4/common-friendly defaults where possible
Level 2: richer firmware-specific helpers later
```

1.0 requirement:

```text
The architecture must allow firmware abstraction from day one.
The UI should expose firmware/profile type.
The code should not hard-code ArduPilot assumptions into generic paths.
```

Good:

```text
profile.firmware = generic | ardupilot | px4 | custom
profile.vehicleType = gcs | copter | plane | rover | boat | sub | antenna-tracker
profile.dialect = ardupilotmega | common | custom | etc.
```

Bad:

```text
if command then assume ArduPilot always
if mission then assume ardupilotmega always
```

## 9. MAVLink Signing

MAVLink signing is a MAVLink 2 feature. This module should not build a custom signing implementation unless the underlying MAVLink library cannot support it and there is a clear reason to do so.

1.0 stance:

```text
Expose signing capability only if the selected MAVLink library supports it.
Do not fake signing.
Do not silently accept signed packets if the library cannot validate them.
Clearly report unsupported signing when encountered.
```

If `node-mavlink` gains signing support, this module should surface it through profile/connection settings.

Likely settings when supported:

```text
Signing enabled
Secret key source
Link ID
Allow unsigned packets
Signing required for outbound
Signing required for inbound
```

**Status (implemented, issue #15):** `node-mavlink` does expose signing
(`MavLinkPacketSignature.key`, `MavLinkProtocolV2.sign`,
`MavLinkPacket.signature.matches`), so this is surfaced as profile settings:
sign-outbound, verify-inbound, require-signature, and a link id, with the
passphrase held as an encrypted Node-RED credential. Signing is done through the
library — no custom crypto. Inbound frames that fail policy are rejected with a
clear reason rather than silently accepted, and signing is never faked when
disabled.

## 10. Advanced Stream Rate Management

Basic stream/message rate control means sending commands such as request-message or set-message-interval.

Advanced stream rate management means the module actively manages telemetry rates over time, for example:

```text
- desired rate profile per message type
- enforce rates after reconnect
- detect rate drift
- negotiate message intervals
- pause/resume high-rate streams
- reduce noisy streams when dashboard not active
- per-subscriber rate negotiation
- prevent multiple nodes from fighting over the same stream interval
```

1.0 requirement:

```text
Support basic request-message / set-message-interval commands.
Do not require advanced stream-rate orchestration for 1.0.
Design should not prevent it later.
```

## 11. Multi-Vehicle Support in 1.0

Multi-vehicle support is a 1.0 requirement.

The module must support:

```text
- multiple profiles in one Node-RED runtime
- multiple connections in one Node-RED runtime
- one connection receiving multiple sysids/compids
- one flow containing nodes for multiple vehicles
- separate flows/tabs sharing the same connection/profile config nodes
```

This is not the same thing as advanced swarm orchestration.

Multi-vehicle support:

```text
Copter and Rover both appear in Node-RED, route cleanly, and can be filtered/commanded separately.
```

Swarm orchestration:

```text
coordinated multi-vehicle mission planning, formation behavior, task allocation, fleet-level command sequencing.
```

1.0 must support multi-vehicle plumbing. It does not need fleet intelligence.

## 12. 1.0 Non-Goals

Not 1.0 unless they fall out naturally from the library:

```text
- advanced stream-rate orchestration
- swarm/fleet mission planning
- custom MAVLink signing implementation
- polished firmware-specific UX for every obscure autopilot
- v1 migration tooling
```

Still 1.0:

```text
- multi-vehicle support
- broad dialect loading
- custom dialect paths
- firmware/profile abstraction hooks
- basic stream-rate commands
- clear signed-packet behavior based on library support
```
