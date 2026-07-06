# node-red-contrib-mavlink-ai

A full-featured Node-RED MAVLink driver built around clean v2 architecture: reusable profiles, shared connections, routed multi-vehicle links, rich message builders, mission/parameter workflows, command presets, and swarm helpers.

This package is intentionally separate from earlier MAVLink Node-RED experiments so it can coexist with older drivers in the same Node-RED runtime.

> **Review draft:** this file is a human-review candidate for replacing `README.md`. It is written in a more feature-forward style while preserving the actual current behavior of the v2 implementation.

## Testing status

The v2 runtime has unit and integration coverage for the protocol, transports, routing, command workflows, mission/parameter workflows, custom dialect loading, signing, and swarm helpers. The integration suite includes UDP loopback tests against simulated MAVLink traffic.

Real hardware validation is still valuable. If you test this with ArduPilot, PX4, SITL, a Pixhawk-class flight controller, a companion computer, a MAVLink camera/gimbal, or a multi-vehicle setup, please open an issue with what worked, what failed, and what hardware/firmware was involved.

## Features

- **MAVLink v1/v2 support** with auto outbound version matching based on inbound peer traffic.
- **Multiple connection types**: UDP, TCP, and optional/lazy-loaded serial.
- **Profile-based architecture**: MAVLink identity, dialect, firmware, vehicle type, signing, target defaults, and mission defaults live in reusable config nodes.
- **Connection-based runtime**: one connection owns transport, decode, routing, subscriptions, queueing, heartbeat, locks, and peer state.
- **Bundled and custom XML dialects**: use bundled dialects or compile local/Docker-mounted MAVLink XML dialects at runtime.
- **No silent dialect fallback**: invalid dialects, bad XML, missing includes, include cycles, and unsupported remote includes fail loudly with structured errors.
- **Dynamic message builder**: message fields render from dialect metadata, with visible descriptions, units, types, and enum dropdowns where metadata exists.
- **Command presets**: common arm/disarm, mode, takeoff, land, RTL, guided/autonomy, mission, camera, telemetry, and system commands with friendly UI.
- **COMMAND_ACK workflow**: optionally wait for command acknowledgement with timeout/retry behavior and readable MAV_RESULT names.
- **Mission workflows**: download, upload, and clear missions with progress output, timeout/retry handling, target sysid/component support, and MISSION_ITEM_INT coordinate scaling.
- **Parameter workflows**: read one parameter, set one parameter, or request the full parameter list with progress/status output.
- **Multi-vehicle routing**: route inbound packets by sysid/compid to the correct profile and decode with that profile's dialect.
- **UDP peer tracking by sysid**: `udp-peer` can learn multiple vehicle endpoints on one port and send target-specific traffic back to the right sysid.
- **Swarm helpers**: discover active systems from HEARTBEAT, maintain named groups, fan out commands per vehicle, convert local meter offsets to global targets, and aggregate ACK results.
- **MAVLink 2 signing**: sign outbound packets and verify/require inbound signatures using the protocol library's signing primitives.
- **Importable examples**: example flows cover common connection, message, command, mission, parameter, telemetry, raw/debug, swarm, and safety-gated workflows.

## Nodes

### `mavlink-ai-profile`

Config node for MAVLink identity and protocol defaults.

Use profiles to define:

- dialect: bundled or custom XML
- MAVLink version: v1, v2, or auto
- source system/component ID
- default target system/component ID
- vehicle/profile type: GCS, copter, plane, rover, boat, sub, tracker, generic
- firmware: generic, ArduPilot, PX4, custom
- mission defaults: mission type and preferred item format
- heartbeat identity
- MAVLink 2 signing options

Profiles do not own sockets. They describe how messages should be interpreted and built.

### `mavlink-ai-connection`

Config node for transport, decode, routing, subscriptions, queueing, heartbeat, and runtime state.

Connection options include:

- UDP in/out/peer
- TCP client/server
- Serial, when `serialport` is installed
- heartbeat enable/interval
- single-profile or routed mode
- accepted sysids/compids
- route table for sysid/compid to profile mapping
- unmatched packet policy
- outbound queue settings

The connection is the shared wire/runtime object. Multiple tabs and flow nodes can reference the same connection without using hidden global state.

