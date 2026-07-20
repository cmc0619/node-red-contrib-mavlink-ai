# Action-node Delivery Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Command/Move/Payload/Fanout an explicit, consistently-named **Delivery** control and a uniform **2-port `[out, error]`** contract, so what a wire carries is legible and stable; harden MAVLink Out with a positive allowlist.

**Architecture:** Each applicable action node reads one `delivery` config value (`build` | `send` | `await`, plus `stream` for Move) instead of inferring mode from `awaitAck`/connection-presence/`stream`. Port 0 carries the node's product (a `mavlink/send` envelope in Build mode, a result/ack in Send modes); port 1 is always the error output. A shared pure helper resolves and validates the mode (fail-closed). MAVLink Out encodes only `mavlink/send`/raw and rejects everything else with a diagnostic — the backstop that makes the mode-typed port 0 safe. No migration: a node with no `delivery` set fails closed.

**Tech Stack:** Node-RED custom nodes (CommonJS, Node >= 20), `node:test`/`node:assert`, the repo's `test/helpers/mock-red.js` (`MockRED`), ESLint.

## Global Constraints

- Node >= 20, CommonJS; JSDoc uses `/** */` only (never `//`-only doc blocks or plain `/* */`).
- Run **both** `npm run lint` and `npm test` before every commit — `npm test` does NOT run eslint; CI runs `npm run lint` separately.
- Pure `lib/**` modules take no Node-RED/transport dependency and no wall-clock of their own.
- Delivery values are exactly: `'build'`, `'send'`, `'await'` (+ `'stream'` for Move only). No other strings.
- Port contract for the four action nodes: `outputs: 2`; **port 0 = product**, **port 1 = error** (`errorIndex: 1`). Error is always the last port.
- Product topics on port 0: build → `mavlink/send`; command send → `command/sent`; move send → `move/sent`; payload send → `payload/sent`; fanout send → `swarm/sent`; command/payload await → `command/ack`; fanout await → `swarm/ack`; move stream → `move/stream`.
- No migration/compat: a resolved `delivery` that is missing/invalid → structured `DELIVERY_UNSET` error on the error port; nothing sent.
- Mission (`nodes/mavlink-ai-mission.*`) and Param (`nodes/mavlink-ai-param.*`) are **out of scope** for code changes (already transactional, `result/progress/error`, error last). They get doc mentions only (Task 7).

---

## File Structure

- Create `lib/util/delivery.js` — pure mode constants + `resolveDeliveryMode(config)` (throws `DELIVERY_UNSET`). Consumed by all four action nodes.
- Create `test/unit/delivery.test.js` — unit tests for the helper.
- Modify `nodes/mavlink-ai-out.js` — positive allowlist.
- Modify `nodes/mavlink-ai-command.{js,html}` — Delivery control, 2 ports, build/send/await on port 0.
- Modify `nodes/mavlink-ai-payload.{js,html}` — same triad.
- Modify `nodes/mavlink-ai-move.{js,html}` — build/send/stream.
- Modify `nodes/mavlink-ai-fanout.{js,html}` — build/send/await (+ dry-run checkbox retained).
- Modify test files: `test/unit/out-node.test.js` (or the existing Out test file), and each node's existing unit test (`test/unit/command-node.test.js`, etc. — confirm exact names in-repo).
- Modify docs: each node `.html` help panel; `README.md`; `examples/**` that wire action → Out.

---

## Task 1: Shared delivery-mode helper (pure)

**Files:**
- Create: `lib/util/delivery.js`
- Test: `test/unit/delivery.test.js`

**Interfaces:**
- Produces: `DELIVERY = { BUILD:'build', SEND:'send', AWAIT:'await', STREAM:'stream' }`;
  `resolveDeliveryMode(config, { allow })` → one of the allowed mode strings, or throws an
  `Error` with `.code === 'DELIVERY_UNSET'` when `config.delivery` is absent or not in `allow`.
  `allow` is the array of modes a given node supports (e.g. `['build','send','await']`).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DELIVERY, resolveDeliveryMode } = require('../../lib/health/../util/delivery');

test('resolveDeliveryMode returns an allowed mode', () => {
  assert.strictEqual(resolveDeliveryMode({ delivery: 'build' }, { allow: ['build', 'send', 'await'] }), 'build');
  assert.strictEqual(resolveDeliveryMode({ delivery: 'await' }, { allow: ['build', 'send', 'await'] }), 'await');
});

