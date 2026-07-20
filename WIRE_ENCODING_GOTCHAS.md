# Wire-Encoding Gotchas & Mitigations

> A field guide to the recurring, expensive bugs in this project — the ones
> that cost real compute and review time before we found them. Written for the
> next builder (human or LLM) doing a clean implementation. Read it **before**
> writing any node that turns a user value into MAVLink bytes.
>
> The single biggest lesson: **JavaScript's number model and MAVLink's exact
> binary wire format disagree, and JavaScript loses silently.** JS has one
> number type (a 64-bit float), signed 32-bit bitwise operators, no native
> unsigned or 64-bit integers, and a `NaN`/`Infinity` that don't survive naive
> code. MAVLink demands exact-width integers, reserved sentinel values, and
> correct framing. Almost every bug below is a place where JS produced a
> *wrong-but-plausible* byte and MAVLink faithfully acted on it.

## How to read this list (for the next builder)

**Treat every entry as a prediction, not a warning.** Be precise about what
these are, because overstating them costs the reader's trust: every entry is a
real defect that existed in this project's code and was caught in **review or
reasoning** — *not* a failure anyone observed on real hardware, and *not*
cosmic-bit-flip paranoia either. They sit in the boring middle. The honest,
narrower claim is still worth acting on: the code *would* emit the wrong bytes
if that path ran, on ordinary input (a blank field, an imported flow, a
high-bit bitmask, an unconfigured route). Throughout this doc, "what bites" and
"real bug" mean *the defect the code contained*, not a logged incident — most
were fixed before anything was ever connected to a vehicle. They matter because
the output actuates a vehicle, so you want them gone before first connection,
not after.

