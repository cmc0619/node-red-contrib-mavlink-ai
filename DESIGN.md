# MAVLink AI v2 Design

> **Read this together with [`RELEASE_SCOPE.md`](RELEASE_SCOPE.md).** `DESIGN.md`
> describes the core architecture and design principles; `RELEASE_SCOPE.md`
> captures current 1.0 scope decisions, deferrals, and refinements. Read both
> before making architectural or release-target changes.

## 1. Purpose

`node-red-contrib-mavlink-ai` is a second-generation Node-RED MAVLink module.

This repo exists because the first-generation shape naturally drifted toward a coupled design: comms nodes started owning transport, dialect, message parsing, mission behavior, and user workflow assumptions. That works for a quick proof of concept, but it becomes brittle as soon as more than one vehicle, one dialect, one transport, or one flow tab is involved.

v2 is a clean architecture reset.

The module should be a MAVLink protocol layer for Node-RED, not merely a serial/UDP node with MAVLink features glued onto it.

The core design rule is:

```text
Profile    = MAVLink identity, dialect, vehicle defaults, protocol defaults
Connection = transport/session/resource owner
Route      = sysid/compid mapping to profile
Nodes      = visible Node-RED behavior
```

Or more bluntly:

```text
Profile = what this MAVLink thing means.
Connection = how we talk to it.
Route = which packet belongs to which thing.
Flow nodes = what we do with it.
```

## 2. High-Level Goals

v2 must support:

```text
- Multiple vehicles in the same Node-RED runtime.
- Multiple vehicle types: GCS, copter, plane, rover, boat, sub, antenna tracker, generic.
- Multiple MAVLink profiles using the same dialect but different defaults.
- Multiple connections: UDP, serial, TCP.
- One UDP port connected to one vehicle.
- One UDP port receiving multiple sysids/compids.
- Multiple UDP ports mapped to multiple vehicles.
- Flow tabs split by function while sharing the same connection.
- A clean path to mission download/upload without stuffing workflow state into transport code.
- UDP/TCP usage without requiring `serialport`.
- Coexistence with older Node-RED MAVLink modules.
```

v2 must avoid:

```text
- Hidden global parser state.
- Hidden global dialect state.
- Hidden global current vehicle.
- Treating a UDP port as the same thing as a vehicle.
- Requiring serial dependencies for UDP/TCP users.
- Burying mission state machines inside comms.
- Making every node independently open its own socket.
- Making flow tabs require a spiderweb of link nodes just to talk to the same vehicle.
```

## 3. Package and Node Names

Package name:

```text
node-red-contrib-mavlink-ai
```

Internal Node-RED type names:

```text
mavlink-ai-profile
mavlink-ai-connection
mavlink-ai-in
mavlink-ai-out
mavlink-ai-build
mavlink-ai-filter
mavlink-ai-command
mavlink-ai-mission
```

Palette display names:

```text
MAVLink AI Profile
MAVLink AI Connection
MAVLink AI In
MAVLink AI Out
MAVLink AI Build
MAVLink AI Filter
MAVLink AI Command
MAVLink AI Mission
```

The `mavlink-ai-*` prefix is intentional. The module must coexist with earlier modules such as:

```text
mavlink-comms
mavlink-msg
mavlink-mission
node-red-contrib-mavlink-aigen
```

No migration support is required for v2 unless explicitly requested later. v2 should be clean, separate, and boringly predictable.

## 4. Node-RED Flow Model

Node-RED config nodes are reusable shared configuration objects. Users can create multiple instances of the same config-node type, and regular nodes can reference them.

This module should use two config-node layers:

```text
mavlink-ai-profile
mavlink-ai-connection
```

A profile can be reused by one or more connections.

A connection can be reused by nodes on multiple Node-RED flow tabs.

Important distinction:

```text
A config node can be shared across tabs.
A config node is not automatically a wire between tabs.
```

This matters. A config node does not magically pass Node-RED `msg` objects from one flow tab to another. But a config node can own a shared runtime resource, like a socket, serial port, subscription list, parser, or outbound queue.

Therefore, the connection config node should own the runtime session and expose methods/events to regular nodes.

That allows this pattern:

```text
Tab: Copter Telemetry
  [MAVLink AI In] -> [MAVLink AI Filter] -> [Debug/Dashboard]
       uses: Copter UDP Connection

Tab: Copter Commands
  [Inject] -> [MAVLink AI Command] -> [MAVLink AI Out]
       uses: Copter UDP Connection

Tab: Copter Mission
  [Inject] -> [MAVLink AI Mission]
       uses: Copter UDP Connection
```

All three tabs can use the same connection config node without requiring visible wires between tabs.

This is the core reason `mavlink-ai-connection` should be a config node instead of only a normal visible `comms` node.

## 5. Why Not One Big Comms Node?

A visible comms node is tempting:

```text
[serial/udp/tcp + dialect + parser + mission + heartbeat + commands]
```

That is easy to demo and miserable to extend.

Problems with one big comms node:

```text
- Other tabs need link nodes to send through it.
- Dialect becomes tied to a transport instead of the MAVLink profile.
- Multiple vehicles become awkward.
- Mission workflow state gets mixed into socket state.
- Testing protocol behavior requires transport setup.
- UDP routing becomes an afterthought.
- Commands and message builders become dependent on a specific comms node instance.
```

Better model:

```text
Profile node: owns protocol identity/defaults.
Connection node: owns transport/session.
Regular nodes: build, filter, receive, send, command, mission.
```

## 6. Profile Config Node

The profile config node describes a MAVLink identity and its protocol defaults.

It does **not** own sockets, serial ports, TCP listeners, UDP ports, mission locks, timers, or peer state.

Type:

```text
mavlink-ai-profile
```

Responsibilities:

```text
- Profile name.
- Profile type / vehicle type.
- Dialect selection.
- MAVLink version preference.
- Source system ID.
- Source component ID.
- Default target system.
- Default target component.
- Preferred mission item message type.
- Default mission type.
- Heartbeat identity defaults.
- Protocol/debug preferences.
```

Suggested fields:

```text
Name
Profile type: generic | gcs | companion-computer | copter | plane | rover | boat | sub | antenna-tracker
Dialect: ardupilotmega | common | minimal | custom
Custom dialect path
MAVLink version: auto | v1 | v2
Source system ID
Source component ID
Default target system
Default target component
Preferred mission item type: MISSION_ITEM_INT | MISSION_ITEM
Default mission type: mission | fence | rally | all
Heartbeat MAV_TYPE
Heartbeat autopilot type
Protocol debug enabled
```

Default profile values:

```text
Profile type: gcs
Dialect: ardupilotmega
MAVLink version: auto
Source system ID: 255
Source component ID: 190
Default target system: 1
Default target component: 1
Preferred mission item type: MISSION_ITEM_INT
Default mission type: mission
Heartbeat MAV_TYPE: MAV_TYPE_GCS
Heartbeat autopilot type: MAV_AUTOPILOT_INVALID
```

The defaults should make the module useful as a lightweight GCS/client first. Vehicle profiles can then define the target vehicle defaults.

## 7. Vehicle Type Is Not Dialect

Vehicle type and dialect are separate concepts.

This is important enough to repeat.

A copter, plane, and rover may all use:

```text
ardupilotmega
```

But they may have different defaults:

```text
Copter Profile
- profile type: copter
- dialect: ardupilotmega
- default target system: 1
- heartbeat type: MAV_TYPE_QUADROTOR or GCS depending on source identity
- preferred mission item type: MISSION_ITEM_INT

Rover Profile
- profile type: rover
- dialect: ardupilotmega
- default target system: 2
- heartbeat type: MAV_TYPE_GROUND_ROVER or GCS depending on source identity
- preferred mission item type: MISSION_ITEM_INT

Plane Profile
- profile type: plane
- dialect: ardupilotmega
- default target system: 3
- heartbeat type: MAV_TYPE_FIXED_WING or GCS depending on source identity
- preferred mission item type: MISSION_ITEM_INT
```

The dialect defines the message dictionary. The profile defines how this Node-RED runtime should behave when dealing with a specific MAVLink system or role.

A profile's role is its own MAVLink identity, not the target's vehicle type. A `companion-computer` profile (a Raspberry Pi or other onboard controller) announces itself as `MAV_TYPE_ONBOARD_CONTROLLER` with `MAV_AUTOPILOT_INVALID`, and suggests source component id `191` (`MAV_COMP_ID_ONBOARD_COMPUTER`) while leaving the source system id user-configurable — an onboard companion normally shares its vehicle's system id but keeps its own component id. This role is independent of firmware, dialect, and the target vehicle type, so the same preset works with copters, planes, rovers, boats, and subs on ArduPilot, PX4, or a custom stack.

```text
Companion Computer Profile
- profile type: companion-computer
- heartbeat type: MAV_TYPE_ONBOARD_CONTROLLER
- heartbeat autopilot: MAV_AUTOPILOT_INVALID
- source component id: 191 (MAV_COMP_ID_ONBOARD_COMPUTER), user-overridable
- source system id: vehicle SysID (commonly 1), user-configurable
- default target system/component: vehicle autopilot (commonly 1 / 1)
```

## 8. Connection Config Node

The connection config node owns transport and session state.

Type:

```text
mavlink-ai-connection
```

Responsibilities:

```text
- Own UDP socket, serial port, or TCP socket/server.
- Reference a default profile.
- Decode inbound MAVLink packets.
- Route inbound packets to profiles using sysid/compid.
- Encode outbound messages.
- Track UDP peer state.
- Own outbound queue.
- Own heartbeat timer.
- Own reconnect timer.
- Own subscription registry.
- Emit status and error events.
- Close resources cleanly on redeploy/stop.
```

Suggested fields:

```text
Name
Default profile
Transport: serial | udp-peer | udp-in | udp-out | tcp-client | tcp-server
Serial path
Serial baud
Serial data bits
Serial stop bits
Serial parity
UDP bind address
UDP bind port
UDP remote host
UDP remote port
TCP host
TCP port
Reconnect enabled
Heartbeat enabled
Heartbeat interval
Routing mode: single-profile | routed
Accepted sysids
Accepted compids
Route table
Inbound rate limits
Outbound queue enabled
```

A connection references one default profile. In simple mode, all accepted packets use that profile. In routed mode, packets can be mapped to multiple profiles by sysid/compid.

## 9. UDP, sysid, and compid

A UDP socket is bound by the OS to:

```text
IP address + UDP port
```

Example:

```text
0.0.0.0:14550
```

MAVLink system/component identity is inside the MAVLink packet:

```text
sysid + compid
```

Example:

```text
sysid: 1
compid: 1
```