test('resolveDeliveryMode throws DELIVERY_UNSET for a missing mode (no migration)', () => {
  assert.throws(() => resolveDeliveryMode({}, { allow: ['build', 'send'] }), (e) => e.code === 'DELIVERY_UNSET');
  assert.throws(() => resolveDeliveryMode({ delivery: '' }, { allow: ['build', 'send'] }), (e) => e.code === 'DELIVERY_UNSET');
});

test('resolveDeliveryMode throws DELIVERY_UNSET for a mode this node does not support', () => {
  assert.throws(() => resolveDeliveryMode({ delivery: 'stream' }, { allow: ['build', 'send', 'await'] }), (e) => e.code === 'DELIVERY_UNSET');
  assert.throws(() => resolveDeliveryMode({ delivery: 'bogus' }, { allow: ['build'] }), (e) => e.code === 'DELIVERY_UNSET');
});

test('DELIVERY exposes the four mode constants', () => {
  assert.deepStrictEqual(DELIVERY, { BUILD: 'build', SEND: 'send', AWAIT: 'await', STREAM: 'stream' });
});
```

- [ ] **Step 2: Run it, verify it fails** — `node --test test/unit/delivery.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement `lib/util/delivery.js`**

```js
'use strict';

/**
 * Delivery-mode contract for the action nodes (#207). A node stores one
 * `delivery` value and resolves it here; an absent or unsupported value fails
 * closed (no migration) so a pre-upgrade node cannot silently pick a behavior.
 */

/** The delivery modes an action node may declare. */
const DELIVERY = { BUILD: 'build', SEND: 'send', AWAIT: 'await', STREAM: 'stream' };

/**
 * Resolve and validate a node's delivery mode.
 *
 * @param {{delivery?: string}} config  the node config
 * @param {{allow: string[]}} opts  the modes this node supports
 * @returns {string} the resolved mode (one of `allow`)
 * @throws {Error} `.code === 'DELIVERY_UNSET'` when `config.delivery` is missing
 *   or not one of `allow`.
 */
function resolveDeliveryMode(config, { allow }) {
  const mode = config && config.delivery;
  if (!allow.includes(mode)) {
    const err = new Error(
      'Delivery mode not set — choose Build only, Send via connection, or Send & await result.'
    );
    err.code = 'DELIVERY_UNSET';
    throw err;
  }
  return mode;
}

module.exports = { DELIVERY, resolveDeliveryMode };
```

Fix the test's `require` path to `require('../../lib/util/delivery')`.

- [ ] **Step 4: Run tests** — `node --test test/unit/delivery.test.js` → PASS.
- [ ] **Step 5: Lint** — `npm run lint` → clean.
- [ ] **Step 6: Commit** — `git add lib/util/delivery.js test/unit/delivery.test.js && git commit -m "Delivery helper: pure resolveDeliveryMode with fail-closed DELIVERY_UNSET (#207)"`

---

## Task 2: MAVLink Out positive allowlist

**Files:**
- Modify: `nodes/mavlink-ai-out.js:79-137` (the `input` handler)
- Test: the existing Out unit test (confirm filename, e.g. `test/unit/out-node.test.js`)

**Interfaces:**
- Consumes: nothing new. Behavior change only.
- Produces: Out accepts only `msg.topic === 'mavlink/send'`, `msg.topic === 'mavlink/raw'`, or
  `Buffer.isBuffer(msg.payload)`; every other topic → `done(err)` with `err.code === 'NOT_OUTBOUND'`.

- [ ] **Step 1: Write the failing test**

```js
test('MAVLink Out rejects a result/ack envelope with a NOT_OUTBOUND diagnostic', async (t) => {
  const { RED, conn, node } = setupOut();   // existing harness in this file
  t.after(() => RED.close(node));
  const sends = [];
  conn.send = (p) => { sends.push(p); return Promise.resolve(); };
  let doneErr;
  await new Promise((resolve) => {
    node.receive({ topic: 'command/ack', payload: { command: 'arm', result: 'ACCEPTED' } });
    node.done = (e) => { doneErr = e; resolve(); };
    // If the harness delivers done via the input callback, capture it there instead.
  });
  assert.ok(doneErr, 'rejected via done(err)');
  assert.strictEqual(doneErr.code, 'NOT_OUTBOUND');
  assert.strictEqual(sends.length, 0, 'nothing was encoded/sent');
});

test('MAVLink Out still accepts mavlink/send and raw', async (t) => {
  const { RED, conn, node } = setupOut();
  t.after(() => RED.close(node));
  const sends = [];
  conn.send = (p) => { sends.push(p); return Promise.resolve(); };
  await injectOut(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
  assert.strictEqual(sends.length, 1);
});
```