### `mavlink-ai-in`

Subscribes to decoded MAVLink messages from a connection.

Features:

- filter by message name
- filter by sysid/compid
- optional raw output
- optional diagnostics/errors output
- rate limiting
- changed-only output
- decoded message contract:

```js
{
  topic: "mavlink/HEARTBEAT",
  payload: {
    name,
    id,
    sysid,
    compid,
    profile,
    fields,
    raw,
    transport,
    receivedAt
  }
}
```

### `mavlink-ai-out`

Sends normalized outbound messages or raw MAVLink buffers through a connection.

Normal use:

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

Raw buffers can be sent with `topic: "mavlink/raw"`, but raw sends are intentionally not signed or normalized.

### `mavlink-ai-build`

Builds a normalized outbound MAVLink message without sending it.

Use this for raw/advanced message construction, custom dialect messages, protocol debugging, or exact wire-level control.

Features:

- dynamic field form from selected profile/dialect
- visible message and field help
- enum dropdowns where metadata exists
- snake_case/camelCase field normalization
- clear warnings when using low-level command transport messages (`COMMAND_LONG`, `COMMAND_INT`) instead of the command node

Output goes to `mavlink-ai-out`.

### `mavlink-ai-command`

Friendly command builder for normal vehicle commands.

Presets are grouped by workflow:

```text
Basic Flight
  Arm
  Disarm
  Set Mode
  Takeoff
  Land
  RTL

Guided / Autonomy
  Go To / Reposition
  Change Speed
  Condition Yaw
  Spin / Rotate

Mission
  Mission Start
  Pause Mission
  Resume Mission

Camera
  Take Photo
  Start Video Recording
  Stop Video Recording

Telemetry / System
  Request Message
  Set Message Interval
  Stop Message Interval
  Reboot Autopilot

Advanced / Raw MAV_CMD
  MAV_CMD_...
```

Features:

- friendly preset-specific fields
- profile-aware flight-mode names for ArduPilot and PX4
- `COMMAND_LONG` and `COMMAND_INT` support
- lat/lon float degrees converted to degE7 for `COMMAND_INT`
- optional await-ACK mode with timeout/retry handling
- readable `MAV_RESULT_*` names in ACK/error output
- raw `MAV_CMD_*` escape hatch with visible parameter help

### `mavlink-ai-mission`

Runs mission download, upload, and clear workflows.

The mission node handles the MAVLink mission protocol state machine so flows do not have to hand-wire every `MISSION_*` message.

Supported actions:

- `download`
- `upload`
- `clear`

Upload example:

```js
msg.payload = {
  action: "upload",
  target_system: 1,
  target_component: 1,
  items: [
    {
      lat: 37.7749,
      lon: -122.4194,
      alt: 50,
      command: "MAV_CMD_NAV_TAKEOFF",
      param1: 15
    },
    {
      lat: 37.7750,
      lon: -122.4195,
      alt: 100,
      command: "MAV_CMD_NAV_WAYPOINT",
      param1: 5,
      param2: 10
    },
    {
      lat: 37.7751,
      lon: -122.4196,
      alt: 0,
      command: "MAV_CMD_NAV_LAND"
    }
  ]
};
```

Mission output convention:

- **Output 1**: final result, such as `mission/downloaded`, `mission/uploaded`, or `mission/cleared`
- **Output 2**: progress events, such as waiting for count, requesting item, sending item, waiting for ACK
- **Output 3**: structured errors/timeouts

Notes:

- `lat`/`lon` are float degrees.
- For `MISSION_ITEM_INT`, coordinates are converted to degE7 automatically.
- Raw `x`/`y` values are accepted for advanced callers and take precedence over `lat`/`lon`.
- `target_system`, `target_component`, and `mission_type` can be set per message.
- Mission operations are locked per connection/profile/mission type to avoid overlapping workflow corruption.

### `mavlink-ai-param`

Runs parameter protocol workflows.

Supported actions:

- read one parameter
- set one parameter
- request the full parameter list

Examples:

```js
// Read one
msg.payload = {
  action: "read",
  param_id: "ARMING_CHECK"
};
```

