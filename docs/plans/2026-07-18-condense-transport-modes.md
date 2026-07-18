# Condense Transport Modes Implementation Plan (#243)

> **For Claude:** Use the superpowers `executing-plans` skill to implement this
> plan task-by-task.

**Goal:** Replace the six transport modes (`udp-peer`/`udp-in`/`udp-out`/`serial`/`tcp-client`/`tcp-server`) with three protocols (`udp`/`tcp`/`serial`) whose role derives from field presence.

**Architecture:** `UdpTransport` becomes modeless — bind explicit-or-ephemeral, always learn (behind the #85 trust boundary), send to fixed remote else learned peers. `TcpTransport` keeps a `role` (`client`/`server`) computed once in `createTransport` from which field is filled (strict xor). `transport-fields.js` holds three protocol specs with presence rules as the single source of truth for editor and runtime. Old mode strings hit the generic `UNKNOWN_TRANSPORT` throw — no legacy shim (pre-1.0 clean break, decided with maintainer).

**Tech stack:** Node core (dgram/net), Node-RED editor HTML, node:test.

**Decisions (from brainstorm):**
- Clean break; all shipped examples updated in this branch.
- No listen-only guarantee; a bound UDP socket is a peer.
- TCP: exactly one of remote-pair / listen-port; both or neither = deploy error.
- UDP: both bind and remote blank = deploy error.
- No legacy-aware error verbiage.

---

### Task 1: transport-fields.js — three protocol specs + presence validation
**Files:** Modify `lib/transport/transport-fields.js`; Test `test/unit/transport-fields.test.js`
1. Rewrite tests: TRANSPORTS is `['udp','serial','tcp']`; visible/required per protocol; `validate()` presence rules — UDP rejects bind+remote both blank; TCP rejects both-filled and neither-filled; serial requires path+baud; unknown mode string (e.g. `udp-peer`) fails.
2. Run: `node --test test/unit/transport-fields.test.js` → FAIL.
3. Implement: three specs; `required` replaced by a per-protocol `validate(config)` returning error strings; keep FIELD_LABELS.
4. Run test → PASS. Commit.

### Task 2: createTransport dispatch + TCP role resolution
**Files:** Modify `lib/transport/index.js`; Test `test/unit/transport.test.js` (dispatch cases)
1. Add tests: `udp` → UdpTransport; `tcp`+remote → role client; `tcp`+bindPort → role server; `udp-peer` → UNKNOWN_TRANSPORT throw.
2. Run → FAIL. 3. Implement switch on 3 values; compute `role` for tcp. 4. PASS. Commit.

### Task 3: UdpTransport modeless
**Files:** Modify `lib/transport/udp-transport.js` (lines w/ `this.mode`: 126, 174, 231, 244, 315, 400, 425); Test `test/unit/transport.test.js`
1. Delete `mode`; descriptor `type: 'udp'`; ephemeral bind when `bindPort` blank/0; remove send-disabled branch; learning un-gated (keep sysid/GCS guards); fixed remote wins for default sends, learned peers otherwise (existing send logic already does this — remove the udp-out short-circuit at 425).
2. Update transport.test.js mode-specific tests to presence-based equivalents. Run transport + packet-origin + udp-peer-learning tests → PASS. Commit.

### Task 4: TcpTransport role
**Files:** Modify `lib/transport/tcp-transport.js` (`mode` → `role`, values `client`/`server`); Tests `test/unit/tcp-multiclient.test.js`, `test/unit/transport.test.js`
Descriptor `type: 'tcp'` + `role`. Run tests → PASS. Commit.

### Task 5: Connection node runtime
**Files:** Modify `nodes/mavlink-ai-connection.js` (default `'udp'` at 124; delete udp-in heartbeat branch at ~2087; validation call passes whole config); Test `test/unit/connection-transport-validation.test.js`
Rewrite validation tests for presence rules surfacing as deploy errors. Run → PASS. Commit.

### Task 6: Editor HTML
**Files:** Modify `nodes/mavlink-ai-connection.html` (spec mirror at top; 3-option picker; row show/hide per protocol; required-ness driven by same presence rules; add one dynamic hint line stating derived role).
Verify: `npm run test:smoke` loads nodes. Commit.

### Task 7: Test fleet sweep
**Files:** All remaining tests listing old modes (`v3-config.js` default, connection-*, integration/*, error-delivery, lifecycle-robustness, packet-origin, profile-identity).
Mechanical `'udp-peer'` → `'udp'` etc.; delete tests that asserted udp-in/udp-out-only semantics; run full unit+integration → PASS. Commit.

### Task 8: Examples + docs
**Files:** 21 example JSONs (`"transport": "udp-peer"` → `"udp"`); README.md, DESIGN.md, WIRE_ENCODING_GOTCHAS.md, examples/README.md, test/sitl doc-comments.
Run `node --test test/unit/examples.test.js` → PASS. Commit.

### Task 9: Full verification
`npm test` (all suites) + `npm run test:smoke`; run multi-drone SITL integration 3× for stability. Push branch, open PR referencing #243.