Match the assertion style to the existing Out test harness (how it drives input and captures `done`).

- [ ] **Step 2: Run it, verify it fails** — the `command/ack` case currently reaches `connection.send` and fails inside the codec, not with `NOT_OUTBOUND`.

- [ ] **Step 3: Replace the topic handling in the handler.** In `nodes/mavlink-ai-out.js`, replace the `mavlink/error` short-circuit (`:93-95`) and the encode branch (`:96-108`) with a positive allowlist:

```js
      const priority = clampPriority(msg.priority);
      const isRaw = msg.topic === 'mavlink/raw' || Buffer.isBuffer(msg.payload);
      if (msg.topic !== 'mavlink/send' && !isRaw) {
        /**
         * Positive allowlist (#207): Out encodes only an outbound build
         * envelope (topic mavlink/send) or a raw buffer. Anything else —
         * command/ack, swarm/ack, mission/*, param/*, vehicle/*, mavlink/error,
         * or an unknown topic — is a result/ack/error, not an outbound message.
         * Reject with a clear diagnostic instead of handing it to the codec.
         * MAVLink Out must be wired from a node in Build only mode.
         */
        node.status({ fill: 'red', shape: 'ring', text: 'not outbound' });
        return done(Object.assign(
          new Error(`mavlink-ai-out received a '${msg.topic}' message, which is a result/ack/error, not an outbound MAVLink message. Wire MAVLink Out from an action node in "Build only" mode.`),
          { code: 'NOT_OUTBOUND' }
        ));
      }
      try {
        if (isRaw) {
          await node.connection.sendRaw(msg.payload, { priority });
        } else {
          await node.connection.send(msg.payload, { priority });
        }
        sent += 1;
        node._notReadyWarned = false;
        node.status({ fill: 'green', shape: 'dot', text: `tx ${sent}` });
        done();
      } catch (err) {
        // ... unchanged transport-waiting handling ...
      }
```

- [ ] **Step 4: Run tests** — the Out test file → PASS (new + existing).
- [ ] **Step 5: Lint** — `npm run lint` → clean.
- [ ] **Step 6: Commit** — `git commit -am "MAVLink Out: positive allowlist rejecting non-outbound envelopes (#207)"`

---

## Task 3: Command node — Delivery control + 2 ports

**Files:**
- Modify: `nodes/mavlink-ai-command.js` (input handler `:528-657`; `makeFail` construction; `registerType`)
- Modify: `nodes/mavlink-ai-command.html` (`defaults` `:6-57`; `outputs`; `oneditprepare`; help)
- Test: `test/unit/command-node.test.js` (confirm exact name)

**Interfaces:**
- Consumes: `resolveDeliveryMode`, `DELIVERY` from `lib/util/delivery.js`.
- Produces: port 0 = `mavlink/send` (build) / `command/sent` (send) / `command/ack` (await); port 1 = error.

- [ ] **Step 1 — editor (`.html`):**
  - In `defaults`, remove `awaitAck`; add `delivery: { value: 'build' }`.
  - Change the `connection` validator to require a connection when `delivery` is `send` or `await`:
    ```js
    validate: function (v) {
      const $live = $('#node-input-delivery');
      const mode = $live.length ? $live.val() : this.delivery;
      return (mode !== 'send' && mode !== 'await') || (v !== '' && v != null);
    }
    ```
  - Set `outputs: 2` and add:
    ```js
    outputLabels: function (i) { return i === 1 ? 'error' : (this.delivery === 'build' ? 'message' : 'result'); },
    ```
  - Add the Delivery `<select>` to the edit form (Build only / Send via connection / Send & await result) and, in `oneditprepare`, show the connection row only for `send`/`await` and the timeout/retries rows only for `await`. Replace the `awaitAck` checkbox markup.

- [ ] **Step 2 — runtime failing test:**

