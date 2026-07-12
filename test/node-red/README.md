# Node-RED simulator test flows

Import `protocol-tests.json` into Node-RED after installing this module.

The starter flow contains:

- A PX4-oriented GCS profile using the bundled `common` dialect
- A learned UDP peer bound to `0.0.0.0:14550`
- Separate filtered subscriptions for heartbeat, attitude, position, GPS, battery/system status, and status text
- Debug outputs for quick inspection

Start PX4 SITL with:

```bash
./test/sitl/start-px4-docker.sh
```

For Node-RED in Docker, publish UDP port 14550 as well as the editor port:

```yaml
ports:
  - "1880:1880"
  - "14550:14550/udp"
```

The flow is intentionally observational first. Command, parameter, and mission transaction tests can be layered onto the same profile and connection after inbound telemetry is confirmed.