If you implement the build spec straight through, you are **likely to
reintroduce most of these**, because they live in the *seams between the tools*
(JS's number model, Node-RED's editor lifecycle, MAVLink's framing), not in
careless code. So before you write each node: find the entries that touch it,
write the failing test first, then implement. That converts this from a
post-mortem into a checklist you clear as you go.

Two root themes explain the bulk of them:

1. **The numeric seam (~1 in 4 fixes):** JS's loose numbers vs MAVLink's exact
   bytes — signs, `NaN`, `char[]`, unions. Section A.
2. **Silent leniency (~1 in 2 fixes):** a lenient default quietly did something
   plausible instead of failing loudly — "empty" meant "everyone," state lived
   wherever was convenient, cleanup didn't happen. Sections B and C.

## The one structural rule that prevents most of this

Roughly **1 in 4 bug-fix commits** (about 1 in 5 across *all* commits — bug-fix
and non-bug-fix together) lived on the JS→wire seam, and they recurred because
each node did its own number handling. The fix is not "be
careful" — we tried that and it failed 14 times. The fix is structural:

1. **One wire-boundary module.** Every JS→bytes and bytes→JS conversion goes
   through a single, type-aware codec that knows each field's MAVLink type
   (`uint8`, `int16`, `uint32`, `float`, `char[]`, bitmask) from dialect
   metadata. Nodes never do their own `<<`, `>>>`, `parseInt`, or `Number()`
   on a wire value. Fix a rule once; every node inherits it.

2. **Round-trip tests *and* golden-byte vectors, over every field type.** A
   round trip is necessary but not sufficient. Assert `encode(decode(x))`
   reproduces the field value `x` (and `decode(encode(v))` reproduces `v`) for
   representative and random values of each type — but a round trip only proves
   `encode` and `decode` are inverses *of each other*, so a **symmetric** bug
   (both directions using the same wrong byte order or padding) passes while
   emitting wire-incompatible bytes. So **also** pin canonical **payload-byte
   vectors** (a known input → its known-good MAVLink bytes) or cross-check
   against an independent decoder. Mind the layer: don't byte-compare whole
   *frames* — sequence numbers, signatures, and timestamps legitimately vary
   between encodes, giving false failures an implementer then "fixes" by
   loosening the assert — but the *payload* bytes are stable and must match the
   spec, so byte-check those. For the value comparisons, do **not** use raw
   `===`: the `NaN` sentinel fails `NaN === NaN`, and float fields narrow to
   IEEE float32 so an arbitrary JS double won't be strictly equal after a round
   trip. Compare with `Object.is`/`Number.isNaN` for sentinels, at float32
   precision for floats, and exact equality for integers. Together these catch
   the sign, `NaN`, `char[]`, and overflow families *automatically*, before they
   ship. Prefer a property-based generator (thousands of random inputs) over
   hand-picked cases.

Everything below is what that module and that test must get right.

---

## A. Numeric / wire-representation gotchas (the big category, ~14 bugs)

### A1. Signed vs unsigned integer width
**What bites:** MAVLink `uint8`/`uint16`/`uint32` fields are unsigned; JS math
and JSON are signed. `-1` stored in a `uint8` should be `255`; read back
carelessly it stays `-1`. A `uint32` value above 2^31 reads as negative.
**Real bugs:** `#242 unsigned 32-bit bitmask math`, param corruption `#146`.
**Mitigation:** In the boundary module, convert per the field's declared type.
**Validate the original value first:** reject non-integers and anything outside
the field's min/max from metadata, failing closed — never normalize before you
check. `value >>> 0` silently *wraps* out-of-range input (`4294967296` → `0`,
`-1` → `4294967295`), which would make a later range check pass on a value the
user never sent. Reserve `>>> 0` for normalizing an already-validated bitwise
result or a signed decode, not for sanitizing input.

### A2. Bitwise operators are secretly signed 32-bit
**What bites:** JS `&`, `|`, `^`, `<<`, `>>` coerce operands to **signed**
32-bit. `1 << 31` is `-2147483648`, not `2147483648`. Any bitmask with the top
bit set (common in MAVLink mode/type masks) comes out negative and corrupts the
packet. This surprises even seasoned C programmers — C doesn't do this.
**Real bug:** `#242 unsigned 32-bit bitmask math throughout the Command editor`.
**Mitigation:** After any bitmask assembly, apply `>>> 0`. Build masks in the
boundary module, never inline in a node. Add a round-trip test for a mask with
bit 31 set.

### A3. `NaN` is a real MAVLink signal in the fields that define it
**What bites:** In specific fields, MAVLink uses `NaN` to mean **"keep current /
ignore this field"** (e.g. unused position-target axes, "don't change this
param", gimbal-manager rates). `JSON.stringify(NaN)` is `null`; naive code turns
it into `0` and commands the *wrong thing* (go to altitude 0, set rate 0).
**Real bugs:** `#187 reversible NaN/Infinity for floats`, `#173 preserve NaN
"keep current" params`, `send NaN for unused gimbal-manager rates`,
`NaN takeoff defaults`.
**Mitigation:** Two separate rules — don't conflate them:
- **Preserve** `NaN`/`Infinity` losslessly for *every* float field: never round
  a wire float through `JSON.stringify`/`parse`, never coerce to `0`/`null`.
  This is universal.
- **Interpret** `NaN` as "keep current" **only** where that field's MAVLink
  semantics define it — it is a per-field convention, not a global one. For an
  arbitrary float field, `NaN` is simply an invalid value; validate/reject it.
  Treat "field omitted" and "field = NaN sentinel" as first-class, distinct
  from `0`, in the fields where the sentinel applies.

### A4. Float32 int/float unions (PX4 parameters)
**What bites:** A `PARAM_VALUE` is a 32-bit slot that may carry an **integer bit
pattern reinterpreted as float**. Numerically casting it to a JS number
corrupts the value; writing back the wrong type corrupts the parameter on the
vehicle.
**Real bugs:** `#146 param corruption`, `exact param echo matching`.
**Mitigation:** Detect the parameter's declared type **before** a write.
Reinterpret the 4 bytes (bit-level), don't numerically convert. Echo-match the
value the vehicle reports back to confirm the write took.

### A5. Blank / empty / zero / missing are four different things
**What bites:** `""`, `0`, `undefined`, and "field absent" get conflated. An
empty editor field zero-filled into a position target means "fly to (0,0,0)."
An explicit `0` coordinate is a *valid* command and must not be dropped.
**Real bugs:** `#235 reject blank/NaN active setpoint fields for every
frame/mask`, `explicit-zero coords`, `blank-aware goto yaw`.
**Mitigation:** Distinguish "user left it blank" from "user typed 0." Blank in an
*active* field fails closed with a clear error; explicit `0` passes through
unchanged. Never auto-zero-fill an absent field into an origin command.

### A6. `char[]` fields are text, not numbers or enums
**What bites:** Fixed-length character arrays (e.g. param IDs, status text) got
run through enum/number resolution and mangled.
**Real bug:** `#157 never enum/number-resolve char[] field values`.
**Mitigation:** The boundary module branches on field type. Strings stay
strings: Latin-1 only, pad/truncate to the declared length, no numeric coercion.

### A7. Numeric fields arrive from the editor as strings
**What bites:** HTML inputs hand you `"1.5"`, not `1.5`. Needs parsing *and*
validation; a bare `parseInt` drops decimals, a bare `Number("")` yields `0`.
**Real bugs:** `#169 accept decimal strings on float fields`, `#189 name the
field on out-of-range / non-Latin-1 encode errors`.
**Mitigation:** Parse and range-check at the boundary, with the **field name** in
any error so the user can fix it. Reject non-finite/out-of-range input closed.

---

## B. Adjacent expensive categories (worth the same treatment)

These aren't sign bugs, but they were costly and share the theme: *a lenient
default silently did the wrong thing.* Included so the next builder gets the
whole map.

### B1. State lived on the wrong node (the "signing" saga)
**What bites:** Signing sequence, timestamp, replay memory, and link ID were
attached to Local Identity when they belong to the **Connection/channel**. One
misplacement cascaded into several bugs.
**Real bugs:** `move signing to Connection`, `register connection credential`,
`clear hidden requireSignature`.
**Mitigation:** Fix state ownership on day one (see build-spec §3.3 table). Ask
"whose lifecycle does this state share?" before choosing where it lives.

### B2. Fail-open defaults on missing/malformed input
**What bites:** Empty route table routed to everyone; malformed mission items
triggered an implicit clear; several validation gaps let bad input through.
**Real bugs:** `#168 empty route table fails closed`, `#236 mission upload fail
instead of implicit clear`, `swarm fail-closed on invalid groups`, the five
fail-open gaps in the Codex audit.
**Mitigation:** Missing/ambiguous/malformed input fails closed with a stable
error code + repair instruction. Runtime validation is authoritative — imported
flow JSON bypasses the editor. Never let "empty" mean "all."

### B3. Lifecycle: cleanup, locks, and error handlers
**What bites:** Unbounded writes, locks released twice or not at all, `error`
handlers removed during `stop()` causing `uncaughtException`, subscribers
sharing a mutable decoded payload.
**Real bugs:** `#237 bound writes + settle in-flight on clear`, `#185 release
lock once via finally`, `#149 keep error handler through stop`, `#158 clone
payloads per subscriber`.
**Mitigation:** Release locks in `finally`. Keep error handlers attached through
teardown. Clone per-subscriber data. Bound every queue and write.

### B4. Protocol-version & framing fidelity
**What bites:** Mixing up MAVLink v1/v2 changes which fields exist.
**Real bugs:** `#167 mission NAK/REQUEST_INT/stale-ACK handling`.
**Mitigation:** Consult the official MAVLink spec for framing/ACK rules —
don't reconstruct them from memory. Outbound frames are always MAVLink 2
(inbound v1 frames still decode as read-only telemetry), so there is no
wire-magic version detection to get wrong.

---

## C. Operational gotchas (scheduling, editor state, routing)

Lower-frequency than A and B (~16% of fixes combined) but each cost a real
debugging session. Same theme as B: a convenient default did the wrong thing
quietly.

### C1. Queue scheduling: background traffic starves the important traffic
**What bites:** Two opposite failure modes. A sustained flood of *higher*-
priority traffic can park the background heartbeat band forever (tripping a
vehicle's GCS-loss failsafe) — but the age-based promotion you add to fix that,
if unclamped, can float a stale low-priority send ahead of a fresh
emergency/arm/mode command. Un-coalesced periodic sends (heartbeats) also pile
up behind a slow transport.
**Real bugs:** `age promotion + heartbeat coalescing so background band can't
starve (#150)`, `clamp age promotion so aged sends never outrank the emergency
band`, `honor Infinity age opt-out`.
**Mitigation:** Give every send an explicit priority band. Let an aged
low-priority item age *up through the non-emergency bands* — that promotion is
the anti-starvation mechanism, so don't disable it — but **clamp** it so it can
never cross into the emergency/protected band (floor it one band above
emergency; a same-band clamp still loses on an age tie-break). Coalesce periodic
sends per identity. Offer an opt-out (`Infinity`) for "never promote this."

### C2. Editor↔runtime state sync: stale UI and clobbered values
**What bites:** The Node-RED editor caches config. Derived UI (validity badges,
dropdowns) goes stale after a redeploy or a fix — an "invalid profile" badge
stays red after the profile is repaired; catalog dropdowns are empty until an
unrelated field is chosen. Worse, a late async metadata load can overwrite a
valid saved value with empty config.
**Real bugs:** `refresh the "invalid profile" badge on redeploy (#161)`, `make
missing-connection / invalid-profile badges consistent and live (#165)`, `param
node auto-load the catalog so dropdowns work without a vehicle`.
**Mitigation:** Recompute derived UI state on **every** redeploy, not just first
load. Load metadata catalogs eagerly enough that dropdowns work before all
dependencies are picked. A late menu-load callback must **merge**, never
overwrite a persisted value (build-spec §3.2).

### C3. Routing & peer selection: one socket is not one vehicle
**What bites:** One UDP port is one socket that can hear many systems. Before a
peer is learned there is no destination — naive code error-spams ("no peer
yet") or picks the wrong learned peer. An untargeted/broadcast send can let a
non-vehicle component (a GCS) grab the fallback target slot meant for the
vehicle.
**Real bugs:** `Out node: hold "no peer yet" sends in a waiting state instead of
error spam (#247)`, `udp-peer: fan out broadcast/untargeted sends and stop a GCS
stealing the fallback (#184)`.
**Mitigation:** Model peers as learned-over-time. When there is no known peer,
badge the connection "waiting for link" and warn **once** instead of erroring on
every send — but **drop** the individual send (there is nowhere to deliver it);
do **not** queue it, or a command sent now gets delivered stale to whatever peer
is learned later. Sending resumes automatically once the link is ready. For
untargeted sends, fan out to learned peers rather than a single stealable
fallback, and never let a non-vehicle component become the default target.

---

## Checklist for the next builder

- [ ] All JS↔wire conversion goes through **one** type-aware boundary module.
- [ ] That module reads each field's type/range/units from dialect metadata.
- [ ] Range-check every integer against metadata and fail closed **before** any
      `>>> 0` normalization (normalizing first silently wraps bad input).
- [ ] `NaN`/`Infinity` preserved losslessly for every float; interpreted as
      "keep current" **only** in the fields whose semantics define it.
- [ ] Blank ≠ 0 ≠ absent; no auto-zero-fill of active command fields.
- [ ] `char[]` handled as text; params type-detected before write.
- [ ] A **round-trip / property test** covers every field type, including a
      bitmask with bit 31 set, a `NaN` sentinel, an int/float param union, and a
      full-length `char[]`. Compare NaN-aware (`Object.is`) and at float32
      precision, not raw `===`. Assert on decoded field values, not
      byte-identical *frames* (seq/signature/timestamp vary) — **but** also pin
      canonical **payload-byte** vectors (or an independent-decoder cross-check)
      to catch symmetric codec bugs a round trip alone can't.
- [ ] State ownership decided up front; missing input fails closed.
- [ ] Priority bands on every send; age promotion clamped so background can
      never outrank emergency; periodic sends coalesced per identity.
- [ ] Derived editor UI recomputed on every redeploy; async menu loads merge,
      never overwrite a saved value.
- [ ] Peers learned over time; no-peer sends wait (surfaced once) instead of
      spamming; untargeted sends fan out, never grab a stealable fallback.
