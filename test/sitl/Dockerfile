# Virtual multi-drone MAVLink SITL image.
#
# This is a development/testing helper, not a shipped artifact. It packages the
# lightweight Node fleet engine (test/sitl/virtual-fleet.js) so you can run
# drones with distinct system ids as containers and point Node-RED at them.
# It does NOT contain PX4 or ArduPilot — it speaks the MAVLink wire format
# directly. See test/sitl/README.md for the real-SITL Docker path.
FROM node:22-alpine

WORKDIR /app

# Only the runtime deps are needed (node-mavlink); the fleet uses no optional or
# dev packages. Copy manifests first so the install layer caches across edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --omit=dev

# The engine needs the library and the SITL helpers, nothing else from the repo.
COPY lib ./lib
COPY test/sitl ./test/sitl

# Configuration is via environment variables (see run-fleet.js): SYSID, GCS_HOST,
# GCS_PORT, FLEET_COUNT, ORIGIN_LAT/LON/ALT, SPACING, SPEED, DIALECT.
ENV GCS_HOST=host.docker.internal \
    GCS_PORT=14550 \
    FLEET_COUNT=1

# Drop root: the node:22-alpine image ships an unprivileged `node` user, and the
# fleet needs no write access beyond its own UDP socket.
USER node

ENTRYPOINT ["node", "test/sitl/run-fleet.js"]
