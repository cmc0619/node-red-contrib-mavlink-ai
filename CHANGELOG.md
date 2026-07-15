# Changelog

All notable changes to `node-red-contrib-mavlink-ai` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