```js
test('command Build only emits mavlink/send on port 0, nothing on error', async (t) => {
  const { RED, node } = setupCommand({ delivery: 'build', command: 'arm' });
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, {});
  assert.strictEqual(collected[0][0].topic, 'mavlink/send');
  assert.strictEqual(collected[0][0].payload.name, 'COMMAND_LONG');
  assert.ok(!collected.map((o) => o[1]).find(Boolean), 'no error on port 1');
});

test('command Send via connection emits command/sent on port 0 (observable fire-and-forget)', async (t) => {
  const { RED, conn, node } = setupCommand({ delivery: 'send', connection: 'c1', command: 'arm' });
  t.after(() => RED.close(node));
  const sends = [];
  conn.send = (env, opts) => { sends.push({ env, opts }); return Promise.resolve(); };
  const { collected } = await RED.inject(node, {});
  assert.strictEqual(sends.length, 1, 'sent directly');
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'command/sent');
  assert.strictEqual(out.payload.sent, true);
});

test('command with no delivery set fails closed on the error port', async (t) => {
  const { RED, node } = setupCommand({ command: 'arm' });   // no delivery key
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, {});
  const err = collected.map((o) => o[1]).find(Boolean);
  assert.strictEqual(err.payload.code, 'DELIVERY_UNSET');
});

test('command Send & await result emits command/ack on port 0', async (t) => {
  const { RED, conn, node } = setupCommand({ delivery: 'await', connection: 'c1', command: 'arm' });
  t.after(() => RED.close(node));
  stubAckOnConnection(conn);   // existing helper that resolves the CommandSend workflow
  const { collected } = await RED.inject(node, {});
  const out = collected.map((o) => o[0]).find(Boolean);
  assert.strictEqual(out.topic, 'command/ack');
});
```

- [ ] **Step 3 — implement handler changes:**
  - Construct `fail` with `outputs: 2, errorIndex: 1` (see `makeFail` in `lib/util/node-errors.js`).
  - At the top of the input handler, resolve the mode and fail closed:
    ```js
    let mode;
    try {
      mode = resolveDeliveryMode(config, { allow: [DELIVERY.BUILD, DELIVERY.SEND, DELIVERY.AWAIT] });
    } catch (err) { return fail(err); }
    ```
  - Replace `if (node.awaitAck)` (`:529`) with `if (mode === DELIVERY.AWAIT)`; keep the existing workflow body, but success emits on **port 0**: `send([msg, null])` (was `send(msg)`), and the error branch uses `fail(...)` (which already targets `errorIndex: 1`).
  - Add a new `else if (mode === DELIVERY.SEND)` branch: resolve identity, `await node.connection.send({ name: messageName, vehicleProfile, localIdentity, target_system, target_component, fields }, { priority })`; on success `msg.topic = 'command/sent'; msg.payload = { name: messageName, target_system: targetSystem, target_component: targetComponent, sent: true }; send([msg, null]); done();` on failure `fail(err, 'SEND_FAILED')`. Require a connection (else `fail(new MavlinkError('NO_CONNECTION', ...))`).
  - The `else` (build) branch (`:623-657`) is unchanged except the final emit becomes `send([msg, null])`.

- [ ] **Step 4: Run tests** — the command test file → PASS.
- [ ] **Step 5: Lint** — clean.
- [ ] **Step 6: Commit** — `git commit -am "Command: explicit Delivery control + 2-port [out,error] (#207)"`

---

## Task 4: Payload node — Delivery control + 2 ports

**Files:**
- Modify: `nodes/mavlink-ai-payload.js` (input handler `:189-280`; `makeFail`; `registerType :300`)
- Modify: `nodes/mavlink-ai-payload.html` (`defaults :90` `awaitAck`; `outputs`; `oneditprepare`; help)
- Test: `test/unit/payload-node.test.js` (confirm name)

**Interfaces:**
- Consumes: `resolveDeliveryMode`, `DELIVERY`.
- Produces: port 0 = `mavlink/send` (build) / `payload/sent` (send) / `command/ack` (await, COMMAND_LONG verbs); port 1 = error.

- [ ] **Step 1 — editor:** same shape as Task 3: replace `awaitAck` with `delivery: { value: 'build' }`; connection validator requires a connection for `send`/`await`; `outputs: 2` + `outputLabels`; Delivery `<select>`; show/hide connection & await-only rows.

