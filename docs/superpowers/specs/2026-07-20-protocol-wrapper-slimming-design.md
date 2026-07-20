# Protocol Wrapper Slimming Design

## Goal

Make the protocol-value migration thinner without changing what users can do.
This repository should describe Node-RED behavior and workflow policy;
`node-mavlink` and the active dialect should continue to own MAVLink names and
numbers.

The current pull request is net `+162` shipped lines across `lib/`, `nodes/`,
and `examples/`. The slimming pass must materially reduce that number while
preserving every runtime and editor behavior introduced by the migration.

## Constraints

- Preserve all runtime behavior, editor conveniences, custom-dialect support,
  error codes, and structured error context.
- Preserve the clean break: no aliases, numeric-string fallbacks, deprecation
  compatibility, or flow migration code.
- Preserve explicit numeric custom/dialect-external values only on the existing
  generic or advanced/raw interfaces.
- Do not move transport, routing, queue, subscription, codec-workaround, or
  workflow state-machine ownership into `node-mavlink`.
- Keep the existing public Node-RED message shapes and editor endpoints.
- Make changes in small independently testable commits.

## Design

### Bind protocol context once

`lib/protocol/protocol-values.js` will expose one small bound resolver. A caller
supplies the active enum index, dialect name, and consumer name once. The bound
resolver then looks up members and lists enum choices without requiring every
call to rebuild the same error context.

The resolver remains a thin adapter over the generated enum index. It will not
cache a second set of MAVLink assignments, invent names, normalize input, or
provide fallback numbers.

Core values will use the same API bound to the public `node-mavlink` core
mappings. Active-dialect consumers will bind the profile's merged enum index.

### Replace repeated consumer glue

Payload, mission, swarm, parameter, move, command, and mode code will bind once
per operation or object, then ask the bound resolver for exact generated member
keys. Friendly-to-member policy tables may remain because they are product UX;
their numeric values must not.

Batch construction will use concise standard JavaScript mapping rather than a
new schema language. The goal is less custom abstraction, not a larger internal
framework.

### Consolidate editor dialect handling

`lib/editor-api.js` currently repeats dialect query parsing, custom-path
handling, bundle validation, and structured error serialization. Small local
helpers will perform those operations once for the modes and parameter-choice
routes.

The existing `/mavlink-ai/protocol-values` endpoint, payload component choices,
Local Identity defaults, and detailed editor errors remain unchanged.

### Keep tests readable without reducing coverage

Tests may define short constants or fixture helpers whose values come directly
from public generated exports. This removes repeated long expressions and line
wrapping, but does not merge behavior cases or weaken assertions.

Byte-level golden tests and explicit raw-numeric escape-hatch tests remain
numeric where the number itself is the subject of the test.

## Data and error flow

1. A Vehicle Profile loads a dialect and its merged generated enum index.
2. A consumer binds that index with its dialect and consumer names.
3. The consumer requests an exact enum member key.
4. The adapter returns the generated numeric value.
5. A missing enum or member throws the existing `ENUM_VALUE_UNAVAILABLE` error
   with the same enum, member, dialect, and consumer context.

No fallback or alternate spelling is attempted at any step.

## Baby-step delivery

1. Add the bound resolver and prove exact lookup/error behavior.
2. Migrate one consumer group at a time, running its focused tests after each.
3. Consolidate editor route handling without changing responses.
4. Shorten only the generated-value test fixtures touched by this work.
5. Re-run the production assignment audit and full verification suite.
6. Compare shipped line counts against both `main` and the current PR head.

Each step should delete more repeated shipped code than it adds. If an
abstraction does not reduce code or make protocol ownership clearer, it should
not be kept.

## Verification

- Focused tests after each consumer migration.
- `npm.cmd test`
- `npm.cmd run lint`
- `git diff --check`
- Production copied-assignment audit from the original migration plan.
- Final `git diff --numstat main...HEAD` grouped into shipped code, tests, and
  documentation.

Success means identical functionality, no compatibility behavior restored, a
clean worktree, and a materially smaller shipped-code delta than `+162`.
