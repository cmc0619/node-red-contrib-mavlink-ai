# MAVLink AI v2 Design

## 1. Purpose

`node-red-contrib-mavlink-ai` is a second-generation Node-RED MAVLink module.

The goal is not to patch the old shape. The goal is to build a clean architecture where MAVLink protocol identity, transport, routing, message construction, and mission workflows are separated.

The core design rule:

```text
Profile    = what kind of MAVLink thing this is
Connection = how Node-RED talks to it
Route      = how sysid/compid packets map to profiles
Nodes      = what the flow does with messages
```

This module should coexist with older MAVLink Node-RED modules. It should use distinct package, node type, file, and palette names.

## 2. Package and Node Names

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
mavlink-ai-command
mavlink-ai-mission
mavlink-ai-filter
mavlink-ai-build
```

Palette display names:

```text
MAVLink AI Profile
MAVLink AI Connection
MAVLink AI In
MAVLink AI Out
MAVLink AI Command
MAVLink AI Mission
MAVLink AI Filter
MAVLink AI Build
```

No migration support is required. This is a new module with new names.

## 3. Node-RED Flow Model

Node-RED config nodes are reusable shared configuration objects. Users can create multiple instances of the same config node type, and regular nodes can reference them.

This module should use config nodes for shared MAVLink resources:

```text
[mavlink-ai-profile]
[mavlink-ai-connection]
```

A profile can be reused by one or more connections.

A connection can be reused by nodes on multiple Node-RED flow tabs.

Important distinction:

```text
A config node can be shared across tabs.
A config node is not automatically a wire between tabs.
```

Therefore, a connection config node should own the runtime transport/session resource and expose methods/events to regular nodes. Regular nodes on separate tabs can select the same connection config and interact with the same MAVLink session without requiring link nodes everywhere.

## 4. Profile vs Connection

### 4.1 Profile Config Node

The profile config node describes MAVLink identity, protocol behavior, and vehicle defaults.

It does not own sockets, serial ports, or TCP listeners.

Suggested type:

```text
mavlink-ai-profile
```

Suggested fields:

```text
Name
Profile type: generic | gcs | copter | plane | rover | boat | sub | antenna-tracker
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

### 4.2 Vehicle Type Is Not Dialect

Vehicle/profile type and dialect are separate concepts.

A copter, plane, and rover may all use:

```text
ardupilotmega
```

But each can have different defaults:

```text
Copter Profile
- profile type: copter
- dialect: ardupilotmega
- default target system: 1
- preferred mission item type: MISSION_ITEM_INT

Rover Profile
- profile type: rover
- dialect: ardupilotmega
- default target system: 2
- preferred mission item type: MISSION_ITEM_INT

Plane Profile
- profile type: plane
- dialect: ardupilotmega
- default target system: 3
- preferred mission item type: MISSION_ITEM_INT
```

This lets the module support multiple vehicles in one Node-RED runtime without global state contamination.

### 4.3 Connection Config Node

The connection config node owns the transport/session.

Suggested type:

```text
mavlink-ai-connection
```

Suggested fields:

```text
Name
Default profile
Transport: serial | udp-peer | udp-in | udp-out | tcp-client | tcp-server
Serial path
Serial baud
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

A connection references one default profile, but may route packets to multiple profiles in advanced mode.

## 5. UDP, sysid, and compid

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

The OS cannot bind a UDP socket to a MAVLink sysid or compid. The module can only inspect MAVLink packets after receiving them and route/filter based on decoded packet identity.

Therefore:

```text
UDP bind = connection concern
sysid/compid mapping = routing concern
vehicle defaults = profile concern
```

### 5.1 Simple UDP Mode

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

### 5.2 Routed UDP Mode

Advanced users can receive multiple MAVLink systems on one UDP socket:

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

This supports SITL swarms, mavlink-router, companion-computer routing, shared radio links, and multiple MAVLink components appearing on one connection.

### 5.3 Multiple-Port Mode

Also valid:

```text
Copter UDP 14550 -> Copter Profile
Rover UDP 14551  -> Rover Profile
Plane UDP 14552  -> Plane Profile
```

The module should support all three models without forcing one.

## 6. Runtime Architecture

Target architecture:

```text
[mavlink-ai-profile: Copter]
          ^
          |
[mavlink-ai-connection: Copter UDP]
          ^
          |
          +-- [mavlink-ai-in]
          +-- [mavlink-ai-out]
          +-- [mavlink-ai-command]
          +-- [mavlink-ai-mission]
          +-- [mavlink-ai-filter]
          +-- [mavlink-ai-build]
```

Multi-profile routed architecture:

```text
[mavlink-ai-profile: Copter] <--- route 1:*
[mavlink-ai-profile: Rover]  <--- route 2:*
[mavlink-ai-profile: Plane]  <--- route 3:*

[mavlink-ai-connection: UDP 14550]
          |
          +-- routes inbound packets by sysid/compid
          +-- applies outbound target/profile defaults
          +-- owns parser/encoder/session state
