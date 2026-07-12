# Examples

Import these flows from Node-RED using **Menu → Import → Examples → node-red-contrib-mavlink-ai**. The folders below are deliberate: they keep the import menu organized while retaining the original `01` through `20` filenames.

## 01 Getting started

- `01-udp-heartbeat-listener.json` — Decode HEARTBEAT from a UDP connection.
- `03-build-and-send-heartbeat.json` — Build and send a GCS heartbeat.
- `05-request-autopilot-version.json` — Request and receive AUTOPILOT_VERSION.
- `07-filter-global-position-int.json` — Filter and rate-limit position telemetry.
- `08-raw-packet-debug.json` — Inspect decoded and raw packet output.
- `09-serial-connection.json` — Receive MAVLink over serial.

## 02 Vehicle control

- `04-arm-disarm-command.json` — Arm and disarm commands.
- `11-telemetry-stream-interval.json` — Start and stop an ATTITUDE stream.
- `12-onboard-companion-debug-storyboard.json` — Preview companion-computer routines in Debug.
- `14-command-beginner-demo-sequence.json` — Debug-only arm/takeoff/spin/photo/land sequence.

## 03 Parameters

- `10-param-read-write.json` — Read, set, and list parameters.

## 04 Missions

- `06-download-mission.json` — Download a mission with progress and errors.

## 05 Routing and swarm

- `02-udp-routed-multi-vehicle.json` — Route one UDP port by sysid to multiple profiles.
- `13-swarm-registry-fanout-dry-run.json` — Discover vehicles and preview fan-out commands.

## 06 Payloads and peripherals

- `15-command-servo-relay.json` — Set a servo output or relay.
- `16-command-camera-trigger.json` — Trigger camera photo and video commands.
- `17-command-gimbal-roi.json` — Control gimbal pitch/yaw and regions of interest.
- `18-command-log-request.json` — Request the onboard log list.

## 07 Safety-critical

- `19-command-calibration-warning-gated.json` — Bench-only calibration with a confirmation gate.
- `20-command-parachute-warning-gated.json` — Parachute commands with an explicit release gate.

## 08 SITL

- `px4-sitl-telemetry.json` — Broad PX4 or ArduPilot SITL telemetry and error inspection.

All UDP examples assume a MAVLink source such as SITL, a vehicle, or `mavlink-router` sending to UDP port `14550`.

Keep examples small and focused. Every user-facing node should have at least one importable example as the package matures.
