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
| `14-command-beginner-demo-sequence.json` | Beginner choreography: arm → takeoff 10 m → spin 360 → take photo → land → disarm, one preset per step, all Debug-wired. Flips are firmware-specific (ArduCopter FLIP is a *mode*), so they are deliberately not a generic step. |
| `15-command-servo-relay.json` | Set a servo output / toggle a relay via raw MAV_CMDs. Channel and relay numbers are vehicle-specific — verify the mapping before wiring an out node. |
| `16-command-camera-trigger.json` | Take photo / start / stop video with the Camera presets, targeting a separate camera component (`target_component` 100). |
| `17-command-gimbal-roi.json` | Point a gimbal (GIMBAL_MANAGER_PITCHYAW) and aim at / cancel a region of interest (DO_SET_ROI_LOCATION via COMMAND_INT). |
| `18-command-log-request.json` | Request the onboard log list with a LOG_REQUEST_LIST message (a plain message, not a MAV_CMD). Erase/format actions are deliberately excluded. |
| `19-command-calibration-warning-gated.json` | Bench-only sensor calibration behind an explicit confirmation gate — never run while armed or flying. |
| `20-command-parachute-warning-gated.json` | Parachute enable/release pattern with a release confirmation gate. Safety-critical: an example pattern, not a preset. |

All UDP examples assume a MAVLink source (SITL, a vehicle, or `mavlink-router`)
sending to UDP `14550`. The shared config nodes (`AI Profile - Copter`,
`AI Conn - Copter UDP 14550`) are reused across files, so importing several
examples will reference the same profile/connection.

Keep examples small and focused — one concept each, not a full ground-control
station hairball.