The OS cannot bind a UDP socket to a MAVLink sysid or compid. The module can only inspect MAVLink packets after receiving them and then route/filter based on decoded packet identity.

Therefore:

```text
UDP bind = connection concern
sysid/compid mapping = routing concern
vehicle defaults = profile concern
```

### 9.1 Simple UDP Mode

Most users start here:

```text
Connection: Copter UDP 14550
Transport: udp-peer
Bind: 0.0.0.0:14550
Mode: single-profile
Profile: Copter
Accept sysid: 1
Accept compid: any
```

This means:

```text
Listen on UDP 14550.
Decode inbound packets.
Only accept sysid 1 unless configured otherwise.
Treat accepted packets as belonging to Copter Profile.
Send replies to the learned UDP peer if udp-peer mode is used.
```

### 9.2 Routed UDP Mode

Advanced users may receive multiple MAVLink systems on one UDP socket:

```text
Connection: Swarm UDP 14550
Transport: udp-peer
Bind: 0.0.0.0:14550
Mode: routed

Routes:
  1:* -> Copter Profile
  2:* -> Rover Profile
  3:* -> Plane Profile
```

This supports:

```text
- SITL swarms.
- mavlink-router style fan-in.
- Companion-computer relays.
- Shared radio links.
- Multiple components visible through one endpoint.
- Flight controller + camera + gimbal + payload combinations.
```

### 9.3 Multiple-Port Mode

Also valid:

```text
Copter UDP 14550 -> Copter Profile
Rover UDP 14551  -> Rover Profile
Plane UDP 14552  -> Plane Profile
```

The module should support all three models:

```text
one port, one vehicle
one port, multiple vehicles
multiple ports, multiple vehicles
```

Do not bake in a box canyon.

## 10. Route Table

The route table maps MAVLink identity to profile.

Route matching should support:

```text
sysid exact
compid exact
sysid wildcard
compid wildcard
priority/order
fallback profile
reject unmatched
```

