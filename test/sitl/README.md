# SITL test harness

This directory contains launch helpers and notes for exercising the Node-RED MAVLink nodes against software-in-the-loop flight controllers.

## PX4 Docker quick start

```bash
./test/sitl/start-px4-docker.sh
```

Equivalent command:

```bash
docker run --rm -it -p 14550:14550/udp px4io/px4-sitl:latest
```

Import `examples/08-sitl/px4-sitl-telemetry.json` into Node-RED. It listens as a UDP peer on `0.0.0.0:14550` and learns the simulator endpoint from incoming traffic.

## ArduPilot

The ArduPilot launch helpers expect an ArduPilot checkout and its `sim_vehicle.py` tool. Set `ARDUPILOT_HOME` when the checkout is not at `~/ardupilot`.

```bash
ARDUPILOT_HOME=~/ardupilot ./test/sitl/start-copter.sh
ARDUPILOT_HOME=~/ardupilot ./test/sitl/start-plane.sh
ARDUPILOT_HOME=~/ardupilot ./test/sitl/start-rover.sh
```

Each helper forwards MAVLink to UDP port 14550. Override the destination with `MAVLINK_OUT`, for example:

```bash
MAVLINK_OUT=udp:192.168.1.20:14550 ./test/sitl/start-copter.sh
```

## Intended coverage

- Vehicle discovery and heartbeat classification
- Telemetry decoding and filtering
- Command/acknowledgement correlation
- Parameter read/write transactions
- Mission upload/download round trips
- Disconnect and reconnect behavior
- Multiple system/component routing
- Capture replay and malformed packet handling
