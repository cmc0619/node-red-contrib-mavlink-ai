#!/usr/bin/env bash
set -euo pipefail

ARDUPILOT_HOME="${ARDUPILOT_HOME:-$HOME/ardupilot}"
MAVLINK_OUT="${MAVLINK_OUT:-udp:127.0.0.1:14550}"

exec "$ARDUPILOT_HOME/Tools/autotest/sim_vehicle.py" \
  -v ArduCopter \
  -f quad \
  --console \
  --map \
  --out="$MAVLINK_OUT"
