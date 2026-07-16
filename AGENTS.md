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
9. Use JSDoc (`/** ... */`) in lieu of any other type of comment. Do not use `//`
   line comments or plain `/* ... */` block comments for commentary; the only
   non-JSDoc comments allowed are bare tooling directives (e.g.
   `// eslint-disable-next-line`, coverage pragmas, shebangs). This rule applies
   to new and modified code going forward — it was adopted mid-project, so
   pre-existing `//` comments are grandfathered; convert them when you touch the
   surrounding code, not in bulk sweeps. See DESIGN.md §27.1.

## Architecture

```text
Profile    = MAVLink identity, dialect, defaults
Connection = transport/session/resource owner
Route      = sysid/compid to profile mapping
Nodes      = flow-visible behavior
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
