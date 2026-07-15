# Changelog

All notable changes to `node-red-contrib-mavlink-ai` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-15

Architecture reset (issue #228): the combined `mavlink-ai-profile` was split
into three explicit config nodes so local identity, target vehicle, and link
concerns each have one owner. This is the intended pre-1.0 clean model; a
deterministic migration path is provided.

### Added

- `mavlink-ai-local-identity` config node: owns who this Node-RED runtime *is*
  on the wire — source SysID/CompID, role preset (GCS / companion / custom),
  HEARTBEAT identity, and the MAVLink 2 signing credential + policy.
- Connection: a required **default Local Identity**, plus an explicit,
  disabled-by-default **Additional Local Identities** binding list so one link
  can deliberately transmit as multiple participants (e.g. GCS `255/190` and
  companion `1/191`). Per-binding outbound permission and opt-in heartbeat.
- Connection now owns the signing **link id** and all per-link channel state via
  a new `LinkState` (`lib/protocol/link-state.js`): outbound sequence numbers
  per local identity, monotonic signing timestamps per `(sysid, compid, link
  id)`, inbound replay memory per key, and detected peer wire versions — this
  satisfies #192 (channel state is no longer per-dialect-codec).
- Outbound message contract: `vehicleProfile` (canonical) and an optional
  `localIdentity` override. Fail-closed errors `LOCAL_IDENTITY_REQUIRED`,
  `LOCAL_IDENTITY_NOT_ATTACHED`, `LOCAL_IDENTITY_AMBIGUOUS`,
  `LOCAL_IDENTITY_COLLISION`, `MULTI_IDENTITY_DISABLED`,
  `VEHICLE_PROFILE_CONFLICT`.

### Changed

- `mavlink-ai-profile` is now a **Vehicle Profile**: target-facing only
  (dialect, firmware, MAVLink version, default target ids, `vehicleFamily`,
  mission preferences). It no longer owns source identity, heartbeat identity,
  or signing. Selecting a Vehicle Profile can never change the local identity
  (fixes #195); `profileType` is replaced by `vehicleFamily`.
- The codec is dialect-scoped and stateless; `encode()` takes the sender ids +
  `LinkState` + optional signing context per call. Inbound verification is the
  pure `verifyInboundPacket(packet, policy)`.
- Message contract field `profile` → `vehicleProfile`; `profile` is retained as
  a documented, temporary compatibility alias.
- Examples, `DESIGN.md`, and help text migrated to the three-node model.

### Migration

- Legacy `profileType` → `vehicleFamily` (vehicle types keep their family; role
  types map to `generic`) with a one-time warning.
- Legacy source/heartbeat/signing fields left on a profile are ignored with a
  one-time warning naming each field and where it moved.
- A pre-v3 Connection with no `localIdentity` fails closed with
  `LOCAL_IDENTITY_REQUIRED` and a hint to create a Local Identity from the old
  profile's source ids.

## [0.1.0] - 2026-07-15

First publishable release. The package is feature-complete for the v2 node set
but pre-1.0 while transport/runtime/protocol hardening is finished (tracked in
the open issues), hence the `0.x` line.

### Nodes

- Config nodes: `mavlink-ai-profile`, `mavlink-ai-connection` (UDP/TCP/serial
  transports, routing, outbound queue, heartbeat).
- Action nodes: `mavlink-ai-in`, `mavlink-ai-out`, `mavlink-ai-build`,
  `mavlink-ai-filter`, `mavlink-ai-command`, `mavlink-ai-mission`,
  `mavlink-ai-param`, `mavlink-ai-move`, `mavlink-ai-payload`,
  `mavlink-ai-swarm`, `mavlink-ai-fanout`.

### Packaging

- Removed the `node-red` **peerDependency**. Node-RED is declared via the
  supported `"node-red": { "nodes": … }` field and kept as a devDependency only,
  so installing into `~/.node-red` no longer pulls a second full Node-RED
  (Node-RED packaging guidance; #151).
- Added a `files` allow-list so `npm pack` ships only `nodes/`, `lib/`,
  `examples/`, `resources/`, plus `README`/`LICENSE`/`package.json` — not the
  test suite, SITL scripts, or design docs.
- Lowered `engines.node` from `>=22` to **`>=20`**. The real constraints are
  global `fetch` (Node 18+) and the optional `serialport@13` (Node 20+), so 20 is
  the true floor; this restores officially-supported Node-RED 4 hosts on Node 20
  (Debian/RPi images) that the palette manager's engine-strict install rejected.
- Moved example support files (web-dashboard HTML, the replay fixture) out of
  `examples/` into `resources/`, so the editor's Import → Examples browser lists
  only real flow entries. Referencing flows and the examples README were updated.
- Added an `author` field.

[0.1.0]: https://github.com/cmc0619/node-red-contrib-mavlink-ai/releases/tag/v0.1.0
