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
- [x] firmware abstraction field (generic | ardupilot | px4 | custom)
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
- [x] runtime XML loading of custom local/Docker dialect paths
- [x] dialect include-graph resolution (do not assume `common`)
- [x] dynamic bundled-dialect discovery in the editor UI
- [ ] MAVLink 2 signing capability / unsupported behavior documented and tested (#15)

## Phase 3: Connection layer

- [x] `mavlink-ai-connection` config node
- [x] UDP peer transport (+ udp-in / udp-out)
- [x] connection status
- [x] clean resource close on redeploy
- [x] inbound packet decode
- [x] outbound send queue
- [x] profile routing mode
- [x] sysid/compid route table
- [x] routed decode uses the matched profile's dialect (per-profile codec)
- [x] structured decode error with raw packet metadata on undecodable packets
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
- [x] stop message interval

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
- [ ] recorded heartbeat/mission fixtures (synthetic harness used today) (#12)

## Phase 9: Polish

- [x] README install instructions
- [x] README examples
- [x] flow exports
- [ ] screenshots (#13)
- [ ] npm publish readiness pass (#14)

## Phase 10: Parameters & telemetry

- [x] `mavlink-ai-param` (read / set / list workflows)
- [x] param progress + timeout/retry + gap refill on lossy links
- [x] param read/write example flow
- [x] `stop message interval` command preset
- [x] telemetry start/stop stream example flow

## Phase 11: Custom dialects

- [x] **Dialect include-graph resolver** (RELEASE_SCOPE §1, issue #3).
  `lib/dialects/xml-include-resolver.js` walks real `<include>` graphs
  (dependency-first, dedup, cycle/missing detection); no forced `common`.
- [x] **Custom local/Docker XML dialect loading** (RELEASE_SCOPE §7, issue #2).
  `lib/dialects/xml-dialect-compiler.js` compiles an arbitrary local/mounted XML
  dialect (and its includes) into a runtime bundle; `custom` + an `.xml` path now
  compiles instead of failing. Loud failure preserved for invalid input.
- [x] **Dynamic bundled-dialect discovery in the UI** (RELEASE_SCOPE §7,
  issue #4). The profile editor discovers dialects from `/mavlink-ai/dialects`
  and adds a `Dialect source` selector (bundled / local path / custom path).

## Open 1.0 gaps (not yet implemented)

These are stated 1.0 requirements in `RELEASE_SCOPE.md` that the current
baseline does **not** meet. They are tracked as GitHub issues, not just prose.

- [ ] **MAVLink 2 signing capability / unsupported behavior** (#15). Confirm
  what `node-mavlink` exposes, document the current support level, avoid UI
  claims for unsupported behavior, and surface unsupported signing behavior
  clearly where feasible.

## Remaining release tasks

These are practical release/readiness items, not architecture gaps.

- [ ] recorded heartbeat/mission fixtures (#12)
- [ ] screenshots (#13)
- [ ] npm publish readiness pass (#14)

## Development rule

Built in this order:

```text
profile -> protocol -> connection -> in/out -> build/filter -> command -> mission
```

Mission handling before the connection/subscription model is stable is how
software goes to the cornfield.
