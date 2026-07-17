# SITL test harness

Launch helpers and notes for exercising the Node-RED MAVLink nodes against
software-in-the-loop flight controllers. Everything here is a development aid
and is **not** shipped in the npm package.

## Virtual multi-drone fleet (no PX4/ArduPilot needed)

`virtual-fleet.js` is a lightweight, dependency-free MAVLink SITL: a fleet of
virtual drones, each with a distinct system id, that speak the real MAVLink wire
format over UDP and fly a simple collision-aware physics model. Each drone
answers ARM / TAKEOFF / DO_REPOSITION with a COMMAND_ACK and flies a straight,
constant-speed line to its commanded position while streaming HEARTBEAT and
GLOBAL_POSITION_INT. It boots instantly and is deterministic, which a full
PX4/ArduPilot SITL is not.

The same engine backs the CI regression test
(`test/integration/multi-drone-sitl.test.js`), the CLI below, and the Docker
image, so a real multi-vehicle SITL and the test share one behavior model.

### One process, whole fleet

```bash
./test/sitl/start-fleet.sh                 # 3 drones, sysid 1..3 -> 127.0.0.1:14550
FLEET_COUNT=5 ./test/sitl/start-fleet.sh   # 5 drones, sysid 1..5
GCS_HOST=192.168.1.20 ./test/sitl/start-fleet.sh
./test/sitl/start-fleet.sh --count 4 --spacing 20 --speed 8
```

`start-fleet.sh` is a thin wrapper over `run-fleet.js`. The options (flag or
environment variable) are: count (`FLEET_COUNT`), first sysid (`SYSID`),
`GCS_HOST`, `GCS_PORT`, `DIALECT`, origin `--lat/--lon/--alt`, `--spacing`,
`--speed`.

### One container per drone (distinct sysids)

```bash
docker compose -f test/sitl/docker-compose.yml up --build
```

Three containers (`drone-1/2/3`), one system id each, all streaming to a GCS on
the host (`host.docker.internal:14550`; the compose file maps `host-gateway` so
this resolves on Linux too). Override the destination with `GCS_HOST` /
`GCS_PORT` in your shell. Scale by adding services or editing `SYSID`.

### Drive it from Node-RED

Import `examples/08-sitl/multi-drone-fleet-wringer.json`. It binds a routed
`udp-peer` on `0.0.0.0:14550`, routes each system id to its own Vehicle Profile,
lists the fleet in a Swarm registry, and puts it through the wringer: arm the
fleet, take off to staggered altitude layers, then reshuffle the formation
end-for-end while a Separation monitor confirms no two drones ever come within
the collision floor.

### Verify discovery (CI / scripting)

```bash
node test/sitl/verify-fleet-discovery.js --port 14550 --expect 3 --timeout 30000
```

Binds the fleet port, decodes inbound MAVLink, and exits 0 once HEARTBEATs from
the expected number of distinct system ids have arrived (1 on timeout). The
`SITL Fleet` GitHub Actions workflow runs this against both the CLI fleet and
the Docker fleet.

## PX4 Docker quick start (single vehicle)

```bash
./test/sitl/start-px4-docker.sh
# equivalently:
docker run --rm -it -p 14550:14550/udp px4io/px4-sitl:latest
```

Import `examples/08-sitl/px4-sitl-telemetry.json`. It listens as a UDP peer on
`0.0.0.0:14550` and learns the simulator endpoint from incoming traffic.

## ArduPilot (real SITL)

The ArduPilot launch helpers expect an ArduPilot checkout and its
`sim_vehicle.py` tool. Set `ARDUPILOT_HOME` when the checkout is not at
`~/ardupilot`.

```bash
ARDUPILOT_HOME=~/ardupilot ./test/sitl/start-copter.sh
ARDUPILOT_HOME=~/ardupilot ./test/sitl/start-plane.sh
ARDUPILOT_HOME=~/ardupilot ./test/sitl/start-rover.sh
```

Each helper forwards MAVLink to UDP port 14550. Override the destination with
`MAVLINK_OUT`, for example:

```bash
MAVLINK_OUT=udp:192.168.1.20:14550 ./test/sitl/start-copter.sh
```

For a real ArduPilot multi-vehicle swarm, launch several instances with distinct
`--sysid` and `-I` (instance) values, each forwarding to `14550`, then use the
routed multi-drone example above.

## Intended coverage

- Vehicle discovery and heartbeat classification
- Telemetry decoding and filtering
- Command/acknowledgement correlation
- Multiple system/component routing and per-sysid fan-out
- Fleet coordination with inter-drone spatial separation
- Parameter read/write transactions
- Mission upload/download round trips
- Disconnect and reconnect behavior
- Capture replay and malformed packet handling