- [ ] **Step 2 — failing tests:** mirror Task 3's four cases for payload — Build only → `mavlink/send`; Send → `payload/sent` with `sent:true`; no-delivery → `DELIVERY_UNSET` on port 1; Await (COMMAND_LONG action) → `command/ack`. Add: **a message-verb action (e.g. gimbal-manager) under `delivery:'await'` degrades to send semantics** — emits `payload/sent`, not an ack (setpoint-style verbs have no COMMAND_ACK):

```js
test('payload await on a non-COMMAND_LONG verb degrades to a send-confirm', async (t) => {
  const { RED, conn, node } = setupPayload({ delivery: 'await', connection: 'c1', action: 'gimbalPitchYaw' });
  t.after(() => RED.close(node));
  const sends = []; conn.send = (e) => { sends.push(e); return Promise.resolve(); };
  const { collected } = await RED.inject(node, { payload: { pitch: 10, yaw: 0 } });
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(collected.map((o) => o[0]).find(Boolean).topic, 'payload/sent');
});
```

- [ ] **Step 3 — implement:** `fail` with `outputs: 2, errorIndex: 1`. Resolve mode `allow: [BUILD, SEND, AWAIT]`, fail closed. `await` + `built.name === 'COMMAND_LONG'` → existing `runWithAck` path, emit `command/ack` on port 0 (`send([msg,null])`). `await` on a non-COMMAND_LONG verb OR `send` → direct `connection.send(...)`, emit `payload/sent` on port 0. `build` → `mavlink/send` on port 0. All error exits via `fail`.

- [ ] **Step 4: tests PASS.**  **Step 5: lint clean.**  **Step 6:** `git commit -am "Payload: explicit Delivery control + 2-port [out,error] (#207)"`

---

## Task 5: Move node — Build / Send / Stream

**Files:**
- Modify: `nodes/mavlink-ai-move.js` (input handler `:147-311`; stream engine `:230-260,:415-462`; `makeFail`; `registerType :325`)
- Modify: `nodes/mavlink-ai-move.html` (`defaults` `connection :44`, `stream :74`; `outputs`; `oneditprepare`; help)
- Test: `test/unit/move-node.test.js` (confirm name)

**Interfaces:**
- Consumes: `resolveDeliveryMode`, `DELIVERY`.
- Produces: port 0 = `mavlink/send` (build) / `move/sent` (send one-shot) / `move/stream` (stream lifecycle); port 1 = error. Move has no `await`.

- [ ] **Step 1 — editor:** add `delivery: { value: 'build' }`; keep `connection` but require it for `send`/`stream`; **remove the standalone `stream` checkbox** (Stream is now a Delivery option). `outputs: 2` + `outputLabels` (port 0 → `this.delivery==='build' ? 'message' : 'result'`). Delivery `<select>`: Build only / Send via connection / Stream via connection. Show the rate/`maxStreamSeconds` rows only for `stream`.

- [ ] **Step 2 — failing tests:**

```js
test('move Build only emits mavlink/send on port 0', async (t) => {
  const { RED, node } = setupMove({ delivery: 'build' });
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: { x: 1, y: 2, z: -3 } });
  assert.strictEqual(collected.map((o) => o[0]).find(Boolean).topic, 'mavlink/send');
});

test('move Send via connection sends directly and emits move/sent (observable)', async (t) => {
  const { RED, conn, node } = setupMove({ delivery: 'send', connection: 'c1' });
  t.after(() => RED.close(node));
  const sends = []; conn.send = (e, o) => { sends.push(e); return Promise.resolve(); };
  const { collected } = await RED.inject(node, { payload: { x: 1, y: 2, z: -3 } });
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(collected.map((o) => o[0]).find(Boolean).topic, 'move/sent');
});

test('move with no delivery set fails closed on port 1', async (t) => {
  const { RED, node } = setupMove({});
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: { x: 1 } });
  assert.strictEqual(collected.map((o) => o[1]).find(Boolean).payload.code, 'DELIVERY_UNSET');
});

test('move Stream expiry emits move/stream {stream:"expired"} on port 0', async (t) => {
  const { RED, conn, node } = setupMove({ delivery: 'stream', connection: 'c1', streamRateHz: 20, maxStreamSeconds: 0.05 });
  t.after(() => RED.close(node));
  conn.send = () => Promise.resolve();
  const seen = []; node.send = (o) => seen.push(o);
  await RED.inject(node, { payload: { x: 1, y: 2, z: -3 } });
  await new Promise((r) => setTimeout(r, 90));
  const life = seen.map((o) => o[0]).find((m) => m && m.payload && m.payload.stream === 'expired');
  assert.ok(life, 'stream expiry lifecycle emitted on port 0');
});
```