```

## 7. Regular Nodes

### 7.1 `mavlink-ai-in`

Receives decoded MAVLink messages from a connection.

Fields:

```text
Name
Connection
Message filter: all | by name | by ID | by regex/list
sysid filter
compid filter
Rate limit
Output mode: decoded | raw | both
```

Outputs:

```text
Output 1: decoded messages
Output 2: raw packets, optional
Output 3: status/errors, optional
```

### 7.2 `mavlink-ai-out`

Sends MAVLink messages through a connection.

Inputs:

```text
mavlink/send
mavlink/raw
```

The node should accept normalized outbound message objects and raw buffers.

### 7.3 `mavlink-ai-build`

Builds a MAVLink message object without sending it.

Useful when composing flows visually.

Modes:

```text
Fixed message type
Message type from msg
Field mapping from node config
Field mapping from msg.payload
```

### 7.4 `mavlink-ai-filter`

Filters decoded MAVLink messages.

Useful filters:

```text
Message name
Message ID
sysid
compid
target_system
target_component
field value
rate limit
changed only
```

### 7.5 `mavlink-ai-command`

Builds common commands.

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

This node should not own transport. It emits a normalized outbound MAVLink message for `mavlink-ai-out` or sends through a selected connection if direct-send mode is enabled.

Preferred design:

```text
Command node builds.
Out node sends.
```

Optional ergonomic design:

```text
Command node can direct-send through selected connection.
```

### 7.6 `mavlink-ai-mission`

Owns mission workflow state machines.

Actions:

```text
download mission
upload mission
clear mission
request mission count
request item
send item
send ack
```

Outputs:

```text
Output 1: completed mission object
Output 2: progress events
Output 3: errors/timeouts
```

Mission protocol logic must not be buried in the transport layer.

## 8. Message Contracts

### 8.1 Decoded Message

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
    }
  }
}
```

### 8.2 Outbound Message

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

### 8.3 Raw Message

```js
{
  topic: "mavlink/raw",
  payload: Buffer
}
```

### 8.4 Status Message

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

### 8.5 Error Message

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

## 9. Dialect Handling

Dialect handling belongs to the profile layer.

Supported dialect sources:

```text
bundled: common, ardupilotmega, minimal
local path: mounted file or /data path
custom: user-provided XML path
```

Do not silently fall back to `common` if the selected dialect fails.

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

## 10. Transport Handling

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

### 10.1 Serial

Required fields:

```text
path
baud
data bits
stop bits
parity
reconnect
```

### 10.2 UDP

Modes:

```text
udp-in    listen only
udp-out   send only
udp-peer  listen, learn peer, and reply
```

`udp-peer` should be the likely default for GCS/SITL-style usage.

### 10.3 TCP

Modes:

```text
tcp-client
tcp-server
```

TCP is secondary to UDP and serial for initial development.

## 11. Dependency Rules

Core runtime dependencies:

```text
node-mavlink
```

Optional runtime dependencies:

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

## 12. Connection Runtime Responsibilities

The connection config node should own:

```text
transport socket/port
connection state
parser/encoder instance
route table
peer tracking for udp-peer
outbound queue
heartbeat timer
lifecycle cleanup
status events
error events
```

It should expose an internal API to regular nodes:

```js
connection.send(message, options)
connection.sendRaw(buffer, options)
connection.subscribe(filter, callback)
connection.unsubscribe(subscriptionId)
connection.getStatus()
connection.getProfileForPacket(packet)
connection.resolveProfile(nameOrId)
```

## 13. Lifecycle Rules

Node-RED redeploys happen constantly during development.

Connection config nodes must clean up resources on close:

```text
close serial port
close UDP socket
close TCP socket/server
clear heartbeat timer
clear reconnect timer
clear mission locks
remove event listeners
```

No hidden global singleton state.

Forbidden:

```js
let currentDialect;
let currentConnection;
let currentParser;
```

Everything must be scoped to a config node instance.

## 14. Outbound Queue

Multiple flow tabs may try to send messages at once.

Examples:

```text
heartbeat
mission download
arm command
mode change
request data stream
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

Do not overbuild this at first, but do not let every node independently write to the socket without coordination.

## 15. Mission Locking

Only one mission workflow should run per connection/profile/mission_type at a time.

If a second mission workflow starts while one is active, return a clear error:

```text
Mission workflow already active for Copter UDP 14550 / mission.
```

Do not let two mission downloads both request mission items at the same time.

## 16. Mission State Machines

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

## 17. File Layout

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
  mavlink-ai-command.js
  mavlink-ai-command.html
  mavlink-ai-mission.js
  mavlink-ai-mission.html
  mavlink-ai-filter.js
  mavlink-ai-filter.html
  mavlink-ai-build.js
  mavlink-ai-build.html

lib/
  dialects/
    bundled/
    dialect-loader.js
    dialect-cache.js
  protocol/
    mavlink-codec.js
    message-normalizer.js
    enum-resolver.js
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
```

## 18. Testing Plan

Unit tests:

```text
dialect loading
enum lookup
message normalization
message build validation
route matching
UDP peer tracking
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

## 19. Acceptance Criteria

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
```

## 20. Implementation Order

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

Do not start with mission handling. Mission handling depends on the protocol, routing, connection, and subscription model being sane first.

## 21. Final Architecture Statement

`node-red-contrib-mavlink-ai` should be a MAVLink protocol layer for Node-RED, not a serial node with MAVLink features glued to it.

The design should make simple cases easy:

```text
one UDP port -> one copter -> decoded messages
```

And advanced cases possible:

```text
one UDP port -> multiple sysids -> multiple profiles -> separate flows
```

No global parser state. No mandatory serial dependency. No dialect buried inside a comms node. No mission workflow hiding inside transport code.

Clean lines or death by goblin soup.
