# MAVLink captures

Store small, sanitized packet captures and replay fixtures here.

Suggested naming:

```text
px4-copter-heartbeat.pcapng
ardupilot-copter-guided-takeoff.pcapng
mission-upload-success.pcapng
mission-upload-timeout.pcapng
multi-vehicle-routing.pcapng
malformed-and-unknown-messages.pcapng
```

Do not commit captures containing signing keys, private network details, or unrelated traffic. Prefer capture filters scoped to the simulator UDP port, for example:

```text
udp.port == 14550
```

Large or generated captures should remain outside Git and be documented here instead.