- [ ] **Step 3 — implement:** `fail` `outputs: 2, errorIndex: 1`. Resolve `allow: [BUILD, SEND, STREAM]`, fail closed. `stream` → existing stream engine (require connection); lifecycle/expiry messages emit on **port 0** (`send([msg,null])`), per-streak send failures on **port 1** via `fail`. `send` → one-shot `connection.send(...)`, emit `{ topic:'move/sent', payload:{ name, target_system, target_component, sent:true } }` on port 0 (was badge-only — this is the observability fix). `build` → `mavlink/send` on port 0. Preserve the `payload.stream === false` stop-stream escape as an in-`stream`-mode control.

- [ ] **Step 4: tests PASS.**  **Step 5: lint clean.**  **Step 6:** `git commit -am "Move: Build/Send/Stream Delivery control + 2-port [out,error] (#207)"`

---

## Task 6: Fanout node — Build / Send / Await (+ dry-run)

**Files:**
- Modify: `nodes/mavlink-ai-fanout.js` (input handler `:159-351`; `makeFail`; `registerType :370`)
- Modify: `nodes/mavlink-ai-fanout.html` (`defaults` `awaitAck :29`, `dryRun :35`; `outputs`; `oneditprepare`; help)
- Test: `test/unit/fanout-node.test.js` (confirm name)

**Interfaces:**
- Consumes: `resolveDeliveryMode`, `DELIVERY`.
- Produces: port 0 = per-target `mavlink/send` (build) / `swarm/sent` aggregate (send) / `swarm/ack` aggregate (await) / `swarm/dryrun` (dry-run checkbox); port 1 = error.

- [ ] **Step 1 — editor:** replace `awaitAck` with `delivery: { value: 'build' }`; keep `dryRun` as its own checkbox; connection required for `send`/`await`; `outputs: 2` + `outputLabels`; Delivery `<select>` (Build only / Send via connection / Send & await result). Dry-run is orthogonal and applies in any send mode (short-circuits to preview).

- [ ] **Step 2 — failing tests:**

```js
test('fanout Build only emits per-target mavlink/send on port 0', async (t) => {
  const { RED, node } = setupFanout({ delivery: 'build', targets: '1,2' });
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: { command: 'arm' } });
  const builts = collected.map((o) => o[0]).filter(Boolean);
  assert.ok(builts.length >= 1 && builts.every((m) => m.topic === 'mavlink/send'));
});

test('fanout Send via connection sends all and emits swarm/sent aggregate on port 0', async (t) => {
  const { RED, conn, node } = setupFanout({ delivery: 'send', connection: 'c1', targets: '1,2' });
  t.after(() => RED.close(node));
  const sends = []; conn.send = (e) => { sends.push(e); return Promise.resolve(); };
  const { collected } = await RED.inject(node, { payload: { command: 'arm' } });
  assert.strictEqual(sends.length, 2);
  assert.strictEqual(collected.map((o) => o[0]).find(Boolean).topic, 'swarm/sent');
});

test('fanout with no delivery set fails closed on port 1', async (t) => {
  const { RED, node } = setupFanout({ targets: '1,2' });
  t.after(() => RED.close(node));
  const { collected } = await RED.inject(node, { payload: { command: 'arm' } });
  assert.strictEqual(collected.map((o) => o[1]).find(Boolean).payload.code, 'DELIVERY_UNSET');
});

test('fanout dry-run emits swarm/dryrun and sends nothing regardless of mode', async (t) => {
  const { RED, conn, node } = setupFanout({ delivery: 'send', connection: 'c1', dryRun: true, targets: '1,2' });
  t.after(() => RED.close(node));
  const sends = []; conn.send = (e) => { sends.push(e); return Promise.resolve(); };
  const { collected } = await RED.inject(node, { payload: { command: 'arm' } });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(collected.map((o) => o[0]).find(Boolean).topic, 'swarm/dryrun');
});
```

