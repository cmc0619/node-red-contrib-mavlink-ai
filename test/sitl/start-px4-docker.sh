#!/usr/bin/env bash
set -euo pipefail

IMAGE="${PX4_SITL_IMAGE:-px4io/px4-sitl:latest}"
HOST_PORT="${MAVLINK_PORT:-14550}"

exec docker run --rm -it \
  -p "${HOST_PORT}:14550/udp" \
  "${IMAGE}"
