# Vehicle State & Health — design spec

Issues: #208 (first-class vehicle state/health node), #225 (health-aware
heartbeat for onboard companions). One spec, two implementation PRs:

- **PR A (#208)**: `lib/state/vehicle-state.js` engine + `mavlink-ai-vehicle-state`
  node + example rework + tests.
- **PR B (#225)**: connection advertised-health store + Local Identity
  "onboard companion" preset + health-driven heartbeat + tests.

## Problem

Control flows want state, not packets: connected, armed, mode, landed/in-air,
position/home, GPS quality, battery, health, capabilities, recent STATUSTEXT,
and freshness. Today the Swarm registry ingests only four message types, and
the dashboard/safety examples rebuild a broader vehicle model in large
Function nodes — every real application reimplements correlation, units, enum
interpretation, staleness, and alerting, and different flows disagree.

Outbound, the connection heartbeat hardcodes `MAV_STATE_ACTIVE`: "the adapter
process is alive" is easily misread as "onboard autonomy is healthy," which
MAVLink guidance explicitly warns against.

## PR A — the state engine and node

### Engine: `lib/state/vehicle-state.js`

`VehicleStateEngine` — pure state logic, no Node-RED types (same layering as
`lib/swarm/vehicle-registry.js`). One instance per state node, fed decoded
§14.1 messages from the connection's existing `subscribe()` API with a
`messageNames` filter:

`HEARTBEAT, EXTENDED_SYS_STATE, SYS_STATUS, BATTERY_STATUS, GPS_RAW_INT,
GLOBAL_POSITION_INT, HOME_POSITION, AUTOPILOT_VERSION, STATUSTEXT`

**Keying and aggregation (#208).** State is keyed per **sysid** (a vehicle).
Within a vehicle, the **autopilot component owns flight state**: armed, mode,
landed state, position, home, GPS, battery, and sensor health are taken only
from `MAV_COMP_ID_AUTOPILOT1` (compid 1). Every other component that
heartbeats (camera, companion, gimbal) is tracked as a presence entry —
`{ compid, type, autopilot, system_status, last_seen }` — under
`components[]`. A vehicle whose autopilot has never been heard is still
listed (components only) with `autopilot_seen: false`; its flight sections
stay absent.

**Sections.** Each section carries its own `updated_at` and is independently
stale-checked. A section is absent (`null`) until its source message has been
seen — **never zero-filled**.

| Section | Source | Notes |
|---|---|---|
| `identity` | HEARTBEAT + profile enums | readable `type`/`autopilot` names resolved from the actual vehicle HEARTBEAT via the effective profile's enums; raw numerics kept alongside |
| `armed`, `mode` | HEARTBEAT | `mode` resolved to a readable name using firmware + vehicle type (existing mode-resolution helpers); raw `base_mode`/`custom_mode` kept |
| `landed` | EXTENDED_SYS_STATE | `'unknown'` until the message is seen (PX4 sends it; ArduPilot generally does not) |
| `position` | GLOBAL_POSITION_INT | degE7 → degrees, mm → m; relative + AMSL alt |
| `home` | HOME_POSITION **only** | absent until the vehicle reports home. No first-observed-position substitution. (A later `estimated` marker is allowed by #208 but out of scope here.) |
| `gps` | GPS_RAW_INT | `fix_type` name + numeric, satellites, eph/epv with UINT16_MAX → `null` |
| `battery` | BATTERY_STATUS, SYS_STATUS | per-battery entries; `-1` / sentinel values (current, remaining, mAh) → `null` with the field marked `unavailable`; SYS_STATUS voltage kept as fallback when BATTERY_STATUS is absent |
| `health` | SYS_STATUS | `onboard_control_sensors_{present,enabled,health}` decoded to named per-sensor flags: `{ name, present, enabled, healthy }`; unknown bits surfaced by bit index |
| `capabilities` | AUTOPILOT_VERSION | read through the connection's existing #233 capability cache (`getVehicleCapabilities`); the engine does not re-parse |
| `statustext` | STATUSTEXT | ring buffer (configurable N, default 20) of `{ severity, severity_name, text, at }` |

**Freshness.** `connected` means HEARTBEAT within the staleness window —
and *only* that. Position/GPS/battery each compare their own `updated_at`
against the window and carry `stale: true` when exceeded; a fresh HEARTBEAT
never refreshes another section (#208's core complaint). Default window
5000 ms, configurable on the node.

**Contract versioning.** Every emitted payload carries
`contract: 'vehicle-state/1'`. Additive changes keep `/1`; breaking changes
bump it.

### Node: `mavlink-ai-vehicle-state`

Config: **Connection** (required), **Sysids** (optional filter, blank = all
vehicles the connection's routing accepts — one node serves a routed fleet),
**Snapshot interval** (seconds, 0 = on-demand only, default 0),
**Staleness window** (ms, default 5000), **Statustext buffer** (default 20).

Input:
- `{ command: 'snapshot' }` (optional `sysid`) — emit snapshot(s) now.
- Health assertions (see PR B); accepted in PR A's contract but only wired to
  the connection in PR B.

Outputs (3):
1. **transitions** — edge-triggered events, one message each:
   `connected` / `connection lost`, `armed`/`disarmed`, mode change, landed
   change, GPS fix-class change, per-sensor health flag change, home set,
   component appeared/lost. Payload: `{ event, sysid, from, to, at,
   contract }`. Never emitted at telemetry rate — only on change.
2. **snapshots** — full per-vehicle state on interval/demand:
   `{ sysid, connected, autopilot_seen, identity, armed, mode, landed,
   position, home, gps, battery, health, capabilities, components,
   statustext, contract }`.
3. **statustext** — live feed, one message per STATUSTEXT with severity name
   and vehicle identity.

Node status badge: `N vehicles · M connected`.

Lifecycle: subscriptions torn down on close/redeploy like In/Swarm; the
engine is rebuilt on deploy (state is observational, safe to rebuild).

### Examples and tests (PR A)

- `examples/09-observability/21-vehicle-status-web-dashboard.json` and the
  safety-monitor example consume the node's snapshots/transitions instead of
  rebuilding state in Function nodes.
- Engine unit tests: per-message ingestion, sentinel handling, per-section
  staleness (fresh HEARTBEAT + stale position), autopilot-vs-component
  aggregation, multi-component presence, statustext ring.
- Node tests: transition edges (no churn on repeated identical values),
  snapshot on demand/interval, sysid filter, teardown.

## PR B — advertised health and the onboard-companion heartbeat (#225)

### Health assertion contract

Flows assert the health of *their own* onboard function by sending to the
state node's input:

```json
{ "health": "nominal" | "degraded" | "emergency" | "fatal",
  "ttl_s": 10,
  "note": "planner watchdog ok" }
```

The node forwards assertions to the connection
(`connection.setAdvertisedHealth(identityRef, assertion)`), which stores
`{ state, note, expires_at }` per outbound identity.

### Heartbeat mapping

The periodic heartbeat consults the store when the identity is
**health-driven**:

| Asserted | HEARTBEAT `system_status` |
|---|---|
| never asserted yet | `MAV_STATE_STANDBY` |
| `nominal` | `MAV_STATE_ACTIVE` |
| `degraded` | `MAV_STATE_CRITICAL` |
| `emergency` | `MAV_STATE_EMERGENCY` |
| `fatal` | **heartbeat stops** (MAVLink: a faulted component must not keep heartbeating from an unaware context); node status shows the declared fault; recovery requires a fresh non-fatal assertion |
| assertion expired (past `ttl_s`) | `MAV_STATE_CRITICAL` — an expired lease must never look healthy |

Existing identities are untouched: a GCS-role identity keeps today's static
`MAV_STATE_ACTIVE` unless health-driven mode is enabled.

### Onboard companion preset

Local Identity gains a role preset **onboard companion**: vehicle SysID +
unique onboard CompID (default 191, `MAV_COMP_ID_ONBOARD_COMPUTER`),
`MAV_TYPE_ONBOARD_CONTROLLER`, `MAV_AUTOPILOT_INVALID`, health-driven mode
on by default. (Identity modeling per #195's direction.)

### Documented separations

- HEARTBEAT is **component presence** — not command delivery, setpoint
  freshness, sensor health, or authorization.
- Independent of the Move stream TTL (#216): a live heartbeat says nothing
  about setpoint freshness, and vice versa.
- GCS failsafe heartbeats and companion health are different
  firmware-specific contracts; a companion must not impersonate a GCS to
  mask loss of the operator station.
- Status surfaces adapter-alive (node/transport status), flow health
  (assertions), transport-ready, and vehicle-heartbeat-fresh
  (state node `connected`) as separate signals.

### Tests (PR B)

Flow fault (fatal stops the heartbeat), stale assertion (TTL expiry drops to
CRITICAL), recovery (fresh assertion resumes ACTIVE), reconnect/redeploy
(store survives a profile edit, resets with the connection), event-loop delay
tolerance (expiry checked at heartbeat tick, not with its own timer).

## Out of scope

- Swarm adopting the engine (post-1.0, tracked by #217's direction).
- Flow-facing connection lifecycle/link-health messages (#205, deferred).
- An `estimated` home fallback marker (allowed by #208, not needed now).
- Recorded-capture fixtures (#12 covers that separately).
