# Roadmap

Build order for `node-red-contrib-mavlink-ai`. Boxes checked below are
implemented in the v2 baseline.

## Phase 0: Skeleton

- [x] package.json
- [x] Node-RED node registration
- [x] README
- [x] DESIGN.md
- [x] basic folder layout
- [x] nodes that load in Node-RED

## Phase 1: Profile layer

- [x] `mavlink-ai-profile` config node
- [x] profile type selection
- [x] dialect selection
- [x] system/component defaults
- [x] mission defaults
- [x] heartbeat identity defaults
- [x] validation errors for invalid config (loud dialect-load failure)

## Phase 2: Protocol layer

- [x] dialect loader
- [x] bundled dialect support (minimal/common/standard/ardupilotmega/...)
- [x] message definition lookup
- [x] enum lookup (full-name and member-name resolution)
- [x] encode wrapper
- [x] decode wrapper
- [x] message normalizer
- [x] clear errors for unknown message/dialect failures
- [ ] runtime XML compilation of arbitrary custom dialects (out of scope for now)

## Phase 3: Connection layer

- [x] `mavlink-ai-connection` config node
- [x] UDP peer transport (+ udp-in / udp-out)
- [x] connection status
- [x] clean resource close on redeploy
- [x] inbound packet decode
- [x] outbound send queue
- [x] profile routing mode
- [x] sysid/compid route table
- [x] subscription API for regular nodes

## Phase 4: Basic flow nodes

- [x] `mavlink-ai-in`
- [x] `mavlink-ai-out`
- [x] `mavlink-ai-build`
- [x] `mavlink-ai-filter`
- [x] HEARTBEAT decode example
- [x] COMMAND_LONG build/send example

## Phase 5: Commands

- [x] `mavlink-ai-command`
- [x] arm / disarm
- [x] set mode
- [x] takeoff / land / RTL
- [x] reboot autopilot
- [x] request message
- [x] set message interval

## Phase 6: Mission protocol

- [x] mission state machine
- [x] mission download
- [x] mission upload
- [x] mission clear
- [x] timeout handling
- [x] retry handling
- [x] mission lock per connection/profile/mission type
- [x] progress events
- [x] simulated-vehicle download integration test

## Phase 7: Optional transports

- [x] serial transport
- [x] lazy-load `serialport`
- [x] helpful error if serial selected but `serialport` missing
- [x] TCP client
- [x] TCP server

## Phase 8: Testing

- [x] unit tests for validation/config coercion
- [x] unit tests for route matching + wildcard priority
- [x] unit tests for codec/dialect/enum/subscription/lock/mission-type
- [x] UDP loopback integration test
- [x] serial-without-path / lazy-load behavior test
- [ ] recorded heartbeat/mission fixtures (synthetic harness used today)

## Phase 9: Polish

- [x] README install instructions
- [x] README examples
- [x] flow exports
- [ ] screenshots
- [ ] npm publish readiness pass

## Development rule

Built in this order:

```text
profile -> protocol -> connection -> in/out -> build/filter -> command -> mission
```

Mission handling before the connection/subscription model is stable is how
software goes to the cornfield.
