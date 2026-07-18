# MAVLink AI Design

> **Read this together with [`RELEASE_SCOPE.md`](RELEASE_SCOPE.md).** `DESIGN.md`
> describes the core architecture and design principles; `RELEASE_SCOPE.md`
> captures current 1.0 scope decisions, deferrals, and refinements. Read both
> before making architectural or release-target changes.

> **v3 architecture reset (issue #228).** The single combined profile was split
> into three explicit concerns — **Local Identity**, **Vehicle Profile**, and
> **Connection**. [Section 5.5](#55-architecture-local-identity-vehicle-profile-connection-228)
> is the authoritative description of that split; the rest of this document is
> written to the same model (#279).

## 1. Purpose

`node-red-contrib-mavlink-ai` is a second-generation Node-RED MAVLink module.

This repo exists because the first-generation shape naturally drifted toward a coupled design: comms nodes started owning transport, dialect, message parsing, mission behavior, and user workflow assumptions. That works for a quick proof of concept, but it becomes brittle as soon as more than one vehicle, one dialect, one transport, or one flow tab is involved.

v2 is a clean architecture reset.

The module should be a MAVLink protocol layer for Node-RED, not merely a serial/UDP node with MAVLink features glued onto it.

The core design rule is:

```text
Local Identity  = who Node-RED transmits as (source ids, heartbeat identity)
Vehicle Profile = the target vehicle: dialect, firmware, family, defaults
Connection      = transport/session/resource owner (incl. signing)
Route           = sysid/compid mapping to Vehicle Profile
Nodes           = visible Node-RED behavior
```

Or more bluntly:

```text
Local Identity = who we are on the link.
Vehicle Profile = what the vehicle we talk to means.
Connection = how we talk to it.
Route = which packet belongs to which vehicle.
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
mavlink-ai-local-identity
mavlink-ai-vehicle
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
MAVLink AI Local Identity
MAVLink AI Vehicle Profile
MAVLink AI Connection
MAVLink AI In
MAVLink AI Out
MAVLink AI Build
MAVLink AI Filter
MAVLink AI Command
MAVLink AI Mission
```

(The lists above are the founding set; the shipped palette has since grown —
`package.json`'s `node-red.nodes` map is the authoritative roster.)

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

This module should use three config-node layers:

```text
mavlink-ai-local-identity
mavlink-ai-vehicle
mavlink-ai-connection
```

Every connection requires exactly one default Local Identity (5.5.2). A Local
Identity and a Vehicle Profile can each be reused by one or more connections.

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
Local Identity node: owns who Node-RED transmits as.
Vehicle Profile node: owns the target vehicle's dialect/defaults.
Connection node: owns transport/session (and signing).
Regular nodes: build, filter, receive, send, command, mission.
```

## 5.5. Architecture: Local Identity, Vehicle Profile, Connection (#228)

The original `mavlink-ai-profile` owned two incompatible questions at once —
*"who is Node-RED?"* and *"what vehicle is Node-RED talking to?"*. Selecting
**GCS** gave a truthful local heartbeat but lost Copter/Plane/Rover target
metadata; selecting **Copter** gave the target metadata but made Node-RED
falsely advertise itself as another quadrotor. v3 splits the profile into three
config nodes so each question has one owner.

### 5.5.1 Ownership table

| Concern | Config node | Owns |
| --- | --- | --- |
| Who Node-RED **is** on the wire | `mavlink-ai-local-identity` | source SysID/CompID, role preset (GCS / companion / custom), HEARTBEAT identity (`MAV_TYPE`, autopilot, base_mode/status defaults) |
| What vehicle is **addressed** | `mavlink-ai-vehicle` (Vehicle Profile) | dialect, firmware, MAVLink version preference, default target SysID/CompID, vehicle family (mode tables + parameter metadata), mission preferences |
| How traffic **moves** and is **secured** | `mavlink-ai-connection` | transport/session, routing, outbound queue, mission locks, heartbeat scheduling, **signing credential + sign/verify/require policy + link id**, and all per-link channel state (sequence numbers, monotonic signing timestamps, inbound replay memory, detected peer wire versions) |

A Vehicle Profile must **never** determine or change the local source identity.
A Connection must **never** silently choose among multiple identities. Signing —
the shared key, the sign/verify/require policy, the **link id**, the sequence
counter, the signing timestamp, and replay state — is all a property of the
secured link and belongs to the Connection/`LinkState`, not the identity or the
dialect codec (this satisfies #192).

### 5.5.2 Config-node relationship

```text
mavlink-ai-local-identity        mavlink-ai-vehicle (Vehicle Profile)
   (source ids, heartbeat            (dialect, targets, vehicle family,
    identity)                         firmware, mission prefs)
          \                                   /
           \                                 /
            \                               /
             v                             v
             mavlink-ai-connection  (transport + channel state)
             ├── default Local Identity   (required, exactly one)
             ├── additional identities    (advanced, opt-in, disabled by default)
             ├── signing key + policy + link id   (5.5.8)
             └── LinkState: seq / signing-ts / replay / detected-version
```

Many Connections may reuse one Local Identity. Multiple Local Identity config
nodes may coexist without error — merely having more than one is not a problem.

### 5.5.3 Runtime composition

Encoding an outbound frame composes three independently resolved inputs:

```text
Vehicle Profile  -> dialect, message definitions, target defaults
Local Identity   -> source ids, role, heartbeat fields
Connection       -> transport, queue, signing key/policy/link id, channel state
```

Codecs are cached per Vehicle Profile (dialect) and are otherwise stateless:
`encode()` receives the sender's `sysid`/`compid`, the connection's `LinkState`,
and an optional signing context per call. That is what lets several local
identities transmit through one connection — each with its own correct
sequence/signing stream — and lets a profile edit rebuild a codec without
resetting any channel state.

### 5.5.4 Normal single-identity flow

The beginner path has one Local Identity and one default identity per
Connection:

```text
Connection editor
  Vehicle:   [SITL Copter]          (Vehicle Profile)
  Identity:  [Node-RED GCS]         (Local Identity, required)
  Heartbeat: [x]  Interval: [1000 ms]
```

Every node inheriting this connection transmits as `Node-RED GCS`; no node needs
an identity selector.

### 5.5.5 Advanced dual GCS + companion flow

One runtime — even one physical link — may deliberately act as more than one
MAVLink participant. This is explicit ("hold my beer"), never stumbled into:

```text
Connection > Advanced
  [x] Allow this connection to transmit as multiple local identities
  Additional identity: Companion 1/191   Outbound: yes  Heartbeat: yes  1000 ms
```

A message then selects the non-default identity with
`msg.payload.localIdentity`. GCS `255/190` and companion `1/191` share one UDP
or serial link, each with its own source identity, sequence stream, and (opt-in)
heartbeat.

### 5.5.6 Outbound identity-resolution algorithm

Every transmitted message resolves to **exactly one permitted Local Identity**:

1. If the message explicitly requests `localIdentity`, resolve that identity
   (by config-node id).
2. Verify the resolved identity is attached to the Connection — its default, or
   an additional binding with outbound permission while multi-identity is
   enabled.
3. Otherwise use the Connection's required default Local Identity.
4. **Never** derive the local identity from `vehicleProfile`.
5. **Never** fall back from an invalid explicit identity request to the default.

Editor validation improves the experience, but runtime validation is
authoritative, so imported/edited flow JSON cannot bypass these rules.

### 5.5.7 Heartbeat ownership

Heartbeat *identity* (the `MAV_TYPE` and autopilot fields) is owned by the Local
Identity; *whether and how often* to send is owned by the Connection. The
default identity's heartbeat comes from the connection's Heartbeat toggle; each
additional identity opts into its own heartbeat per binding (disabled by
default). Heartbeat queue-coalescing is keyed per identity
(`heartbeat:<identity id>`) so one identity's heartbeat can never replace
another's queued heartbeat.

### 5.5.8 Signing and channel-state ownership (#192)

The Connection owns MAVLink 2 signing in full: the shared secret (a passphrase
credential), the sign/verify/require policy, and the signing **link id**. A
MAVLink link has exactly one signing key shared by both endpoints, so it is a
property of the secured link — not of an identity that may transmit on several
links. Every identity that transmits on a connection signs with the connection's
key, and one identity can therefore talk signed on one connection and unsigned
on another (a GCS to a mix of secured and open fleets). The Connection also owns
the `LinkState`, which keys:

- outbound **sequence** numbers by `(local sysid, local compid)`;
- monotonic outbound signing **timestamps** by `(local sysid, local compid, link id)`;
- inbound **replay** memory by verification key (so a profile/identity rebuild
  under the same key never resets it);
- detected peer **wire versions** by peer sysid.

`LinkState` lives exactly as long as the transport/session — it survives profile
and identity edits and is reset only on deactivation.

### 5.5.9 Error codes (fail closed)

| Code | When |
| --- | --- |
| `LOCAL_IDENTITY_REQUIRED` | a Connection has no default Local Identity |
| `LOCAL_IDENTITY_INVALID` | the default identity's configuration is invalid |
| `LOCAL_IDENTITY_UNRESOLVED` | an explicit identity reference matches no config node |
| `LOCAL_IDENTITY_NOT_ATTACHED` | the requested identity is not the default and not an allowed additional binding |
| `LOCAL_IDENTITY_COLLISION` | two attached identities share a source `(sysid, compid)` — indistinguishable on the wire |
| `MULTI_IDENTITY_DISABLED` | a non-default identity was requested but multi-identity transmission is off |

Missing, unattached, and disabled cases all fail closed — a bad configuration
never transmits with a guessed identity.

### 5.5.10 ADR: why not a global singleton Local Identity

> One Local Identity is the normal case, but MAVLink permits one runtime/link to
> host multiple logical participants (a GCS and an onboard companion on one
> link). Enforcing a single global identity would remove a legitimate power-user
> capability the runtime already supported. Safety instead comes from explicit
> per-Connection bindings and unambiguous, fail-closed resolution — not from
> forbidding the capability.

## 6. Vehicle Profile Config Node

The Vehicle Profile config node (`mavlink-ai-vehicle`) describes the ADDRESSED
vehicle: its dialect, firmware, MAVLink version preference, target ids,
vehicle family, and mission preferences. Source identity and heartbeat
identity live on `mavlink-ai-local-identity`; signing lives on the Connection
([section 5.5](#55-architecture-local-identity-vehicle-profile-connection-228)).

It does **not** own sockets, serial ports, TCP listeners, UDP ports, mission locks, timers, or peer state.

Type:

```text
mavlink-ai-vehicle
```

Responsibilities:

```text
- Profile name.
- Vehicle family (for mode tables / parameter metadata).
- Dialect selection.
- MAVLink version preference.
- Default target system.
- Default target component.
- Preferred mission item message type.
- Protocol/debug preferences.

Source ids and heartbeat identity are NOT here: they belong to the Local
Identity config node (5.5.1), and signing to the Connection (5.5.8).
```

Suggested fields:

```text
Name
Vehicle family: generic | copter | plane | rover | boat | sub | antenna-tracker
Dialect: ardupilotmega | common | minimal | custom
Custom dialect path
MAVLink version: auto | v1 | v2
Default target system
Default target component
Preferred mission item type: MISSION_ITEM_INT | MISSION_ITEM
Protocol debug enabled
```

Default profile values:

```text
Vehicle family: generic
Dialect: ardupilotmega
MAVLink version: auto
Default target system: 1
Default target component: 1
Preferred mission item type: MISSION_ITEM_INT
```

The defaults should make the module useful against a single ArduPilot-style
vehicle first. The GCS-side identity defaults (sysid 255 / compid 190,
MAV_TYPE_GCS heartbeat) live on the Local Identity node.

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
- vehicle family: copter
- dialect: ardupilotmega
- default target system: 1
- preferred mission item type: MISSION_ITEM_INT

Rover Profile
- vehicle family: rover
- dialect: ardupilotmega
- default target system: 2
- preferred mission item type: MISSION_ITEM_INT

Plane Profile
- vehicle family: plane
- dialect: ardupilotmega
- default target system: 3
- preferred mission item type: MISSION_ITEM_INT
```

The dialect defines the message dictionary. The Vehicle Profile defines what the ADDRESSED vehicle means to this runtime: its family (for mode tables and parameter metadata), firmware conventions, and target defaults.

Who Node-RED itself is on the wire is a different question with a different owner: the Local Identity config node (5.5.1) carries the source SysID/CompID and the HEARTBEAT identity, with role presets for GCS (`MAV_TYPE_GCS`, sysid 255 / compid 190) and companion computer (`MAV_TYPE_ONBOARD_CONTROLLER`, compid 191 / `MAV_COMP_ID_ONBOARD_COMPUTER`, sharing the vehicle's system id). The same Vehicle Profile works unchanged whether Node-RED speaks as a GCS or as an onboard companion — identity never leaks into the target description.

## 8. Connection Config Node

> **v3 (#228):** in addition to transport/session state, the connection now
> requires exactly one **default Local Identity**, owns the signing **link id**,
> and owns all per-link channel state via `LinkState` (sequence, signing
> timestamps, replay, detected versions). Additional local identities transmit
> only through an explicit, disabled-by-default binding list. See
> [section 5.5](#55-architecture-local-identity-vehicle-profile-connection-228).

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

A route whose profile config-node id cannot be resolved rejects its packets and
reports the misconfiguration loudly (at deploy time and once per packet
identity) — it must never silently fall back to the default profile, which
would decode, signature-check, and label the packet with the wrong dialect.

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
[mavlink-ai-vehicle: Copter]
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
[mavlink-ai-vehicle: Copter] <--- route 1:*
[mavlink-ai-vehicle: Rover]  <--- route 2:*
[mavlink-ai-vehicle: Plane]  <--- route 3:*

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
connection.resolveProfile(id) // throws PROFILE_UNRESOLVED
connection.acquireLock(lockName, owner, options)
connection.releaseLock(lockName, owner)
connection.getVehicleCapabilities(sysid, compid) // cached AUTOPILOT_VERSION bits (#233)
connection.requestVehicleCapabilities(opts) // fire-and-forget probe, once per identity
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
    connection: "Copter UDP",
    connection_id: "a1b2c3d4e5f6a7b8",
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

**Connection identity (#240).** `connection_id` is the canonical Connection
config-node id (with `connection` as its display name). It is the stable
identity per-link state keys on: a Profile can be reused by several
Connections, so `profile_id` cannot disambiguate links, and reusing common
wire identities (vehicle sysid 1/compid 1) across separate links is normal.
The Filter node and the subscription registry include it in their rate-limit
and changed-only keys so two links carrying the same identity never suppress
each other; rejected and decode-error payloads carry the same identity, and a
message without one (not produced by this package) falls back to a shared
legacy bucket.

**Per-message endpoint (#239).** `transport.remoteAddress` / `remotePort` name
the actual source of the transport read that carried *this* packet — the UDP
datagram's sender, or the tcp-server client socket (which additionally stamps
its per-client `clientId`) — not the connection's configured or fallback
remote, so on a multi-peer link every decoded message says which endpoint sent
it. The remaining `transport` fields (`name`, `type`, bind/remote config)
describe the connection-wide link. The same context rides on rejected and
decode-error diagnostics. Serial has no network endpoint, so these fields are
absent there. Attribution rule: a packet belongs to the read that *completed*
its frame — frames concatenated in one read share that read's endpoint, and a
frame split across reads (abnormal for UDP, routine for TCP) reports the
completing read's. Framing state is keyed per stream (per tcp-server client,
per UDP source endpoint, one shared stream for serial/tcp-client), so the
completing read is by construction from the same endpoint that started the
frame — one peer's partial or phantom bytes can never buffer onto another
peer's datagram, and a frame recovered by the splitter's resync always carries
its own sender's endpoint.

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

**Non-finite float fields.** MAVLink `float` / `double` fields legitimately
carry the non-finite IEEE-754 values — `NaN` is the protocol's "ignore this
field" sentinel on setpoint, gimbal-rate and similar messages, and `±Infinity`
can appear as an out-of-range marker. `JSON.stringify` turns all of these into
`null`, which loses the sentinel and collapses `NaN`, `Infinity` and
`-Infinity` (and a genuine `null`) into one indistinguishable value. For the
same reasons as the 64-bit fields, the decoded payload represents them as the
strings `"NaN"`, `"Infinity"`, and `"-Infinity"` — e.g. `afx: "NaN"`. This
survives `JSON.stringify()`, keeps the three values distinct for changed-only
comparison, and feeds back losslessly into an outbound message: the builder
accepts those strings (case-insensitively, plus the `inf` abbreviation) on
`float`/`double` fields. Finite values remain plain numbers.

### 14.2 Outbound MAVLink Message

```js
{
  topic: "mavlink/send",
  payload: {
    name: "COMMAND_LONG",
    vehicleProfile: "copter-profile-id",  // which vehicle/dialect (config-node id)
    localIdentity: "",                     // optional: transmit as a non-default identity
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

> The target-facing reference is `vehicleProfile` (config-node id).
> `localIdentity` is an optional override that selects an *attached* Local
> Identity; omitted, the message transmits as the connection's default identity.
> The Vehicle Profile never determines the local identity.

### 14.3 Raw Message

```js
{
  topic: "mavlink/raw",
  payload: Buffer
}
```

### 14.4 Status

Connection state (`connecting`, `connected`, `listening`, `reconnecting`,
`error`, `closed`) is surfaced two ways, both driven by the same structured
payload — never as a MAVLink frame:

- a **Node-RED status badge** under the In/Out/Formation/Swarm nodes attached
  to the connection (the coloured dot: green connected, yellow waiting, red
  error);
- an internal **`status` event** on the connection carrying that payload, which
  those nodes subscribe to in order to drive their badge.

```js
{
  node: "mavlink-ai-connection",
  connection: "Copter UDP 14550",
  state: "connected",
  transport: "udp-peer",
  timestamp: 1782849600000,
  detail: "Listening on 0.0.0.0:14550"
}
```

Status is **not** emitted as a `mavlink/status` flow message. Node-RED is a
GCS or a companion, and in neither role can a ground-side flow usefully react
to a link change: as a GCS the flight controller owns link-loss behaviour (its
GCS failsafe flies RTL, and a dropped link can't carry a command anyway); as a
companion the on-airframe link doesn't meaningfully drop. Link-loss is the
flight controller's job, so connection state is observed via the badge/event
above, and a failed send still surfaces as `mavlink/error` (§14.5) — which
*is* a flow message, because an operational failure is actionable in a flow.

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

> **v3 (#192, #228):** the codec is dialect-scoped only. Source identity,
> sequence numbers, signing timestamps, replay memory, and detected peer wire
> versions are **not** codec state — they live in the connection-owned
> `LinkState` (`lib/protocol/link-state.js`) and are passed to `encode()` per
> call. Inbound signature verification is the pure module function
> `verifyInboundPacket(packet, policy)`. This is what keeps one logical
> `(sysid, compid, link id)` stream correct across routed profiles and codec
> rebuilds. See [section 5.5.8](#558-signing-and-channel-state-ownership-192).

Protocol code should be isolated behind a wrapper.

Suggested files:

```text
lib/protocol/mavlink-codec.js
lib/protocol/link-state.js
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

**Field-scoped enum resolution (#153).** The XML declares which enum backs each
field; the compiled `mavlink-mappings` JS drops that association, but the
package's shipped `.d.ts` declarations retain it as the property types of each
message class, and the runtime XML compiler reads the `enum=` attribute
directly. Encode-time name resolution uses that association: on a field with a
declared enum, a name resolves against that enum only (a member of an
unrelated enum fails with the expected enum named — it used to resolve
globally, so `HEARTBEAT.type: 'MAV_STATE_ACTIVE'` silently encoded MavState 4
as a MavType), and the command workflow resolves command names against MavCmd
only. Fields with no declared enum — COMMAND_LONG's generic params
legitimately receive mode/flag members — keep global resolution, as does any
dialect whose association metadata is unavailable. Numbers and numeric strings
always pass through, so raw and dialect-external ids stay usable.

**Splitter resync (#153).** node-mavlink's stock packet splitter skips the
full header-declared length of a frame whose msgid has no CRC-extra entry —
trusting a length byte it could not validate, so a false magic byte in line
noise could claim up to 280 bytes and swallow every real frame in that window.
The codec's splitter subclass treats unvalidatable data like a CRC failure:
advance one byte and rescan (the MAVLink C library / pymavlink strategy). A
genuinely-unknown message costs a bounded byte-wise rescan of its own payload;
real traffic never pays it, because the connection's merged CRC table covers
every message id any routed profile can decode.

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

Peer learning trust boundary (#85, #239): receiving a datagram commits
nothing. The transport commits an endpoint (fallback peer / per-sysid mapping)
only when the connection confirms it after the packet passes CRC/framing,
route acceptance, and the signature policy — and the endpoint committed is the
source of the datagram that carried that validated packet, delivered
per-read through the decoder rather than looked up from a mutable
latest-claimant table, so a forged datagram racing a genuine one can never be
the endpoint promoted.

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
  sysids: [1],        // empty/absent = accept all systems
  compids: [],        // empty/absent = accept all components
  profile: "Copter",
  rateLimitHz: 5,
  changedOnly: false
}
```

Id filters are plural arrays and fail closed (#280): any supplied entry that
is not an integer MAVLink id (0-255) throws `BAD_FILTER` at subscribe time
rather than being dropped — a malformed list must never silently widen into
an accept-everything wildcard.

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

Strict priority alone is unsafe for the background band. Sustained priority ≤2 traffic at/above the drain rate would park priority-3 heartbeats indefinitely, and the 1 Hz heartbeat tick keeps enqueuing more — the vehicle's GCS-loss failsafe can trip while "normal" traffic flows (#150). Two fairness mechanisms guard band 3:

- **Age promotion.** A queued item's *effective* priority improves by one band per `agePromotionMs` (default 2000) it has waited; effective-priority ties break in favor of the older item. A parked heartbeat therefore ages up to the flood's band, becomes the oldest item in it, and drains ahead — bounding its worst-case wait instead of allowing indefinite starvation. Promotion is clamped one band above emergency: an item already in band 0 stays there, and a non-emergency item (band ≥1) never ages below band 1 no matter how long it waits. This keeps the emergency band inviolate — an arm/mode/emergency send always cuts through a backlog rather than queueing behind a stale normal/background item that merely aged (the age tie-break means a same-band clamp would not suffice; the floor must sit strictly above band 0).
- **Drop-superseded coalescing.** Enqueuing with a `coalesceKey` drops any still-queued (not in-flight) item sharing that key, resolving it (the newer send carries the same intent). The heartbeat tick uses `coalesceKey: 'heartbeat'` so at most one heartbeat is ever queued behind a slow transport rather than a growing backlog of stale copies.

### 21.1 Send-priority policy (#241)

Every producer assigns its band explicitly from `lib/runtime/send-priority.js` — the queue default is never relied on implicitly:

```text
CRITICAL (0)    only the listed MAV_CMDs, matched by resolved numeric id (never
                guessed from arbitrary messages): COMPONENT_ARM_DISARM (400),
                DO_SET_MODE (176), DO_FLIGHTTERMINATION (185), DO_PARACHUTE (208).
                Assigned by the command workflow (command/payload/fan-out
                await-ack paths, retransmits included), the payload node's
                direct sends, and stamped as msg.priority on the command node's
                build-only output for the Out node to forward.
ELEVATED (1)    Move setpoints (one-shot and streamed): their cadence keeps
                OFFBOARD/GUIDED alive, so they must not sit behind bulk traffic.
                Also the age-promotion floor, so nothing non-critical starves.
NORMAL (2)      mission and param protocol traffic, payload camera/gimbal verbs,
                non-critical commands.
BACKGROUND (3)  periodic heartbeats, coalesced per identity.
```

The Out node honors an advanced explicit override — `msg.priority`, truncated to an integer and clamped to [0, 3]; absent or non-numeric means the queue default — so a flow-authored kill switch can claim the critical band without the policy guessing. Queue priority cannot rescue an already-blocked transport write; the per-write completion deadline (#237, §17) is the guard on that side.

## 22. Heartbeat Design

> **v3 (#228):** heartbeat *identity* (the `MAV_TYPE`/autopilot fields) is owned
> by the Local Identity; *whether/how often* to send stays connection-owned. The
> connection's Heartbeat toggle drives the default identity's heartbeat; each
> additional identity opts into its own heartbeat per binding. Coalescing is
> keyed per identity so one identity's heartbeat never replaces another's.

Heartbeat is both simple and surprisingly easy to place badly.

Two possible designs:

```text
Option A: heartbeat is a setting on mavlink-ai-connection.
Option B: mavlink-ai-heartbeat visible node generates HEARTBEAT messages.
```

v2 should start with Option A:

```text
Connection can send heartbeat using the Local Identity's values.
```

A visible heartbeat node can be added later if flow-level heartbeat control becomes important.

Heartbeat settings split between the Local Identity and the connection (5.5.7):

```text
Local Identity: heartbeat identity values (MAV_TYPE, autopilot, base defaults).
Connection: whether to send heartbeat and interval (per attached identity).
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

Good status (the structured payload behind the node badge / `status` event —
see §14.4; not a flow message):

```js
{
  node: "mavlink-ai-connection",
  connection: "Copter UDP 14550",
  state: "connected",
  transport: "udp-peer",
  detail: "Listening on 0.0.0.0:14550"
}
```

Good error:

```js
{
  topic: "mavlink/error",
  payload: {
    node: "mavlink-ai-vehicle",
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
  mavlink-ai-vehicle.js
  mavlink-ai-vehicle.html
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

JSDoc (`/** ... */`) is the project's **documentation** format: use it for what a reader needs in order to *use* or safely change code — declarations and behavior worth documenting (see the list below). It should read as a contract, using the applicable tags rather than prose alone.

Ordinary `//` line comments are fine for short inline notes that explain *why* a specific line is the way it is — the margin notes that don't belong in a declaration's doc block (e.g. `value >>> 0; // JS bitwise is signed 32-bit`). Prefer capturing durable rationale in the enclosing declaration's JSDoc; reach for an inline `//` when the note is genuinely local to one statement. This matches normal JavaScript convention and the greenfield spec §3.1; there is no blanket ban on `//`.

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
2. mavlink-ai-vehicle config node
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
mavlink-ai-vehicle owns dialect.
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
Local Identity owns who we are on the wire.
Vehicle Profile owns what the addressed vehicle means.
Connection owns the wire (and signing).
Routing maps packets to Vehicle Profiles.
Nodes build, filter, send, receive, and run workflows.
```

No global parser state.
No mandatory serial baggage.
No dialect buried inside a comms node.
No mission workflow hiding inside transport code.
No v1 soup in a fake mustache.