```js
// Set one
msg.payload = {
  action: "set",
  param_id: "ARMING_CHECK",
  param_value: 1,
  param_type: "MAV_PARAM_TYPE_INT32"
};
```

```js
// List all
msg.payload = {
  action: "list"
};
```

Features:

- timeout/retry handling
- progress output for full-list reads
- case-insensitive parameter ID matching
- float32-aware applied checks
- PX4 byte-union integer parameter handling
- structured errors

### `mavlink-ai-filter`

Filters decoded MAVLink messages in a flow.

Features:

- filter by message name
- filter by sysid/compid
- rate limit per message/sysid/compid
- changed-only filtering
- useful after `mavlink-ai-in` or any decoded MAVLink stream

### `mavlink-ai-swarm`

Maintains a registry of active MAVLink systems from HEARTBEAT and telemetry.

Tracks:

- sysid/compid
- vehicle type
- autopilot
- last seen time
- stale/expired state
- armed state
- mode
- system status
- global/local position
- battery summary where available

Named groups can be static or type-based:

```json
{
  "scouts": [1, 2],
  "all-copters": { "type": "MAV_TYPE_QUADROTOR" }
}
```

### `mavlink-ai-fanout`

Expands one logical command into one message per target vehicle.

Use fan-out when every target needs its own `target_system`, position, offset, or parameter set. Use broadcast only when one identical `target_system: 0` message is truly intended for all systems.

Features:

- target list from explicit sysids, per-target objects, or swarm registry output
- dry-run mode
- optional command pacing
- optional await-ACK aggregation
- stop-on-first-error or continue-on-error behavior
- local meter offsets converted to global lat/lon/alt
- clear output separation for accepted, failed, timedOut, skipped, and per-target results

Example fan-out concept:

```js
msg.payload = {
  command: "go_to",
  origin: { lat: 39.1, lon: -75.1, alt: 40 },
  targets: [
    { sysid: 1, north: 0, east: 0, up: 0 },
    { sysid: 2, north: 0, east: 10, up: 0 },
    { sysid: 3, north: 0, east: -10, up: 0 }
  ]
};
```

## Connection examples

### UDP peer for SITL or common GCS-style links

```text
Profile: ardupilotmega, source sysid 255 / compid 190
Connection: udp-peer, bind 0.0.0.0:14550
SITL/vehicle sends to: udp:127.0.0.1:14550
```

Flow:

```text
[mavlink-ai-in] -> [debug]
[mavlink-ai-command] -> [mavlink-ai-out]
```

### One UDP port, multiple vehicles

Use routed mode on the connection and map sysid/compid to profiles. `udp-peer` learns peer endpoints per sysid from inbound MAVLink frames, so target-specific command, mission, and param traffic can go back to the vehicle that owns the addressed `target_system`.

### Serial

`serialport` is optional. UDP/TCP users do not need it. To enable serial in an environment where the optional dependency was skipped:

```bash
cd ~/.node-red
npm install serialport
```

Then configure the connection as serial and select the port/baud settings.

## Custom dialects

Dialect support includes:

- bundled dialects from the runtime mappings package
- custom local XML dialect files
- custom Docker-mounted XML dialect files

A custom XML profile:

```text
Dialect source: custom/local path
Custom dialect path: /data/mavlink/dialects/my_vehicle.xml
```

The loader:

1. reads the root XML
2. resolves local `<include>` files in dependency-first order
3. compiles messages/enums/CRC extras into runtime classes
4. builds the same dialect bundle shape used by bundled dialects
5. fails loudly with structured errors if anything is invalid

It does not fetch remote XML includes at runtime and does not fall back to `common` on failure.

## MAVLink 2 signing

Signing is configured on the profile.

Options:

- Sign outbound packets
- Verify inbound signed packets
- Require signatures for inbound packets
- Link ID
- Passphrase credential

The passphrase is stored as a Node-RED credential and is not exported in flow JSON.

Raw `sendRaw` buffers are sent unchanged and are not signed.

Important limitation: verification checks signature authenticity only. Replay protection is not implemented.

## Installation

From npm:

```bash
cd ~/.node-red
npm install node-red-contrib-mavlink-ai
node-red-restart
```

From source:

