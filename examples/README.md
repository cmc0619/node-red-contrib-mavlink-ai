# Examples

Importable Node-RED example flows. In Node-RED use **Menu → Import** and select
a file, or paste its contents.

| File | Shows |
| --- | --- |
| `01-udp-heartbeat-listener.json` | Decode HEARTBEAT from a UDP connection. |
| `02-udp-routed-multi-vehicle.json` | One UDP port routed to Copter/Rover/Plane profiles by sysid. |
| `03-build-and-send-heartbeat.json` | Build a HEARTBEAT and send it out. |
| `04-arm-disarm-command.json` | Arm/disarm via the command node. |
| `05-request-autopilot-version.json` | Request a message, then receive AUTOPILOT_VERSION. |
| `06-download-mission.json` | Download a mission with progress/error outputs. |
| `07-filter-global-position-int.json` | Filter GLOBAL_POSITION_INT from sysid 1, rate-limited to 5 Hz. |
| `08-raw-packet-debug.json` | Decoded output plus raw packet buffers. |
| `09-serial-connection.json` | Same idea over a serial transport. |
| `10-param-read-write.json` | Read/set a single parameter and request the full list via the param node. |
| `11-telemetry-stream-interval.json` | Start/stop an ATTITUDE stream with SET_MESSAGE_INTERVAL command presets. |
| `12-onboard-companion-debug-storyboard.json` | Debug-only storyboard for an onboard Raspberry Pi / companion-computer routine; emits the planned takeoff/circle/aerobatics/return/land phases to Debug only and sends no MAVLink packets. |
| `13-swarm-registry-fanout-dry-run.json` | Discover active sysids from HEARTBEAT into a swarm registry table, then fan out a formation reposition (10 m spacing from a shared origin) as a dry-run wired to Debug — nothing is sent until you disable dry-run and wire in an out node. |

All UDP examples assume a MAVLink source (SITL, a vehicle, or `mavlink-router`)
sending to UDP `14550`. The shared config nodes (`AI Profile - Copter`,
`AI Conn - Copter UDP 14550`) are reused across files, so importing several
examples will reference the same profile/connection.

Keep examples small and focused — one concept each, not a full ground-control
station hairball.