Example route config (`profile` is the profile **config-node id** — the
canonical reference; the connection editor's route picker stores it for you):

```json
[
  { "sysid": 1, "compid": "*", "profile": "a1b2c3d4e5f60708" },
  { "sysid": 2, "compid": "*", "profile": "b2c3d4e5f6071809" },
  { "sysid": 3, "compid": 1, "profile": "c3d4e5f607182910" },
  { "sysid": 3, "compid": 154, "profile": "d4e5f60718293a1b" }
]
```

A plain profile name is accepted for backward compatibility only while exactly
one profile config node has that name. A route whose profile reference cannot
be resolved rejects its packets and reports the misconfiguration loudly (at
deploy time and once per packet identity) — it must never silently fall back
to the default profile, which would decode, signature-check, and label the
packet with the wrong dialect.

Routing decisions should be deterministic.

If two routes match, the more specific route wins:

```text
sysid + compid exact
sysid exact + compid wildcard
sysid wildcard + compid exact
wildcard fallback
```

If no route matches, behavior should be configurable:

```text
reject unmatched
use default profile
emit warning and reject
emit warning and use default profile
```

Default should probably be:

```text
single-profile mode: use default profile if accepted by filters
routed mode: reject unmatched and emit warning/status event
```

## 11. Runtime Architecture

Simple architecture:

```text
[mavlink-ai-profile: Copter]
          ^
          |
[mavlink-ai-connection: Copter UDP]
          ^
          |
          +-- [mavlink-ai-in]
          +-- [mavlink-ai-out]
          +-- [mavlink-ai-build]
          +-- [mavlink-ai-filter]
          +-- [mavlink-ai-command]
          +-- [mavlink-ai-mission]
```

Routed architecture:

```text
[mavlink-ai-profile: Copter] <--- route 1:*
[mavlink-ai-profile: Rover]  <--- route 2:*
[mavlink-ai-profile: Plane]  <--- route 3:*

[mavlink-ai-connection: UDP 14550]
          |
          +-- owns socket
          +-- decodes packets
          +-- routes inbound packets by sysid/compid
          +-- applies profile/default target behavior to outbound messages
          +-- owns parser/encoder/session state
```

Flow-tab architecture:

```text
Tab: Telemetry
  [mavlink-ai-in] -> [mavlink-ai-filter] -> [debug]

Tab: Commands
  [inject] -> [mavlink-ai-command] -> [mavlink-ai-out]

Tab: Mission
  [inject] -> [mavlink-ai-mission]

All use: [mavlink-ai-connection: Copter UDP]
```

## 12. Internal APIs

The connection node should expose an internal API to regular nodes.

Suggested API:

```js
connection.send(message, options)
connection.sendRaw(buffer, options)
connection.subscribe(filter, callback)
connection.unsubscribe(subscriptionId)
connection.getStatus()
connection.getProfileForPacket(packet)
connection.resolveProfile(idOrUniqueName) // throws PROFILE_UNRESOLVED/PROFILE_AMBIGUOUS
connection.acquireLock(lockName, owner, options)
connection.releaseLock(lockName, owner)
```

The profile node should expose:

```js
profile.getDefaults()
profile.getDialect()
profile.getProtocolOptions()
profile.getMessageDefinition(messageNameOrId)
profile.getEnum(enumName)
profile.normalizeFields(messageName, fields)
```

Protocol code should live in `lib/protocol`, not directly in the Node-RED node files.

Transport code should live in `lib/transport`, not directly in the Node-RED node files.

Mission workflow code should live in `lib/mission`, not directly in the Node-RED node files.

## 13. Regular Nodes

### 13.0 Connection vs. Profile: which is required (#127)

The nodes deliberately split on which config node is required, and it is not an
inconsistency to reconcile away — it follows from what each node *does*:

- **Message-building nodes require a Profile, Connection optional.**
  `mavlink-ai-command`, `mavlink-ai-build`, `mavlink-ai-fanout`, `mavlink-ai-move`,
  and `mavlink-ai-payload` construct a message. That needs a dialect/encoding
  identity (the Profile) but not a live link — they can build offline and either
  send through an optional Connection or emit a `mavlink/send` message for a
  downstream `mavlink-ai-out`.
- **Protocol/traffic nodes require a Connection, Profile optional.**
  `mavlink-ai-param`, `mavlink-ai-mission`, `mavlink-ai-in`, `mavlink-ai-out`,
  and `mavlink-ai-swarm` run a live exchange or ride the wire, so they need the
  Connection; the Profile is an optional override (and `in`/`out`/`swarm` carry
  no Profile config reference at all — only an optional profile *filter*).

The rule of thumb: **need a dialect to build a message → Profile required; need
the live link → Connection required.** On the nodes where the Profile is the
optional one (`param`, `mission`), it is presented under an **Advanced** section
so the common case (the Connection already carries a default profile) isn't
cluttered by a field most flows never set.

### 13.1 `mavlink-ai-in`

Receives decoded MAVLink messages from a shared connection.

Fields:

```text
Name
Connection
Message filter: all | by name | by ID | by list | by regex
sysid filter
compid filter
Profile filter
Rate limit
Changed-only mode
Output mode: decoded | raw | both
Status/error output enabled
```

Outputs:

```text
Output 1: decoded messages
Output 2: raw packets, optional
Output 3: status/errors, optional
```

Default should be safe and not noisy:

```text
Output decoded messages only.
No raw packets unless requested.
No high-volume debug unless requested.
```

### 13.2 `mavlink-ai-out`

Sends MAVLink messages through a shared connection.

Accepted input topics:

```text
mavlink/send
mavlink/raw
```

Accepted payloads:

```text
normalized outbound message object
raw Buffer
```

It should not build high-level commands itself. It sends what it is given.

### 13.3 `mavlink-ai-build`

Builds a normalized MAVLink message object without sending it.

Useful for visual flow composition.

Modes:

```text
Fixed message type
Message type from msg
Field mapping from node config
Field mapping from msg.payload
Profile defaults applied or not applied
Enum name resolution enabled or disabled
```

This node should eventually validate required fields using the selected dialect/profile.

### 13.4 `mavlink-ai-filter`

Filters decoded MAVLink messages.

Useful filters:

```text
Message name
Message ID
Profile name
sysid
compid
target_system
target_component
field value
field exists
rate limit
changed only
```

Examples:

```text
Pass only HEARTBEAT.
Pass only GLOBAL_POSITION_INT from sysid 1.
Pass only MISSION_* messages.
Pass only messages where target_system is 1 or missing.
Limit ATTITUDE to 5 per second.
```

High-rate telemetry can flood Node-RED. Rate limiting is not decorative; it is survival.

### 13.5 `mavlink-ai-command`

Builds common command messages.

Initial commands:

```text
arm
disarm
set mode
takeoff
land
RTL
reboot autopilot
request message
set message interval
```

Primary output should be a normalized outbound message for `mavlink-ai-out`.

Preferred flow:

```text
[inject] -> [mavlink-ai-command] -> [mavlink-ai-out]
```

Optional later ergonomic mode:

```text
mavlink-ai-command direct-sends through selected connection
```

But direct-send should not be the only path. Building messages and sending messages are separate concerns.

#### Metadata-driven raw `MAV_CMD_*` controls (issue #97)

Friendly presets stay the preferred path, but raw `MAV_CMD_*` mode also renders
the best control each parameter's metadata supports rather than a bare numeric
input:

- ordinary enum param → dropdown from the dialect enum table
- bitmask enum param → flag checklist (the combined OR value is persisted)
- boolean param → checkbox (identified from the MAVLink `MAV_BOOL` convention)
- min/max/increment metadata → constrained numeric input
- firmware/vehicle/component/dialect-specific param → profile-aware dropdown

Generic constraints (`min`/`max`/`increment`) are recovered from the generated
`.d.ts` JSDoc alongside the existing name/description/units. Enum, bitmask,
boolean, and resolver associations — which neither the `.d.ts` nor the bundled
XML can express — come from a small, reusable registry (`lib/command/param-metadata.js`);
custom dialects can add hints via `registerParamControl` without a hand-written
preset per command.

Context-specific parameters defer to named resolvers (`lib/command/param-resolvers.js`):
`profile-flight-mode` maps a mode name to the firmware/vehicle-specific wire
value (`GUIDED` is 4 on ArduCopter, 15 on ArduPlane), and `component-mode`
selects the right enum for the target component type (camera vs gimbal/mount).
The editor fetches choices from `GET /mavlink-ai/param-choices` and refreshes
them when the profile or target component changes. Every enum/profile-aware
control keeps a **Custom value…** numeric escape hatch, preserves unknown
imported values, and falls back to a plain numeric input when no trustworthy
mapping exists — so existing raw-command flows stay compatible.

### 13.6 `mavlink-ai-mission`

Mission protocol workflow node.

Mission handling is stateful, timeout-driven, and easy to make awful. Keep it isolated.

Actions:

```text
download mission
upload mission
clear mission
request mission count
request mission item
send mission item
send mission ack
```

Outputs:

```text
Output 1: completed mission object
Output 2: progress events
Output 3: errors/timeouts
```

Mission protocol logic must not be buried in the transport layer.

### 13.7 `mavlink-ai-param`

Parameter protocol workflow node.

Like the mission protocol, PARAM handling is stateful and timeout-driven, so it
is kept isolated behind an explicit workflow (`lib/param`) and a per-target lock.

Actions:

```text
read one parameter (by id or index)
set one parameter (confirmed via echoed PARAM_VALUE)
request full parameter list (missing items re-requested on a lossy link)
```

Outputs:

```text
Output 1: result (param/value, param/set, or param/list)
Output 2: progress events
Output 3: errors/timeouts
```

Parameter protocol logic must not be buried in the transport layer.

## 14. Message Contracts

The module needs stable message contracts. Do not let every node invent its own payload shape.

### 14.1 Decoded MAVLink Message

```js
{
  topic: "mavlink/HEARTBEAT",
  payload: {
    name: "HEARTBEAT",
    id: 0,
    sysid: 1,
    compid: 1,
    profile: "Copter",
    fields: {
      type: "MAV_TYPE_QUADROTOR",
      autopilot: "MAV_AUTOPILOT_ARDUPILOTMEGA",
      base_mode: 81,
      custom_mode: 0,
      system_status: "MAV_STATE_ACTIVE"
    },
    raw: {
      magic: 253,
      seq: 42,
      incompat_flags: 0,
      compat_flags: 0
    },
    transport: {
      name: "Copter UDP 14550",
      type: "udp-peer",
      remoteAddress: "127.0.0.1",
      remotePort: 14550
    },
    receivedAt: 1782849600000
  }
}
```

**64-bit integer fields.** MAVLink `int64_t` / `uint64_t` fields (e.g.
`time_usec`) carry more range than a JavaScript `Number` can hold without loss
and decode natively as `BigInt`, which is not JSON-serializable. In the public
decoded payload they are represented as **decimal strings** — e.g.
`time_usec: "1782849600000123"`. This preserves the full signed/unsigned 64-bit
range, lets the payload pass through `JSON.stringify()` (MQTT, HTTP, file,
database, Debug JSON views, context persistence) unchanged, and feeds back
losslessly into an outbound message: the builder accepts decimal strings, safe
integers, or `BigInt` for these fields. 64-bit values are never routed through
`Number`, where precision above 2^53 would be silently lost.

### 14.2 Outbound MAVLink Message

```js
{
  topic: "mavlink/send",
  payload: {
    name: "COMMAND_LONG",
    profile: "Copter",
    target_system: 1,
    target_component: 1,
    fields: {
      command: "MAV_CMD_COMPONENT_ARM_DISARM",
      confirmation: 0,
      param1: 1
    }
  }
}
```

### 14.3 Raw Message

```js
{
  topic: "mavlink/raw",
  payload: Buffer
}
```

### 14.4 Status Message

```js
{
  topic: "mavlink/status",
  payload: {
    node: "mavlink-ai-connection",
    connection: "Copter UDP 14550",
    state: "connected",
    transport: "udp-peer",
    timestamp: 1782849600000,
    detail: "Listening on 0.0.0.0:14550"
  }
}
```

### 14.5 Error Message

```js
{
  topic: "mavlink/error",
  payload: {
    node: "mavlink-ai-mission",
    connection: "Copter UDP 14550",
    code: "MISSION_TIMEOUT",
    message: "Timed out waiting for MISSION_COUNT",
    context: {
      target_system: 1,
      target_component: 1,
      mission_type: "MAV_MISSION_TYPE_MISSION"
    }
  }
}
```

### 14.5.1 Error delivery rule

A normal operational failure is delivered exactly once:

- A node with a **dedicated error output** (Mission, Param) or whose single
  output carries error envelopes (Command, Fanout, Build, Filter) sends the
  structured `mavlink/error` message there and finishes with `done()`. The
  wired error output is the delivery; the same failure must **not** also
  trigger Catch nodes.
- A node with **no outputs** (Out) finishes with `done(err)` so Catch nodes
  can handle the failure — that is its only delivery path.
- Programmer/internal exceptions (not operational failures) may still use
  `node.error(...)`, but must not duplicate an already-delivered failure.

## 15. Dialect Handling

Dialect handling belongs to the profile/protocol layer.

Supported dialect sources:

```text
bundled: common, ardupilotmega, minimal
local path: mounted file or /data path
custom: user-provided XML path
```

Bundled dialects should live under:

```text
lib/dialects/bundled/
```

Cached or user-provided dialects may live under:

```text
/data/mavlink/dialects/
```

Bad behavior:

```text
Selected ardupilotmega fails, module silently uses common.
```

Good behavior:

```text
Selected ardupilotmega fails, profile marks invalid, nodes report useful error.
```

Optional advanced setting:

```text
[ ] Fall back to common if dialect load fails
```

Default: unchecked.

Silent fallback is evil because it creates fake success. The node looks alive while message definitions are wrong or missing.

## 16. Protocol Layer

Protocol code should be isolated behind a wrapper.

Suggested files:

```text
lib/protocol/mavlink-codec.js
lib/protocol/message-normalizer.js
lib/protocol/enum-resolver.js
lib/protocol/message-validator.js
```

Responsibilities:

```text
- Load dialect definitions.
- Create parser/encoder instances.
- Decode raw packets into normalized messages.
- Encode normalized outbound messages into raw packets.
- Resolve enum names to numeric values.
- Resolve numeric enum values to names when useful.
- Validate required fields.
- Apply profile defaults.
```

Node files should not need to know the ugly details of `node-mavlink` usage. They should call wrapper methods.

## 17. Transport Handling

Transport belongs to the connection layer.

Supported transports:

```text
serial
udp-peer
udp-in
udp-out
tcp-client
tcp-server
```

### 17.1 UDP

UDP modes:

```text
udp-in    listen only
udp-out   send only
udp-peer  listen, learn peer, and reply
```

`udp-peer` should be the likely default for GCS/SITL style usage.

UDP peer tracking should remember the most recent valid sender for a route/profile when configured to do so.

Questions to decide during implementation:

```text
- Should peer tracking be global per connection?
- Per sysid?
- Per sysid/compid?
- Manually pinned remote host/port only?
```

Likely default:

```text
udp-peer learns remote endpoint per sysid, with manual remote host/port override available.
```

### 17.2 Serial

Serial fields:

```text
path
baud
data bits
stop bits
parity
reconnect
```

Serial is optional. The module must not require `serialport` for UDP/TCP users.

### 17.3 TCP

TCP modes:

```text
tcp-client
tcp-server
```

TCP is secondary to UDP and serial for initial development.

## 18. Dependency Rules

Core runtime dependency:

```text
node-mavlink
```

Optional runtime dependency:

```text
serialport
```

Rules:

```text
- serialport must be optional.
- serialport must be lazy-loaded only when serial transport is selected.
- UDP/TCP must work without serialport installed.
- Runtime dependencies go in dependencies.
- Test/build-only dependencies go in devDependencies.
```

Forbidden:

```js
const { SerialPort } = require("serialport");
```

Required pattern:

```js
function loadSerialPort() {
  try {
    return require("serialport");
  } catch (err) {
    throw new Error(
      "Serial transport requires optional dependency 'serialport'. Install it or select UDP/TCP transport."
    );
  }
}
```

This is not optional. Top-level serial imports break users who never wanted serial in the first place.

## 19. Connection Lifecycle

Node-RED redeploys happen constantly during development. Config nodes that own runtime resources must clean up correctly.

On close/redeploy/stop, a connection must:

```text
close serial port
close UDP socket
close TCP socket/server
clear heartbeat timer
clear reconnect timer
clear mission locks
clear outbound queue
remove event listeners
remove subscriptions
mark status closed
```

No hidden global singleton state.

Forbidden:

```js
let currentDialect;
let currentConnection;
let currentParser;
let currentVehicle;
```

Everything must be scoped to a config node instance.

## 20. Subscription Model

Regular nodes should subscribe to a connection instead of every node decoding packets independently.

A subscription should include filters:

```js
{
  messageNames: ["HEARTBEAT", "GLOBAL_POSITION_INT"],
  messageIds: [0, 33],
  sysid: 1,
  compid: "*",
  profile: "Copter",
  rateLimitHz: 5,
  raw: false
}
```

The connection should decode once, then distribute normalized messages to matching subscribers.

This avoids:

```text
- multiple decoders fighting over the same stream
- high-rate telemetry flooding every node
- duplicated route logic
- nodes needing to understand transport internals
```

## 21. Outbound Queue

Multiple flow tabs may try to send at once:

```text
heartbeat
mission download
arm command
mode change
request message
set stream interval
```

The connection should own outbound serialization.

Initial queue can be simple FIFO.

Future queue can support priority:

```text
0: emergency / mode / arm
1: mission protocol
2: requests
3: heartbeat/background
```

Do not overbuild priority at first, but do not allow every node to independently write to the socket with no coordination.

## 22. Heartbeat Design

Heartbeat is both simple and surprisingly easy to place badly.

Two possible designs:

```text
Option A: heartbeat is a setting on mavlink-ai-connection.
Option B: mavlink-ai-heartbeat visible node generates HEARTBEAT messages.
```

v2 should start with Option A:

```text
Connection can send heartbeat using profile defaults.
```

A visible heartbeat node can be added later if flow-level heartbeat control becomes important.

Heartbeat settings belong partly to profile and partly to connection:

```text
Profile: heartbeat identity values.
Connection: whether to send heartbeat and interval.
```

## 23. Mission Locking

Only one mission workflow should run per connection/profile/mission_type at a time.

This should fail clearly:

```text
Mission workflow already active for Copter UDP 14550 / mission.
```

Do not allow two mission downloads to both request item 0, both wait for item 1, and then try to assemble the same mission. That is how the goblins get promoted to management.

Lock key shape:

```text
mission:<connection-id>:<profile-id>:<mission-type>
```

## 24. Mission State Machines

Mission handling should be explicit.

Download states:

```text
idle
request_list_sent
waiting_count
requesting_item
waiting_item
assembling
sending_ack
complete
failed
```

Upload states:

```text
idle
count_sent
waiting_request
sending_item
waiting_ack
complete
failed
```

Default timeouts:

```text
mission response timeout: 3000 ms
max retries per item: 3
```

These should be configurable.

Progress event example:

```js
{
  topic: "mission/progress",
  payload: {
    state: "requesting_item",
    seq: 4,
    count: 12
  }
}
```

Completed mission example:

```js
{
  topic: "mission/downloaded",
  payload: {
    target_system: 1,
    target_component: 1,
    mission_type: "MAV_MISSION_TYPE_MISSION",
    count: 12,
    items: [
      {
        seq: 0,
        command: "MAV_CMD_NAV_WAYPOINT",
        frame: "MAV_FRAME_GLOBAL_RELATIVE_ALT_INT",
        x: 399999999,
        y: -749999999,
        z: 50
      }
    ]
  }
}
```

Do not start implementation with mission. Mission depends on profile, protocol, connection, routing, subscriptions, and send queue being sane first.

## 25. Status and Errors

Status should be structured, not random strings.

Good status:

```js
{
  topic: "mavlink/status",
  payload: {
    node: "mavlink-ai-connection",
    connection: "Copter UDP 14550",
    state: "connected",
    transport: "udp-peer",
    detail: "Listening on 0.0.0.0:14550"
  }
}
```

Good error:

```js
{
  topic: "mavlink/error",
  payload: {
    node: "mavlink-ai-profile",
    code: "DIALECT_LOAD_FAILED",
    message: "Unable to load dialect ardupilotmega",
    context: {
      dialect: "ardupilotmega"
    }
  }
}
```

Avoid mystery errors like:

```text
Error: undefined
failed
bad packet
nope
```

That stuff is how logs become haunted furniture.

## 26. UI/UX Naming Rules

Names matter in Node-RED because config nodes are often selected from dropdowns.

Good names:

```text
AI Profile - Copter
AI Profile - Rover
AI Profile - Plane
AI Conn - Copter UDP 14550
AI Conn - Rover Serial USB0
AI Conn - Plane TCP SITL
```

Bad names:

```text
config
mavlink
test
thing
serial
udp
```

Default labels should include enough detail to tell profiles and connections apart.

## 27. File Layout

Suggested repo layout:

```text
nodes/
  mavlink-ai-profile.js
  mavlink-ai-profile.html
  mavlink-ai-connection.js
  mavlink-ai-connection.html
  mavlink-ai-in.js
  mavlink-ai-in.html
  mavlink-ai-out.js
  mavlink-ai-out.html
  mavlink-ai-build.js
  mavlink-ai-build.html
  mavlink-ai-filter.js
  mavlink-ai-filter.html
  mavlink-ai-command.js
  mavlink-ai-command.html
  mavlink-ai-mission.js
  mavlink-ai-mission.html

lib/
  dialects/
    bundled/
      common.xml
      ardupilotmega.xml
      minimal.xml
    dialect-loader.js
    dialect-cache.js
  protocol/
    mavlink-codec.js
    message-normalizer.js
    enum-resolver.js
    message-validator.js
  transport/
    serial-transport.js
    udp-transport.js
    tcp-transport.js
  routing/
    route-table.js
    packet-router.js
  mission/
    mission-download.js
    mission-upload.js
    mission-state-machine.js
  util/
    status.js
    errors.js
    validation.js

test/
  fixtures/
  unit/
  integration/
  flows/

examples/
  01-getting-started/
    01-udp-heartbeat-listener.json
    03-build-and-send-heartbeat.json
    ...
  02-vehicle-control/
    04-arm-disarm-command.json
    ...
  03-parameters/
    10-param-read-write.json
  04-missions/
    06-download-mission.json
  05-routing/
    02-udp-routed-multi-vehicle.json
    ...
  06-payloads-and-peripherals/
    15-command-servo-relay.json
    ...
  07-safety-critical/
    19-command-calibration-warning-gated.json
    20-command-parachute-warning-gated.json
  08-sitl/
    px4-sitl-telemetry.json
```

Do not keep everything in root-level node files forever. That is how v1 becomes soup.

### 27.1 JSDoc and Code Documentation

JSDoc is the project's comment format, used in lieu of any other type of comment. It is part of the code-quality standard expected for CodeRabbit review compliance. Every comment that explains code — whether it documents a declaration or a strictly local implementation detail inside a function body — is written as a JSDoc block (`/** ... */`). Ordinary `//` line comments and plain `/* ... */` block comments are not used for commentary.

This standard was adopted mid-project and applies **going forward**: new code and modified code follow it, while pre-existing `//` commentary is grandfathered. Convert old comments opportunistically when editing the code around them; do not run bulk rewrite sweeps whose only change is comment style.

The only non-JSDoc comments permitted are machine-read directives that tooling requires in a specific syntax and that carry no prose explanation of their own — for example `// eslint-disable-next-line ...`, `/* istanbul ignore next */` / coverage pragmas, and a `#!` shebang. If such a directive needs justification, put the justification in a JSDoc block; keep the directive line itself to the bare pragma.

Prefer to capture rationale in the enclosing declaration's JSDoc. When a note is genuinely local to a spot inside a function body, still write it as a `/** ... */` block immediately above the statement it explains, not as a `//` line. Documentation must never be written as `//` on a function, class, method, module, typedef, field, or other declaration.

At minimum, add JSDoc to:

```text
- Exported functions, classes, constructors, methods, constants, and modules.
- Public and cross-module internal APIs, including the connection and profile APIs.
- Node-RED registration functions and non-obvious event handlers/callbacks.
- Functions with parameters, return values, thrown errors, callbacks, Promises, or important side effects.
- Complex internal helpers, state-machine transitions, transport/protocol boundaries, and lifecycle cleanup.
- Reused object shapes via @typedef, especially normalized messages, profiles, routes, subscriptions, status/error envelopes, and workflow state.
```

Use the applicable tags rather than prose alone:

```text
@param
@returns / @return
@throws
@typedef
@property
@callback
@template
@async
@deprecated
```

Documentation must describe the contract and the reason for surprising behavior, not merely restate the code. Keep JSDoc synchronized with implementation changes. Do not add empty boilerplate to trivial private one-liners solely to increase comment count; useful coverage and correctness matter more than decorative comments.

## 28. Testing Plan

Unit tests:

```text
dialect loading
enum lookup
message normalization
message build validation
route matching
wildcard route priority
UDP peer tracking
subscription filtering
rate limiting
mission state transitions
timeout behavior
retry behavior
serial lazy-load behavior
```

Integration tests:

```text
UDP loopback
recorded heartbeat packet decode
recorded mission download sequence
bad dialect file
unknown message name
routed multi-sysid packet stream
missing serialport with UDP-only config
serial transport selected without serialport
connection cleanup on close
```

Manual Node-RED example flows:

```text
01 UDP heartbeat listener
02 UDP routed multi-vehicle listener
03 Build and send heartbeat
04 Arm/disarm command
05 Request autopilot version
06 Download mission
07 Filter GLOBAL_POSITION_INT
08 Raw packet debug
09 Serial connection example
```

## 29. Acceptance Criteria

v2 architecture baseline is acceptable when:

```text
- Nodes load in Node-RED without dependency errors.
- UDP/TCP work without serialport installed.
- Serial selection fails clearly if serialport is missing.
- Multiple profile config nodes can coexist.
- Multiple connection config nodes can coexist.
- One connection can route sysid/compid packets to multiple profiles.
- Regular nodes on separate flow tabs can use the same connection config.
- mavlink-ai-in can emit decoded HEARTBEAT messages from UDP.
- mavlink-ai-build can build HEARTBEAT and COMMAND_LONG objects.
- mavlink-ai-out can send normalized messages.
- mavlink-ai-command can build arm/disarm commands.
- mavlink-ai-mission can download a mission against SITL or a recorded harness.
- Invalid dialects fail loudly.
- Example flows exist.
- Smoke-load test passes.
```

## 30. Implementation Order

Build in this order:

```text
1. package.json and Node-RED node registration skeleton
2. mavlink-ai-profile config node
3. dialect loader and protocol wrapper
4. mavlink-ai-connection config node
5. UDP transport
6. inbound subscription/event model
7. mavlink-ai-in and mavlink-ai-out
8. message contracts and normalizer
9. mavlink-ai-build
10. mavlink-ai-filter
11. mavlink-ai-command
12. mission state machine
13. mavlink-ai-mission
14. serial transport lazy-load
15. TCP transport
16. example flows
17. tests
18. README polish
```

Do not start with mission handling. Mission handling before the connection/subscription model is stable is how software goes to the cornfield.

## 31. Early Implementation Priorities

The first real code should prove these things:

```text
- Node-RED loads the package.
- Multiple profiles can be created.
- A connection can reference a profile.
- UDP socket can receive bytes.
- Decoder can produce normalized HEARTBEAT messages.
- mavlink-ai-in can subscribe to those messages.
- mavlink-ai-filter can pass only selected messages.
- mavlink-ai-build can build a normalized HEARTBEAT or COMMAND_LONG.
- mavlink-ai-out can encode/send through the connection.
```

Only then touch mission workflows.

## 32. Design Traps to Avoid

### 32.1 Dialect in the Comms Node

Bad:

```text
mavlink-ai-connection owns dialect.
```

Better:

```text
mavlink-ai-profile owns dialect.
mavlink-ai-connection references profile(s).
```

### 32.2 One UDP Port Equals One Vehicle

Bad assumption:

```text
UDP 14550 means exactly one vehicle.
```

Better:

```text
UDP 14550 is one socket.
Packets inside it may contain one or many MAVLink systems.
Routes decide profile ownership.
```

### 32.3 Mandatory Serial Dependency

Bad:

```text
Requiring serialport breaks UDP-only installs.
```

Better:

```text
serialport is optional and lazy-loaded.
```

### 32.4 Mission in Transport

Bad:

```text
UDP packet handler directly runs mission download.
```

Better:

```text
Mission node subscribes to relevant messages and sends mission requests through connection API.
```

### 32.5 Global Parser

Bad:

```text
one global parser/dialect/current vehicle
```

Better:

```text
each connection/profile instance owns its required state
```

## 33. Final Architecture Statement

`node-red-contrib-mavlink-ai` should make the simple case easy:

```text
one UDP port -> one copter -> decoded messages
```

And the advanced case possible:

```text
one UDP port -> multiple sysids -> multiple profiles -> separate flows
```

The architecture should stay boring:

```text
Profile owns protocol identity.
Connection owns the wire.
Routing maps packets to profiles.
Nodes build, filter, send, receive, and run workflows.
```

No global parser state.
No mandatory serial baggage.
No dialect buried inside a comms node.
No mission workflow hiding inside transport code.
No v1 soup in a fake mustache.
