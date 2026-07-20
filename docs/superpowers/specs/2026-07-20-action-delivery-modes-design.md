# Action-node delivery modes — design (#207)

**Status:** design approved; implementation held pending implementation plan.
**Issue:** [#207 — Make action-node delivery modes explicit and consistent](https://github.com/cmc0619/node-red-contrib-mavlink-ai/issues/207)
**Scope decision:** pre-1.0 **clean break**. No migration/compat machinery — ambiguous or
incomplete legacy configs **fail closed** with a clear error for the Node-RED admin to fix.

## Problem

The action palette exposes three inconsistent, mostly-implicit delivery models, and a single
overloaded output whose meaning changes with a checkbox:

- **Command / Fanout** build a `mavlink/send` envelope by default, but send directly when
  await-ACK is enabled.
- **Move / Payload** send directly whenever a connection is selected; otherwise they build.
  On the direct fire-and-forget path they emit **no** message at all — only a status badge.
- **Mission / Param** always run a direct, connection-driven protocol workflow.

Consequences: the same output port can mean an outbound message, an ACK, a dry-run, or an
error; flipping a checkbox silently changes what a wire carries; a `command/ack` fed into
**MAVLink Out** is handed to the codec and fails with no clear reason (Out only special-cases
`mavlink/error`, which it silently drops).

## Locked decisions (from brainstorming)

1. **Pre-1.0 clean break.** Supersedes the earlier "defer post-1.0" triage.
2. **Explicit Delivery dropdown** as the mode selector (not implicit connection-presence),
   because legibility / avoiding user confusion is the priority.
3. **Two-port shape `[out, error]`** per action node (Direction A). Port 0 carries the node's
   product — the `mavlink/send` build envelope in Build mode, the result/ack in Send modes — and
   is **relabelled per mode** in the editor; the error port is always last. No dead ports.
   Chosen over a 3-port `message`/`result`/`error` layout (which left one primary port inert per
   mode) and over splitting builder/transactor into separate node types.
4. **MAVLink Out uses a positive allowlist.** It encodes only what it can legitimately send;
   everything else is rejected with a clear diagnostic. This is what keeps the mode-typed port 0
   safe — a result mis-wired into Out is caught loudly, not silently encoded.
5. **No migration.** Fail closed with a clear config error rather than silently adapting old
   configs. (Consciously overrides issue AC "preserve existing flows through migration
   defaults" — correct for a pre-1.0 driver.)

## The unified model

**One mental model:** *port 0 is the node's product; the error port is always last.* What port 0
carries is stated by the explicit Delivery dropdown and by port 0's live label — never a hidden
side effect.

### Delivery control vocabulary

A single, consistently-named **Delivery** dropdown replaces the implicit
`awaitAck`-checkbox / connection-presence / `stream`-checkbox logic on the applicable nodes:

- **Build only** — construct the message and emit `mavlink/send` on port 0. No connection.
  This is the default; it hides the connection field entirely.
- **Send via connection** — send directly through the selected connection; emit a structured
  result on port 0 (makes today's silent fire-and-forget observable).
- **Send & await result** — transactional; emit the ack/result on port 0.

Node-specific refinements live outside the Delivery vocabulary:

- **Move** replaces "Send & await result" (setpoints have no ACK) with **Stream via connection**
  — a continuous-retransmit send mode.
- **Fanout** keeps **Dry-run** as its own checkbox (orthogonal preview), plus its existing
  fanout/broadcast mode and spacing controls.

### Port contract

Applicable action nodes (Command/Move/Payload/Fanout) have **2 outputs: `[out, error]`**.
Port 0 (`out`) fires in every mode; port 1 (`error`) fires on failure in any mode. Neither is
ever dead. Port 0's label updates with the Delivery mode.

| Node | Delivery options | Port 0 `out` (by mode) | Port 1 `error` |
|---|---|---|---|
| **Command** | Build only · Send via connection · Send & await result | Build → `mavlink/send`; Send → send-confirm; Await → `command/ack` | error |
| **Payload** | Build only · Send via connection · Send & await result | Build → `mavlink/send`; Send → send-confirm; Await → `command/ack` | error |
| **Move** | Build only · Send via connection · **Stream** via connection | Build → `mavlink/send`; Send → send-confirm; Stream → stream lifecycle | error |
| **Fanout** | Build only · Send via connection · Send & await result | Build → per-target `mavlink/send`; Send → aggregate summary; Await → `swarm/ack` | error |

The **workflow nodes** are inherently transactional and have a distinct **progress** stream, so
they keep **3 outputs `[result, progress, error]`** — none of which is ever dead:

| Node | Delivery | Port 0 `result` | Port 1 `progress` | Port 2 `error` |
|---|---|---|---|---|
| **Mission** | *(fixed transactional — no dropdown)* | result | progress | error |
| **Param** | *(fixed transactional — no dropdown)* | result | progress | error |

**Invariant across the whole palette:** the **error port is always the last port** (index 1 on
the 2-port nodes, index 2 on the workflow nodes).

**Why the mode-typed port 0 is safe here** — the exact hazard #207 warns about (a build envelope
and a result sharing one wire, and an ACK reaching MAVLink Out) is neutralised three ways: the
Delivery mode is an **explicit dropdown** (not a hidden checkbox); port 0's **label tracks the
mode** on the canvas; and the **MAVLink Out allowlist** rejects any non-`mavlink/send` payload
with a diagnostic, so a result reaching Out fails loudly instead of silently encoding.

**Why Mission & Param keep 3 ports and no Delivery dropdown:** a mission download or a param read
is a multi-message *handshake* (request → items → ack) with genuine progress, not a single
`mavlink/send` envelope you can hand to MAVLink Out. They cannot "build," so their connection
stays **required** and they retain `result / progress / error`.

### Per-node delivery detail

**Command** (`nodes/mavlink-ai-command.*`)
- Build only → `msg.topic = 'mavlink/send'`, `payload = { name: 'COMMAND_LONG'|'COMMAND_INT',
  target_system, target_component, vehicleProfile, vehicleProfileName, fields, localIdentity? }`,
  `priority` stamped for critical commands, on port 0.
- Send via connection → direct `connection.send(...)`; on success emit
  `{ topic: 'command/sent', payload: { name, target_system, target_component, sent: true } }`
  on port 0 (NEW capability — command has no fire-and-forget today).
- Send & await result → existing `CommandSend` workflow; COMMAND_ACK on port 0.
- Errors → port 1 via `makeFail`.

**Payload** (`nodes/mavlink-ai-payload.*`)
- Build only / Send via connection / Send & await result as above. "Send & await result" applies
  to `COMMAND_LONG` verbs; message verbs (e.g. gimbal-manager) under a send mode degrade to
  Send-via-connection semantics (fire-and-forget with a send-confirm result on port 0).

**Move** (`nodes/mavlink-ai-move.*`)
- Build only → `mavlink/send` on port 0.
- Send via connection → one-shot direct `connection.send(...)`; structured `move/sent` result on
  port 0.
- Stream via connection → continuous retransmit on a timer (existing stream engine, TTL /
  `maxStreamSeconds` from #216); stream lifecycle (`move/stream` `{ stream: 'expired' }`) on
  port 0, per-streak send failures on port 1.

**Fanout** (`nodes/mavlink-ai-fanout.*`)
- Build only → per-target `mavlink/send` messages on port 0 (array emit / paced by `spacingMs`).
- Send via connection → send every decorated target directly; aggregate send summary on port 0
  (NEW — fanout has no non-await direct path today).
- Send & await result → existing per-vehicle `CommandSend` aggregation (`swarm/ack`) on port 0.
- **Dry-run** stays a separate checkbox: emits `swarm/dryrun` preview on port 0, sends nothing.
- fanout/broadcast mode and concurrency/spacing/stopOnError unchanged.

**Mission** (`nodes/mavlink-ai-mission.*`) and **Param** (`nodes/mavlink-ai-param.*`)
- Unchanged delivery semantics (always transactional, connection required). Retain
  `result / progress / error` ports. `clear`'s `wait_ack` sub-option unchanged.

### MAVLink Out — positive allowlist (`nodes/mavlink-ai-out.*`)

Out has no outputs; it encodes and transmits. New rule:

- **Accept** (encode + send) only:
  - `msg.topic === 'mavlink/send'` → `connection.send(msg.payload, { priority })`.
  - `msg.topic === 'mavlink/raw'` or `Buffer.isBuffer(msg.payload)` → `connection.sendRaw(...)`.
- **Reject** everything else — `command/ack`, `command/sent`, `move/sent`, `move/stream`,
  `swarm/ack`, `swarm/dryrun`, `mission/*`, `param/*`, `vehicle/*`, `mavlink/error`, or any
  unrecognized topic — with a structured diagnostic via `done(err)` and a red badge. The message
  names the offending topic and states it looks like a result/ack/error, not an outbound message,
  and to wire MAVLink Out from a node in **Build only** mode.
- This changes today's behavior of silently dropping `mavlink/error`: it is now rejected with a
  diagnostic (louder, but honest — an error envelope should never be wired into Out).

Robustness rationale: a positive allowlist auto-rejects any *future* result topic with no
denylist to maintain, and it is the backstop that makes the mode-typed port 0 safe.

### Fail-closed (no migration)

- **Delivery unset** (e.g. a node deployed before this change, with no `delivery` value) →
  config error "Delivery mode not set"; red badge; nothing sent; error on port 1 at first input
  (and a deploy-time badge). The admin sets the mode explicitly.
- **Send / Send & await with no connection** → `NO_CONNECTION` error (unchanged).
- **Await on broadcast target 0** → `BROADCAST_NO_ACK` (unchanged).
- No automatic wire/config migration is attempted. Release notes call out the clean break and
  the output-count change (single-output action nodes go 1 → 2 ports).

## Architecture & shared helpers

Reuse the existing seams rather than restructure:

- `lib/util/node-errors.js` `makeFail(...)` — the single error-exit closure. The action nodes
  move to `outputs: 2, errorIndex: 1`; mission/param keep `outputs: 3, errorIndex: 2`.
- `lib/command/command-workflow.js` `CommandSend` — the shared send-and-wait engine for the
  await paths (command/payload/fanout), unchanged.
- `lib/util/node-lifecycle.js` `watchConfigBadge(...)` — connection/profile badge resolution;
  `connectionRequiredWhen` now keys off the Delivery mode (required in send modes) instead of the
  `awaitAck` checkbox.
- `connection.send(...)` / `connection.sendRaw(...)` / `resolveOutboundIdentity(...)` — the direct
  send runtime API, unchanged.

New/changed surface:

- A small shared helper for the **Delivery** editor control (dropdown markup + `oneditprepare`
  show/hide of the connection field + **port-0 label update** per mode), so all four action nodes
  present it identically. Candidate: a shared editor resource (mirrors how #212 proposes to share
  the dialect picker).
- A shared runtime helper that maps `(delivery, node)` → the branch to run and always emits the
  node's product on port 0 and errors on the error port, so each node's input handler stays small
  and the port contract is uniform.

## Error handling

- Config-level (delivery unset, no connection when required) → structured error on the error
  port + red badge; `done()` (not `done(err)`) so a Catch node does not double-fire — consistent
  with `makeFail` today.
- Runtime send/await failures → `mavlink/error` payload on the error port.
- MAVLink Out rejects non-outbound envelopes via `done(err)` (it has no output port).

## Testing

Per issue AC "editor/runtime tests for every delivery-mode transition and its output topic(s)":

- **Editor:** each Delivery value shows/hides the connection field correctly and relabels port 0;
  Build only hides connection; Move's Stream and Fanout's Dry-run controls appear only in the
  right modes.
- **Runtime, per action node:** Build only → `mavlink/send` on port 0; Send via connection →
  structured send-confirm on port 0 (the now-observable fire-and-forget); Send & await result →
  ack/result on port 0; every failure → error on port 1.
- **Move:** Stream lifecycle (start, TTL expiry `{ stream: 'expired' }`, per-streak send error)
  on the correct ports.
- **Fanout:** Build only array-emit / spacing; Send via connection aggregate; Send & await
  aggregate `swarm/ack`; Dry-run `swarm/dryrun`.
- **MAVLink Out allowlist:** accepts `mavlink/send` and raw/Buffer; rejects `command/ack`,
  `command/sent`, `swarm/ack`, `mission/*`, `param/*`, `vehicle/*`, `mavlink/error`, and an
  unknown topic, each with the structured diagnostic (and no send).
- **Fail-closed:** a node with no `delivery` set surfaces the config error and sends nothing.

## Documentation

- Update each node's help panel to the single mental model (Delivery dropdown + port 0 product +
  error port last).
- Update examples to wire MAVLink Out only from a Build-only node.
- Add a README "Delivery models" section (folds in / replaces the plain three-models note the
  earlier #207 triage deferred to the #14 publish pass).

## Out of scope

- Migration/compat shims (explicitly dropped — pre-1.0 clean break).
- The four-signal observability surface (#205), control-coupling (#216), identity rework (#195).
- Restructuring the connection monolith (#226).
