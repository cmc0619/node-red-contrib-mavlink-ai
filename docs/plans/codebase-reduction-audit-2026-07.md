# Codebase Reduction Audit — impossible-condition guardrails & node-mavlink duplication

Date: 2026-07-20. Method: six parallel read-only audits covering all of `lib/`, `nodes/`, and `test/` (~44k lines), with call-site traces and node-mavlink 2.3.0 / mavlink-mappings API verification against upstream sources. No code was changed.

## Headline conclusions

1. **Goal 2 (node-mavlink duplication) is nearly a null result — the migration already happened.** `lib/protocol/mavlink-codec.js` already routes framing, parsing, serialization, CRC (`x25crc`), and signing through node-mavlink (`MavLinkPacketSplitter/Parser`, `MavLinkProtocolV1/V2`, `MavLinkPacketSignature`). Transports, runtime, routing, swarm, state, and nodes contain zero wire-layer code. The remaining hand-rolled wire code patches **verified upstream gaps**, not duplication:
   - `truncateV1Extensions` — upstream v1 serialize writes extension bytes; must stay.
   - `ensureMinV2Payload` — upstream truncation can yield 0; must stay.
   - `applyExactFloatBits` — PX4 byte-union / JS NaN canonicalization; project-specific.
   - ~~`ResyncingPacketSplitter` + `PACKET_VALIDATION` mirror~~ — **REMOVED 2026-07-20 by maintainer decision**: stock splitter's UNKNOWN length-skip accepted (clean-link deployment assumption).
   - `LinkState` per-identity seq — upstream only has a module-global `seq`; banned by AGENTS.md rule 3 anyway.
   - `buildMergedMagic` (connection.js:1091-1121) multi-dialect CRC-extra merge — node-mavlink only accepts a finished table.
   - ~~`KNOWN_INCOMPAT_FLAGS` rejection~~ — **REMOVED 2026-07-20 by maintainer decision**: only IFLAG_SIGNED exists on the wire today; frames with hypothetical future flags now decode under current assumptions.
   - Wire-magic sniff — **REPLACED 2026-07-20**: now reads `packet.protocol.constructor.START_BYTE` (upstream's sanctioned version API) instead of `packet.buffer[0]` with a dead `header.magic` fallback.

2. **The real shrink is Goal 1 guardrails + test scaffolding.** Estimated ~250–300 lines of production/lib code, ~40 lines of internal duplication, and **~700–950 lines of test code**, plus ~250 more lines if the node-mavlink wire patches are ever upstreamed.

3. The production code is genuinely lean in most places — the audits explicitly cleared the majority of defensive code as reachable (wire input, imported/hand-edited flow JSON, user msg.payload, optional deps, lifecycle races). The findings below are the exceptions, each with an impossibility proof.

---

## Tier 1 — high-confidence dead code (remove first)

### A. Delivery-mode duplication across 4 action nodes (~68 lines, `nodes/`)
Applies identically to `mavlink-ai-command.js`, `mavlink-ai-fanout.js`, `mavlink-ai-move.js`, `mavlink-ai-payload.js`:
- **Dead rethrow**: constructor try/catch rethrows when `err.code !== 'DELIVERY_UNSET'`, but `lib/util/delivery.js:21-29` has exactly one throw site and it always sets that code. (command.js:296-298, fanout.js:91-93, move.js:67-69, payload.js:77-79) — ~12 lines.
- **Per-message re-validation**: every input handler re-runs `resolveDeliveryMode(config, …)` on immutable config already resolved in the constructor. Resolve once into `node._deliveryMode`; handlers read it. (command.js:365-370, fanout.js:144-149, move.js:200-205, payload.js:156-161) — ~28 lines.
- **Hand-rolled "invalid config" badge** duplicates `watchConfigBadge().refresh()` (lib/util/node-lifecycle.js:79-90) with identical precedence. Nodes call `watchConfigBadge` *before* assigning `_configError`, so the first refresh misses; move the call below the assignment and delete the manual blocks. (command.js:302-313, fanout.js:97-108, move.js:72-76, payload.js:82-86) — ~28 lines.

### B. Redundant sysid re-checks in all workflow families (~25 lines, `lib/`)
Every workflow subscribes with `sysids: [this.targetSystem]`, then re-checks `payload.sysid === this.targetSystem` in the handler. `SubscriptionRegistry.matches → idAccepted` already enforces the filter, and a NaN/non-integer targetSystem throws BAD_FILTER at subscribe time — a delivered payload provably matches. Sites: `lib/param/param-workflow.js:369-377` + call sites 572/694/834; `lib/mission/mission-state-machine.js:198-207` + call sites in mission-download.js:104, mission-upload.js:94, mission-clear.js:51; `lib/command/command-workflow.js:301-304`. Only `_matchesComponent` does real work (no compid filter exists). Tests using fake `subscribe()` that ignores filters will need the sysid-mismatch cases dropped too.

### C. Codec guards unreachable from the only producers (~18 lines production + ~22 test, `lib/protocol/`)
- `LINK_STATE_REQUIRED` throw (mavlink-codec.js:356-359): both production call sites build `encodeOpts` with `link: node._link` unconditionally (connection.js:1755-1767). Pinned by test/unit/dialect-codec.test.js:94-101.
- Source sysid/compid re-validation (mavlink-codec.js:368-369, requireUint8 at :181-191): the Local Identity node validates the same [1,255] range before any send; invalid identity fails the connection closed. Pinned by dialect-codec.test.js:103-116. (Medium confidence — arguably the wire boundary defends itself; strictly unreachable within this codebase.)
- `opts.signing.linkId || 0` + requireUint8 (mavlink-codec.js:416): connection constructor validates signingLinkId to [0,255] and only stores validated values. No test pins it.

### D. Normalizer / replay-tracker / dialect-loader dead fallbacks (~12 lines, `lib/protocol`, `lib/dialects`)
- message-normalizer.js:37 — `bundle && bundle.valid ? …` guard; codec constructor throws unless `bundle.valid`, sole caller passes `this.bundle`.
- message-normalizer.js:44 — `packet.buffer && packet.buffer.length ? packet.buffer[0] : header.magic`; upstream `buffer` is a required constructor arg, never null/empty (and the `header.magic` fallback is 0 on v1 — wrong anyway).
- replay-tracker.js:79-82 — `Number(timestamp)`/`Number.isFinite` rejection; input is `packet.signature.timestamp`, upstream-defined as a 6-byte UIntLE read, always finite.
- replay-tracker.js:96 — `Number.isFinite(now) ? now : 0`; `now` defaults to `currentSigningTimestamp()`.
- xml-catalog.js:511 — `commit ? … : 'nocommit'`; sole call site is inside `update()` which throws earlier when commit is falsy.
- xml-catalog.js:490 — `s === '..'` subsumed by `s.includes('..')`; `!s` subsumed by `/^[\w.-]+$/`.
- xml-catalog.js:420 — `'Downloaded XML failed to compile.'` fallback; `loadDialect` never throws and always populates `bundle.error`.
- enum-resolver.js:59-61, 86-88 — `if (!mod) continue` and `typeof num !== 'number'` guards; module arrays validated upstream, custom compiler only writes numeric enum values.
- link-state.js:119 — `Number.isFinite(Number(sysid))` half; production passes a uint8 header field.

### E. Workflow/lib dead guards (~30 lines)
- command-workflow.js:146-165 — `typeof this.connection.acquireLock === 'function'` guard; both the real runtime and the uninitialized-connection stub always define it.
- `setTimeout` unref existence guards at param-workflow.js:455-457, command-workflow.js:288-290, mission-state-machine.js:365-367 — collapse each 3-line guard to `this._timer.unref()`.
- mission-upload.js:208-215 — `if (!item) return` and `_itemUseInt !== undefined` in `_resendItem` are unreachable (seq passed an existence check at :109; `_itemUseInt` set at :125 before the handler that arms resend). The comment describes an unreachable state.
- vehicle-state.js:129-208 — six `else if` branches repeat `&& Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1`, provably always true after the compid gate at :122-125.
- advertised-health.js:75,78 — `record.expires_at != null` always true and `STATUS_BY_STATE[record.state] || 'MAV_STATE_STANDBY'` never falls through; `normalizeAssertion` is the only record producer and guarantees both.
- vehicle-registry.js:299,305,315,318 + vehicle-state.js:300 — dead fallbacks on fields the module sets atomically (`lastHeartbeat`, `positionUpdatedAt`, `armed`, `custom_mode`).

### F. Rule-7 violations (back-compat shims) (~17 lines)
- serial-transport.js:57-61 — legacy config aliases `config.path`, `config.baudRate`, `dataBits`/`stopBits`/`parity`; factory only passes `serial*` names. Clearest rule-7 violation.
- subscription-registry.js:255-261 + ~6 JSDoc lines — loud rejection of removed singular `filter.sysid`/`compid` spellings. Caveat: genuine fail-closed argument (silently ignoring would widen a narrow filter to wildcard) — deliberate policy choice.

---

## Tier 2 — medium confidence (unreachable in production, reachable via direct programmatic misuse)

Each of these is guarded at deploy time by `validateConnectionConfig`, so the runtime guard only fires for direct-construction callers (i.e. the modules' own unit tests). Removing them narrows the public API contract — consistent with rule 7's clean-break spirit, but a deliberate decision:

- udp-transport.js:442-445 — `_sendOne` destination re-validation (~4 lines).
- udp-transport.js:280-286 — `confirmPeer` null/integer guards (~5 lines; deliberately public trust-boundary API).
- serial-transport.js:91-94 — `SERIAL_NO_PATH` (~3 lines).
- transport/index.js:53-55 — `default:` UNKNOWN_TRANSPORT throw (~3 lines).
- outbound-queue.js:64-73 — `maxLength`/`agePromotionMs` NaN/out-of-range fallbacks (~6 lines; sole production caller passes only `{ enabled }`; keep `opts.now` test hook).
- tcp-transport.js:56,62 — `config.host || '127.0.0.1'` and `5760` port fallback (~2 lines).
- bounded-write.js:37-39, reconnect-backoff.js:68-70 — `typeof timer.unref === 'function'` guards (~4 lines).
- message-metadata.js:161-179 — double try/catch around generated-class constructor in `resolveParamIndex` (~8 lines; guards a hypothetical generator shape change).
- mavlink-ai-connection.js:830-838 — dead `LOCAL_IDENTITY_REQUIRED/INVALID` ternary in `resolveOutboundIdentity`; `_inactiveError` is always set on every path that leaves identity missing/invalid (~9 lines; rests on a whole-file invariant — re-verify before deleting).
- mavlink-ai-vehicle-state.js:92-100 — try/catch around `getVehicleCapabilities`, a pure `Map.get` that cannot throw (~5 lines).
- param-workflow.js:911-921 — `ParamSetAuto` duplicates precondition validation the composed `ParamRead`/`ParamSet` constructors repeat (~10 lines; changes error code from BAD_PARAM_SET to BAD_PARAM_READ on missing id).
- param-catalog.js:73-78 — `safeSegment` throw for `''`/`'.'`/`'..'` unreachable (sourceKeys always prefixed); :134 `!Array.isArray(params)` half-check dead.
- mission-state-machine.js:245 (`payload.fields || {}`), param-workflow.js:395-396, mission-state-machine.js:225-226, command-workflow.js:312-313 — "no readable compid/fields" permissive branches; normalizer always sets `sysid`/`compid`/`fields`. Only fire for synthetic test payloads. (Do NOT touch the `f.target_system !== undefined` checks — real for v1 frames.)
- param-workflow.js:885,846 — dead `count == null` and `Number.isFinite(count)` guards in `ParamList` (`param_count` is a mandatory uint16 the decoder always populates).
- vehicle-state.js:217 — `typeof f.text === 'string'` ternary; char[50] always decodes to string.

---

## Tier 3 — internal duplication (pure line savings, no behavior change)

- **C-1** `screaming()` duplicated byte-identically: message-metadata.js:235-240 and xml-catalog.js:530-535 vs `enumResolver.camelToScreaming` (enum-resolver.js:23-28). Import instead — ~12 lines.
- **C-2** `extractIncludes` + `INCLUDE_RE` duplicated: xml-catalog.js:37,448-460 vs xml-include-resolver.js:27,118-132. Export from resolver, import — ~25 lines.
- **C-3** `fileExists` duplicated: xml-catalog.js:549-555 vs xml-include-resolver.js:218-224 — ~7 lines.
- **C-4** `AUTOPILOT_FIRMWARE`, 22-entry `TYPE_VEHICLE` map, `MAV_MODE_FLAG_SAFETY_ARMED`, and `_enumName` all verbatim-duplicated between vehicle-registry.js:14-58 and vehicle-state.js:8-22,353-358. Extract to a shared module — ~20 lines.
- **C-5** Fan-out dispatch loop copy-pasted between AWAIT and SEND arms (mavlink-ai-fanout.js:330-353 vs 430-453) — one shared `dispatch(runner)` helper — ~23 lines.
- Minor: `node.profile && node.profile.id` after null-check (fanout.js:207, command.js:747-748); `{ msg, priority }` passed to `connection.send()` which ignores `msg` (move.js:359, payload.js:297); dead `!profile` in `getCodecForProfile` (connection.js:607); `payload.connection_id || ''` (subscription-registry.js:113); `decision.profile || node.profile` (connection.js:2052 — every `accepted:true` route returns non-null profile).

---

## Test suite (~700–950 lines — the biggest single win)

1. **S2 — Setup boilerplate** (~300–500 lines, 30 files): 91 `RED.create('mavlink-ai-vehicle', …)` + 57 `RED.create('mavlink-ai-connection', …)` restate config blocks that `makeProfile`/`makeIdentity`/`makeConnection` (test/helpers/v3-config.js:29-108) already default. Worst: mixed-version-broadcast.test.js, six near-identical ~22-line setups.
2. **S1 — fakeConnection helper** (~150–250 lines): ~13 hand-rolled connection stubs rebuild the same `{ subscribe, unsubscribe, send, deliver, locks, resolveOutboundIdentity, … }` surface (in-node, formation-node, swarm-node, vehicle-state-node, move-node, param-node, payload-node, send-priority, command-node, fanout, node-close-abort, error-delivery, lifecycle-robustness). One configurable helper in test/helpers/ absorbs them.
3. **S3 — `until` retry helper** (~90 lines): identical ~15-line retry-until-event helper in signing.test.js (3 copies), udp-peer-learning.test.js, routed-decode.test.js, plus `waitFor`/`tick` pollers in mixed-version-broadcast, multi-drone-sitl, tcp-multiclient.
4. **S4 — Transport-validation matrix asserted twice** (~60 lines): transport-fields.test.js:19-130 (lib) vs connection-transport-validation.test.js:45-111 (node). Keep lib table + one prove-it's-wired node test.
5. **S5 — smoke-load.js** (41 lines): duplicates `MockRED().loadNodes()` run by dozens of unit tests in the same `npm test` run; only distinct value is failing 10s earlier.
6. **S6 — profile-heartbeat.test.js:37-74** (~25 lines): hand-builds splitter/parser pipelines where `createDecoder` is used everywhere else; duplicates round-trip assertions in dialect-codec.test.js:378-392.
7. **S7 — test/captures/mavlink/** (22 lines + dir): README-only scaffolding nothing references.
8. **G1-1 — multi-identity-channel.test.js:88-95** (~9 lines): tautological test asserting two template strings differ; no production code runs.
9. Tests pinning the Tier-1-C codec guards: dialect-codec.test.js:94-116 (~22 lines, deleted with the guards).

## Upstream opportunity (not removable now)

The codec patches (`ResyncingPacketSplitter`, `truncateV1Extensions`, `ensureMinV2Payload`, `applyExactFloatBits`) fix confirmed node-mavlink defects — the splitter test's own comment says it belongs upstream. If upstreamed: ~130 production lines + ~120 test lines. Directional only.

## Deliberately NOT flagged (verified reachable — do not "clean up")

- All socket/serial error/close handling, reconnect backoff, `_closing` races, backlog caps, bounded-write timeouts.
- Connection constructor runtime re-validation (imported/hand-edited flow JSON bypasses the editor — DESIGN 5.5.6).
- Queue-full, coalescing, age-promotion, clampPriority, strictIdArray, route-table validation.
- Editor-default fallbacks (`config.command || 'arm'` etc.) — reachable via import/API-created flows; not schema-migration shims.
- `FRAME_FALLBACK` (setpoint.js:78-86) — `minimal` dialect defines no MAV_FRAME enum.
- Mission v1-magic detection, IN_PROGRESS latching, stale-ACK carve-out (#145), mission_type 255 pre-rejects.
- `dialectChainNames` try/catch, `getMessageClass` exact-case fallback — reachable via custom XML.
- editor-api manifest guards (hand-editable disk state); RED.auth/settings/events fallbacks (MockRED).
- Spec-constant tables (MISSION_TYPE_NAMES, MAV_RESULT_*, INT_PARAM_TYPES, payload verb tables, MAV_COMP_ID subset, LANDED_STATE names) — deliberate dialect-independent constants / published contract naming; swapping for dialect enum lookups would couple pure protocol logic to dialect metadata.
- Hand-rolled malformed frames in tests — node-mavlink correctly refuses to produce them.

## Suggested execution order

1. Test scaffolding S2 → S1 → S3 (mechanical, ~550–850 lines, no production risk).
2. Tier 1-A delivery-mode consolidation across the 4 action nodes (~68 lines, one repeated pattern).
3. Tier 1-B workflow sysid re-checks (~25 lines + test fixture cleanup).
4. Tier 1-C/D/E/F dead guards file-by-file, deleting pinned tests alongside.
5. Tier 3 duplication extractions.
6. Tier 2 contract-narrowing removals, one module at a time, each with a decision note (each has a unit test asserting the guard).
7. Re-run `npm test` and `npm run lint` after each step.

Totals: ~**1,000–1,250 lines** removable (~300 production + ~700–950 test) of ~44k, without touching any reachable wire/input handling. The codebase is already lean; there is no big structural node-mavlink rewrite left to do.