```bash
cd ~/.node-red
git clone https://github.com/cmc0619/node-red-contrib-mavlink-ai.git
npm install ./node-red-contrib-mavlink-ai
node-red-restart
```

## Quick start

1. Add a **MAVLink AI In** node.
2. Create a **MAVLink AI Profile**.
   - For ArduPilot, start with `ardupilotmega`.
   - For common MAVLink-only traffic, `common` is fine.
   - Leave source ID as the default GCS-style `255/190` unless you know otherwise.
3. Create a **MAVLink AI Connection**.
   - Use `udp-peer`.
   - Bind to `0.0.0.0:14550`.
   - Enable heartbeat if this node should act like a lightweight GCS.
4. Point SITL or the vehicle at the Node-RED host/port.
5. Deploy and watch HEARTBEAT messages in Debug.
6. Add a **MAVLink AI Command** node for Arm, Set Mode, Takeoff, Request Message, or Set Message Interval.
7. Wire the command node to **MAVLink AI Out**.

## Example flows

Importable examples live in [`examples/`](examples/). They are intended to be readable starting points, not opaque demos.

Typical examples include:

- UDP receive/decode
- serial connection
- dynamic message building
- command presets
- mission download/upload
- parameter read/set/list
- telemetry rate requests
- raw packet debugging
- swarm registry and fan-out dry-run
- safety-gated calibration/parachute examples
- camera/gimbal/ROI examples

Safety-sensitive examples should be debug-wired or dry-run by default until deliberately connected to a real vehicle.

## Message contracts

Decoded messages:

```js
{
  topic: "mavlink/HEARTBEAT",
  payload: {
    name: "HEARTBEAT",
    id: 0,
    sysid: 1,
    compid: 1,
    profile: "copter",
    fields: {
      type: "MAV_TYPE_QUADROTOR",
      autopilot: "MAV_AUTOPILOT_ARDUPILOTMEGA"
    },
    raw: {
      magic,
      seq,
      incompat_flags,
      compat_flags
    },
    transport,
    receivedAt
  }
}
```

Outbound normalized message:

```js
{
  topic: "mavlink/send",
  payload: {
    name: "COMMAND_LONG",
    target_system: 1,
    target_component: 1,
    fields: {
      command: "MAV_CMD_COMPONENT_ARM_DISARM",
      param1: 1
    }
  }
}
```

Enum names are accepted where the selected dialect can resolve them. Numeric values remain accepted for advanced/raw use.

## Architecture

```text
nodes/   Node-RED node registration + editor HTML
lib/
  dialects/   bundled dialects, custom XML compiler, metadata
  protocol/   codec, normalizer, enum resolver, validator
  transport/  UDP / TCP / serial
  routing/    route table and packet router
  runtime/    subscriptions, outbound queue, lock manager
  command/    command presets and COMMAND_ACK workflow
  mission/    mission state machines
  param/      parameter workflows
  swarm/      registry, fanout, coordinate helpers
  util/       status, errors, validation helpers
```

Design rule:

```text
Profile    = identity and protocol defaults
Connection = transport and shared runtime state
Route      = sysid/compid to profile mapping
Node       = visible flow behavior
```

Node files should stay thin. Runtime behavior belongs in `lib/`. There should be no global parser, dialect, connection, or vehicle state.

## Dependencies

Required:

- `node-mavlink` — MAVLink parser/serializer and protocol primitives
- `mavlink-mappings` — bundled dialect mappings
- `mavlink-mappings-gen` — custom XML compilation support
- `xml2js` — XML parsing for custom dialects

Optional:

- `serialport` — only required for serial connections

## Tests

```bash
npm test
npm run test:unit
npm run test:integration
```

The default test run includes smoke-load, unit tests, and integration tests.

## Known review items

This file is intended to be read critically before replacing `README.md`.

Open follow-up issues currently track known rough edges and parity improvements, including stricter validation, Aigen-compatible mission input aliases, mission request-type response matching, mission timeout/default UX, and mission clear ACK handling.

## License

MIT

## Support

- Issues: https://github.com/cmc0619/node-red-contrib-mavlink-ai/issues
- MAVLink protocol: https://mavlink.io/
- ArduPilot: https://ardupilot.org/
- PX4: https://px4.io/
