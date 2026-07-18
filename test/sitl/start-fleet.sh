#!/usr/bin/env bash
set -euo pipefail

# Launch a virtual multi-drone MAVLink SITL fleet in a single Node process (no
# Docker required) and stream it at a GCS/Node-RED udp connection.
#
#   ./test/sitl/start-fleet.sh                 # 3 drones (sysid 1..3) -> 127.0.0.1:14550
#   FLEET_COUNT=5 ./test/sitl/start-fleet.sh   # 5 drones (sysid 1..5)
#   GCS_HOST=192.168.1.20 ./test/sitl/start-fleet.sh
#
# Any run-fleet.js flag can be appended and wins over the environment, e.g.:
#   ./test/sitl/start-fleet.sh --count 4 --spacing 20
#
# For the container path (one drone per container, distinct sysids), use:
#   docker compose -f test/sitl/docker-compose.yml up --build

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/run-fleet.js" "$@"