- [ ] **Step 3 — implement:** `fail` `outputs: 2, errorIndex: 1`. Resolve `allow: [BUILD, SEND, AWAIT]`, fail closed. Dry-run checkbox short-circuits first → `swarm/dryrun` on port 0 (unchanged content), no send. `await` → existing per-vehicle `CommandSend` aggregation, emit `swarm/ack` on port 0 (`send([msg,null])`). `send` (NEW) → send every decorated target directly via `connection.send(...)` (respecting `concurrency`/`spacingMs`/`stopOnError`), emit `{ topic:'swarm/sent', payload:{ sent, failed, results } }` aggregate on port 0. `build` → per-target `mavlink/send` on port 0 (array emit / paced), unchanged. All errors via `fail`.

- [ ] **Step 4: tests PASS.**  **Step 5: lint clean.**  **Step 6:** `git commit -am "Fanout: Build/Send/Await Delivery control + 2-port [out,error] (#207)"`

---

## Task 7: Docs — help panels, README, examples

**Files:**
- Modify: `nodes/mavlink-ai-{command,payload,move,fanout}.html` help sections; `nodes/mavlink-ai-out.html` help.
- Modify: `README.md`
- Modify: `examples/**` that wire an action node into MAVLink Out.

- [ ] **Step 1:** In each action node's `<script type="text/html" data-help-name=...>` block, document the one mental model: the **Delivery** control (Build only / Send via connection / Send & await result — or Stream for Move); **port 0 = the node's product** (built message vs result/ack), **port 1 = error**; and that MAVLink Out must be wired from **Build only**. Note Command/Fanout now offer direct Send.
- [ ] **Step 2:** In `nodes/mavlink-ai-out.html` help, document the positive allowlist and the `NOT_OUTBOUND` rejection.
- [ ] **Step 3:** Add a `README.md` "Delivery models" section describing the single model across Command/Move/Payload/Fanout and the always-transactional Mission/Param (`result/progress/error`). This replaces the plain "three delivery models" note the earlier #207 triage deferred to the #14 publish pass.
- [ ] **Step 4:** Update every example flow that connects an action node's output to MAVLink Out so the action node is in **Build only** mode and wired from port 0; re-export the example JSON. Grep: `grep -rl '"mavlink-ai-out"' examples/`.
- [ ] **Step 5:** Verify examples load — run the repo's example smoke-load (the `npm test` smoke step) → PASS.
- [ ] **Step 6:** Lint clean; commit — `git commit -am "Docs+examples: one delivery mental model; MAVLink Out allowlist (#207)"`

---

## Self-Review

**Spec coverage:**
- Explicit consistently-named Delivery control → Tasks 3–6 (dropdown) + Task 1 (values). ✓
- Show/hide + validate connection per mode → editor steps in Tasks 3–6. ✓
- Stable output contracts / typed ports → 2-port `[out, error]`, error last, per-mode port-0 topics (Global Constraints; Tasks 3–6). ✓
- Don't pass ACK/result into Out → Task 2 allowlist. ✓
- Fire-and-forget observable → `command/sent`/`move/sent`/`payload/sent`/`swarm/sent` (Tasks 3–6). ✓
- Preserve existing flows via migration → **consciously overridden**: no migration, `DELIVERY_UNSET` fail-closed (Task 1; Global Constraints), per the approved spec. ✓
- One mental model in help/examples → Task 7. ✓
- Tests for every mode transition + output topic → per-node tests in Tasks 3–6 + Task 2. ✓

**Placeholder scan:** filenames of existing per-node test files are marked "confirm name" — the implementer verifies the exact path in-repo (the only unresolved lookups; no code placeholders). Mission/Param explicitly out of scope, not omitted.

**Type consistency:** `delivery` values, `DELIVERY` constants, `resolveDeliveryMode(config, {allow})`, port indices (`outputs: 2`, `errorIndex: 1`), and the port-0 topics are used identically across Tasks 1–6.

---

## Notes for the executor

- Confirm each node's existing unit-test filename before Step 2 of its task (`ls test/unit | grep <node>`); reuse that file's existing `setup*`/harness helpers rather than inventing new ones.
- Two small #225 follow-ups can ride along in Task 7 if trivial, else leave for Tier C: the heartbeat `heartbeatSpecs()` startup-phrased warn wording, and documenting `IDENTITY_NOT_HEALTH_DRIVEN` in the vehicle-state help.
- This is a pre-1.0 clean break: single-output action nodes go 1 → 2 ports; existing deployed flows fail closed until re-opened. Call this out in the eventual PR body and 1.0 release notes.
