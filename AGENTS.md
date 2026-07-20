# Agent Instructions

This repo is a clean v2 architecture for a Node-RED MAVLink module.

Follow `DESIGN.md` first. Do not recreate the old coupled architecture.

## Hard rules

1. Do not put dialect selection inside a transport-only node.
2. Do not make a UDP port equal a vehicle.
3. Do not use global singleton parser/connection/dialect state.
4. Do not import `serialport` at module startup.
5. Do not require `serialport` for UDP or TCP usage.
6. Do not bury mission workflow state inside the transport layer.
7. Do not add cross-version migration logic, back-compat fallbacks, or
   deprecation shims for config/schema changes unless explicitly requested. This
   is pre-1.0, dev-only software with no installed base — make clean breaks. When
   a field or feature moves, remove it from its old home entirely rather than
   keeping a fallback or warning path. (This targets legacy/older-version
   compatibility only — preserving compatible saved values *within the current
   schema*, e.g. keeping fields that still apply when switching transports, is
   fine and expected.)
8. Keep node type names under the `mavlink-ai-*` prefix.
9. Comments. Use JSDoc (`/** ... */`) to document what a reader needs in order to
   *use* a thing — exported functions and classes, public runtime methods,
   config/message schemas, non-obvious state machines, and safety-sensitive or
   tricky MAVLink behavior. Ordinary `//` line comments are fine for short inline
   notes explaining *why* a specific line is the way it is. Keep comments useful
   and current; don't add empty boilerplate to trivial one-liners. See
   DESIGN.md §27.1.
10. Do not write code for states that cannot occur. Trust the system's own
    invariants — no defensive re-checks, no "just in case" fallbacks for a
    condition an upstream boundary already guarantees. If an impossible state
    somehow occurs, let it fail loud (throw) rather than silently substituting a
    value. Every branch must handle a state that can *actually* happen. This
    targets impossible states only — real *runtime* inputs (malformed user XML,
    dropped sockets, wire garbage, a `msg` naming a bad profile) are not
    "impossible" and stay fully handled. But a deployed Node-RED flow has already
    validated its config-node wiring: at runtime a referenced Vehicle Profile /
    connection / Local Identity is present and valid *by assumption* — do not
    re-check it. A broken flow either won't deploy or shouldn't run; if it runs
    and crashes, the crash is the correct signal, not a bug to paper over with a
    polished error. (Distinguish deploy-time config, which is trusted, from
    runtime message content, which is validated.) Example: a workflow resolves enum
    values strictly from the profile's loaded dialect
    (`bindEnumValues(this.enums)`) and throws `ENUM_VALUE_UNAVAILABLE` if the
    index is ever bad — it does *not* fall back to a core bundle, because a
    broken dialect already fails closed at the connection boundary
    (`mavlink-ai-connection.js`). (Dialect-*independent* values — command
    results, vehicle classification, base_mode — may still resolve from the core
    defs via `coreEnumValues`; that is not a fallback but the correct source for
    values every dialect shares.)

## Review & design discipline

Lessons that keep recurring — read these before reacting to a review or adding a
guard:

1. **Review bots are advisory, not authoritative.** CodeRabbit / Codex /
   Greptile apply generic heuristics that do not know this repo's invariants.
   Weigh each finding against these rules and the code's own guarantees before
   acting. Several bots flagging the same thing is one heuristic repeated, not
   independent confirmation. When a bot's fix conflicts with a rule here — e.g.
   "add a null guard" for a state Rule 10 says can't occur — decline it and say
   why on the PR; do not implement on reflex.
2. **A broken flow is a deploy error, not a runtime input.** Do not add runtime
   handling (guards, structured errors, fallbacks) for config the operator
   broke — a deleted profile, a dangling connection ref. That is Rule 10. Trust
   the invariant and let it crash; the crash is the honest signal. Only genuine
   runtime inputs (a `msg`'s contents, wire bytes, user XML) get validated.
3. **Apply an invariant uniformly; don't carve out edge exceptions.** If
   "profile is valid at runtime" holds on the send path, it holds on the observe
   path too. An edge-case exception ("tolerate null *here* because…") is usually
   the same impossible-state defense wearing a new hat. Resist the reflex to
   hunt for one more thing to guard.
4. **Prefer deletions.** The best fix is usually less code. If a change adds
   branches, re-check whether it is defending a state that can actually happen.

## Architecture

```text
Local Identity  = who Node-RED transmits as (source ids, heartbeat identity)
Vehicle Profile = target vehicle: dialect, firmware, vehicle family, defaults
Connection      = transport/session/resource owner (incl. signing)
Route           = sysid/compid to Vehicle Profile mapping
Nodes           = flow-visible behavior
```

## Preferred implementation order

```text
profile -> protocol -> connection -> UDP -> in/out -> build/filter -> command -> mission -> serial -> TCP
```

## Serial dependency pattern

Bad:

```js
const { SerialPort } = require('serialport');
```

Good:

```js
function loadSerialPort() {
  try {
    return require('serialport');
  } catch (err) {
    throw new Error(
      "Serial transport requires optional dependency 'serialport'. Install it or select UDP/TCP transport."
    );
  }
}
```

## Pull request review workflow

Automated reviewers (Codex, CodeRabbit) review on PR open, ready-for-review, or
an explicit re-review command — a plain push does **not** re-trigger them. After
pushing fixes that address an automated reviewer's findings, always request a
fresh pass so the reviewer can confirm the fixes against the new commit:

- Codex: comment `@codex review` on the PR.

Do this automatically after each fix push; do not wait to be asked.

## Test expectation

At minimum, keep this passing:

```bash
npm test
```

Add real tests as implementation fills in.
