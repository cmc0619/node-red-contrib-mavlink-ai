# Examples

Import these flows from Node-RED using **Menu → Import → Examples → node-red-contrib-mavlink-ai**.

The examples are grouped by purpose so the import menu stays useful as the package grows.

## 01 Getting started

- `receive-heartbeat.json` — Decode HEARTBEAT from UDP.
- `build-and-send-heartbeat.json` — Build and send a GCS heartbeat.
- `request-autopilot-version.json` — Request and receive AUTOPILOT_VERSION.

## 02 Telemetry and diagnostics

- `filter-global-position-int.json` — Filter and rate-limit position telemetry.
- `raw-packet-debug.json` — Inspect decoded and raw packet output.
- `telemetry-stream-interval.json` — Start and stop an ATTITUDE stream.
- `px4-sitl-telemetry.json` — Broad PX4/ArduPilot SITL telemetry and error inspection.

## 03 Vehicle control

- `arm-disarm.json` — Arm and disarm commands.
- `beginner-demo-sequence.json` — Debug-only arm/takeoff/spin/photo/land sequence.
- `onboard-companion-debug-storyboard.json` — Companion-computer command and attitude previews.

## 04 Parameters and missions

- `parameter-read-write.json` — Read, set, and list parameters.
- `download-mission.json` — Download a mission with progress and errors.

## 05 Routing and swarm

- `routed-multi-vehicle.json` — Route one UDP port by sysid to multiple profiles.
- `swarm-registry-fanout-dry-run.json` — Discover vehicles and preview fan-out commands.

## 06 Payloads and peripherals

- `servo-relay.json` — Servo and relay commands.
- `camera-trigger.json` — Photo and video commands.
- `gimbal-roi.json` — Gimbal and ROI commands.
- `log-request.json` — Build a log-list request.

## 07 Connections

- `serial-connection.json` — Receive MAVLink over serial.

## 08 Safety-critical

- `calibration-warning-gated.json` — Bench-only calibration with a confirmation gate.
- `parachute-warning-gated.json` — Parachute commands with an explicit release gate.

All UDP examples assume a MAVLink source such as SITL, a vehicle, or `mavlink-router` sending to UDP port `14550`.

Keep examples small and focused. Every user-facing node should have at least one importable example as the package matures.
