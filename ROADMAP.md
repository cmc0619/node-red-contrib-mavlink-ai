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
- [x] MAVLink 2 signing: sign outbound + verify inbound, documented and tested (#15)

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
- [x] synthetic mission workflow coverage

## Phase 7: Optional transports

- [x] serial transport
- [x] lazy-load `serialport`
- [x] helpful error if serial selected but `serialport` missing
- [x] TCP client
- [x] TCP server

## Phase 8: Testing

- [x] offline smoke-load test
- [x] offline unit tests for validation/config coercion
- [x] offline unit tests for route matching + wildcard priority
- [x] offline unit tests for codec/dialect/enum/subscription/lock/mission-type
- [x] no hardware/network/serial integration tests in the default suite
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

## Phase 12: Swarm primitives & editor help

- [x] **Rich MAVLink editor help** (issue #45). The metadata layer now serves
  message/field/enum-member/command descriptions parsed from the bundled
  `mavlink-mappings` type declarations; the build and command editors show
  visible `form-tips` help (message/command description, per-field
  `Type | Units | description`, wire-type placeholders, enum dropdowns with
  descriptions) instead of hiding help in `title` tooltips. Command *param*
  enums stay descriptive text — the generated metadata doesn't expose a
  param-to-enum association to build dropdowns from.
- [x] **Swarm registry** (issue #46). `mavlink-ai-swarm` +
  `lib/swarm/vehicle-registry.js`: active vehicles from HEARTBEAT (armed, mode
  via the vehicle's own autopilot/type, position, battery), stale/expiry,
  filters, named groups.
- [x] **Fan-out vs broadcast** (issue #46). `mavlink-ai-fanout` +
  `lib/swarm/fanout.js`: one command expanded per target sysid (or an explicit
  `target_system` 0 broadcast), per-target overrides, pacing, dry-run, and
  per-vehicle COMMAND_ACK aggregation (`accepted/failed/timedOut/skipped`).
- [x] **Coordinate-frame helpers** (issue #46).
  `lib/swarm/coordinate-frames.js`: meters offsets -> lat/lon deltas, NED
  offset -> global target, degE7 scaling, NED-down vs altitude-up guards.
- [ ] Formation/leader-follower helper nodes (issue #46 follow-up; the
  primitives above land first per the issue's scope guidance).

## Phase 13: Command node UX & preset expansion

- [x] **Workflow-grouped command dropdown** (issue #50). Presets grouped into
  Basic Flight / Guided–Autonomy / Mission / Camera / Telemetry–System
  optgroups; raw `MAV_CMD_*` clearly presented as the Advanced escape hatch.
- [x] **New presets** (issues #50/#52): Go To / Reposition (COMMAND_INT
  DO_REPOSITION), Change Speed, Condition Yaw, Spin / Rotate (configurable
  angle, default 360), Mission Start, Pause/Resume Mission
  (DO_PAUSE_CONTINUE, param1 protected), Take Photo, Start/Stop Video.
- [x] **Friendly preset parameter UI** (issue #49). Per-preset editor fields
  stored in `presetFields` (separate from raw paramN storage): profile-aware
  flight-mode dropdown (`/mavlink-ai/modes` endpoint over `knownModes`),
  takeoff altitude, force arm/disarm as an advanced checkbox, message
  pickers + rate-Hz input for the message-interval presets, and a
  warning/confirmation gate on the reboot preset. Runtime `msg.payload`
  values override editor statics.
- [x] **Build node command warning** (issue #48). Selecting
  `COMMAND_LONG`/`COMMAND_INT` in the Build node shows a visible warning
  pointing at the Command node; both messages stay fully usable.
- [x] **Specialized command families as examples first** (issue #51):
  servo/relay, camera trigger, gimbal + ROI, log list request, calibration
  (confirmation-gated, bench only), parachute (release-gated) — plus the
  beginner demo sequence (issue #52). All Debug-wired by default.
- [ ] Dedicated `mavlink-ai-camera` / `mavlink-ai-gimbal` nodes only if the
  example flows prove the workflows are stateful enough to justify them
  (issue #51 guidance).

## Phase 14: MAVLink 2 signing (#15)

`node-mavlink` does expose signing primitives (`MavLinkPacketSignature.key`,
`MavLinkProtocolV2.sign`, and `MavLinkPacket.signature.matches`), so 1.0 ships
real minimal support rather than a "not supported" note.

- [x] **Sign outbound**: the codec builds a V2 `IFLAG_SIGNED` frame and appends
  the signature block (node-mavlink's own `sendSigned` sequence) when the
  profile enables it. Signing forces MAVLink 2 framing.
- [x] **Verify inbound**: the connection checks `packet.signature` before
  routing/decoding and rejects bad/missing signatures per policy
  (`signature-invalid` / `signature-required` / `signature-no-key`), surfaced on
  the In node's errors output.
- [x] **Profile config**: sign-outbound / verify-inbound / require-signature
  toggles and a link id, with the passphrase stored as an encrypted Node-RED
  credential (never in exported flow JSON).
- [x] Unit + UDP-loopback integration tests for the sign/verify matrix.

## Open 1.0 gaps (not yet implemented)

These are stated 1.0 requirements in `RELEASE_SCOPE.md` that the current
baseline does **not** meet. They are tracked as GitHub issues, not just prose.

- (none currently open — signing landed in Phase 14)

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
