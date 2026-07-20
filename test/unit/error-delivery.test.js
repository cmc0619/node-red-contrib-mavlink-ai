'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { MockRED } = require('../helpers/mock-red');
const { LockManager } = require('../../lib/runtime/lock-manager');
const { fakeIdentity } = require('../helpers/v3-config');

/**
 * Error delivery rule (#89, DESIGN.md §14.5.1): a node with a dedicated error
 * output (or whose output carries error envelopes) delivers an operational
 * failure exactly once — the structured message on that output — and calls
 * done(), so the same failure does not also fire Catch nodes. Nodes without
 * outputs (mavlink-ai-out) call done(err), which IS their delivery path.
 */

function setup({ sendError, identityError } = {}) {
  const RED = new MockRED().loadNodes();
  const profile = RED.create('mavlink-ai-vehicle', {
    id: 'p1',
    name: 'Copter',
    dialect: 'ardupilotmega',
    defaultTargetSystem: 1,
    defaultTargetComponent: 1
  });

  RED.nodes.registerType('stub-connection', function StubConnection(config) {
    RED.nodes.createNode(this, config);
    this.name = 'conn';
    this.profile = profile;
    this.locks = new LockManager();
    this.statusState = 'connected';
    this.emitter = new EventEmitter();
    this._subs = new Map();
    this._nextSub = 1;
    this.subscribe = (filter, cb) => {
      const id = this._nextSub++;
      this._subs.set(id, { filter, cb });
      return id;
    };
    this.unsubscribe = (id) => this._subs.delete(id);
    this.send = () =>
      sendError ? Promise.reject(sendError) : Promise.resolve();
    this.sendRaw = this.send;
    this.acquireLock = (key, owner) => this.locks.acquire(key, owner);
    this.releaseLock = (key, owner) => this.locks.release(key, owner);
    // v3: the connection resolves the outbound Local Identity (#228).
    this.resolveOutboundIdentity = () => {
      if (identityError) {
        throw identityError;
      }
      return fakeIdentity();
    };
    /** #233 capability API (unused by these tests, required by the contract). */
    this.getVehicleCapabilities = () => undefined;
    this.requestVehicleCapabilities = () => {};
    /** #196 routing API (required by the contract): accept everything. */
    this.getRouteDecision = () => ({ accepted: true, profile: null });
  });
  RED.create('stub-connection', { id: 'conn1' });
  return { RED };
}

const boom = Object.assign(new Error('link down'), { code: 'UDP_NO_PEER' });
/** A genuine send failure (not a transient not-ready state) — must surface. */
const realBoom = Object.assign(new Error('encode blew up'), { code: 'ENCODE_FAILED' });

test('mission workflow failure: error output once, done() — no Catch double-fire (#89)', async () => {
  const { RED } = setup({ sendError: boom });
  const node = RED.create('mavlink-ai-mission', { id: 'm1', connection: 'conn1', action: 'download' });
  const { collected, err } = await RED.inject(node, { payload: { action: 'download' } });

  const errorOuts = collected.filter((out) => out[2]);
  assert.strictEqual(errorOuts.length, 1, 'exactly one error message on output 3');
  assert.strictEqual(errorOuts[0][2].topic, 'mavlink/error');
  assert.strictEqual(errorOuts[0][2].payload.code, 'MISSION_FAILED');
  assert.match(errorOuts[0][2].payload.message, /link down/);
  assert.strictEqual(err, undefined, 'done() without the error — Catch must not fire too');
});

test('param workflow failure: error output once, done() (#89)', async () => {
  const { RED } = setup({ sendError: boom });
  const node = RED.create('mavlink-ai-param', { id: 'pr1', connection: 'conn1', action: 'read', paramId: 'X' });
  const { collected, err } = await RED.inject(node, { payload: {} });

  const errorOuts = collected.filter((out) => out[2]);
  assert.strictEqual(errorOuts.length, 1, 'exactly one error message on output 3');
  assert.strictEqual(errorOuts[0][2].payload.code, 'PARAM_FAILED');
  assert.match(errorOuts[0][2].payload.message, /link down/);
  assert.strictEqual(err, undefined, 'done() without the error — Catch must not fire too');
});

test('mission identity-resolution failure: error output once, done() (#89)', async () => {
  /**
   * These catch blocks used to call finishError without the `msg` argument:
   * the arity shift invoked done() with a truthy value (firing Catch nodes
   * with garbage instead of delivering on output 3) and then crashed calling
   * the payload object as a function. The one failure mode the block exists
   * to report broke the delivery contract in every way at once.
   */
  const detached = Object.assign(new Error('identity detached'), { code: 'LOCAL_IDENTITY_UNRESOLVED' });
  const { RED } = setup({ identityError: detached });
  const node = RED.create('mavlink-ai-mission', { id: 'm1', connection: 'conn1', action: 'download' });
  const { collected, err } = await RED.inject(node, { payload: { action: 'download' } });

  const errorOuts = collected.filter((out) => out[2]);
  assert.strictEqual(errorOuts.length, 1, 'exactly one error message on output 3');
  assert.strictEqual(errorOuts[0][2].topic, 'mavlink/error');
  assert.strictEqual(errorOuts[0][2].payload.code, 'LOCAL_IDENTITY_UNRESOLVED');
  assert.match(errorOuts[0][2].payload.message, /identity detached/);
  assert.strictEqual(err, undefined, 'done() without the error — Catch must not fire too');
});

test('param identity-resolution failure: error output once, done() (#89)', async () => {
  const detached = Object.assign(new Error('identity detached'), { code: 'LOCAL_IDENTITY_UNRESOLVED' });
  const { RED } = setup({ identityError: detached });
  const node = RED.create('mavlink-ai-param', { id: 'pr1', connection: 'conn1', action: 'read', paramId: 'X' });
  const { collected, err } = await RED.inject(node, { payload: {} });

  const errorOuts = collected.filter((out) => out[2]);
  assert.strictEqual(errorOuts.length, 1, 'exactly one error message on output 3');
  assert.strictEqual(errorOuts[0][2].payload.code, 'LOCAL_IDENTITY_UNRESOLVED');
  assert.strictEqual(err, undefined, 'done() without the error — Catch must not fire too');
});

test('command await-ack failure: error on the output, done() (#89)', async () => {
  const { RED } = setup({ sendError: boom });
  const node = RED.create('mavlink-ai-command', {
    id: 'c1',
    profile: 'p1',
    connection: 'conn1',
    command: 'arm',
    delivery: 'await'
  });
  const { collected, err } = await RED.inject(node, { payload: {} });

  assert.strictEqual(collected.length, 1, 'exactly one error message on the output');
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'COMMAND_FAILED');
  assert.match(collected[0][1].payload.message, /link down/);
  assert.strictEqual(err, undefined, 'done() without the error — Catch must not fire too');
});

test('out node has no outputs: real failures go to done(err) for Catch nodes (#89)', async () => {
  const { RED } = setup({ sendError: realBoom });
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const { collected, err } = await RED.inject(node, {
    topic: 'mavlink/send',
    payload: { name: 'HEARTBEAT', fields: {} }
  });

  assert.strictEqual(collected.length, 0, 'no outputs to send on');
  assert.ok(err, 'done(err) is the delivery path');
  assert.strictEqual(err.code, 'ENCODE_FAILED');
});

test('out node treats a not-ready transport as "waiting", not an error (no spam)', async () => {
  /**
   * A udp-peer that hasn't learned a peer yet (UDP_NO_PEER) is a normal
   * transient state. The Out node must badge "waiting for link" and warn once,
   * not fire done(err) on every send — which used to spam the error output /
   * Catch nodes when a peer simply hadn't appeared.
   */
  const { RED } = setup({ sendError: boom });
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const first = await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
  assert.strictEqual(first.collected.length, 0);
  assert.strictEqual(first.err, undefined, 'no done(err) — Catch nodes are not triggered');
  assert.deepStrictEqual(node.statusHistory[node.statusHistory.length - 1], {
    fill: 'yellow',
    shape: 'ring',
    text: 'waiting for link'
  });
  assert.strictEqual(node.warnings.length, 1, 'warned once');
  /** A second send while still waiting does not warn again. */
  const second = await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
  assert.strictEqual(second.err, undefined);
  assert.strictEqual(node.warnings.length, 1, 'warn-once — no spam');
});

test('out node still surfaces a permanent udp-out misconfiguration (UDP_NO_REMOTE)', async () => {
  /**
   * Unlike a udp-peer waiting for a peer, a udp-out with no remote configured
   * can never deliver — that is a real error, so it must reach done(err) and
   * not be swallowed as a "waiting" state.
   */
  const badRemote = Object.assign(new Error('no remote configured'), { code: 'UDP_NO_REMOTE' });
  const { RED } = setup({ sendError: badRemote });
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const { err } = await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
  assert.ok(err, 'a permanent udp misconfiguration surfaces via done(err)');
  assert.strictEqual(err.code, 'UDP_NO_REMOTE');
});

test('out node surfaces a failed transport start (TRANSPORT_NOT_READY), not "waiting"', async () => {
  /**
   * TRANSPORT_NOT_READY means the transport is null — often a permanent failed
   * start (unknown transport, a serial dependency that threw), not the transient
   * "link coming up" the heartbeat silently retries. A fire-and-forget send must
   * surface it so a Catch node sees the misconfiguration (Codex review).
   */
  const notStarted = Object.assign(new Error('Transport is not started.'), { code: 'TRANSPORT_NOT_READY' });
  const { RED } = setup({ sendError: notStarted });
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const { err } = await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
  assert.ok(err, 'a failed/absent transport surfaces via done(err)');
  assert.strictEqual(err.code, 'TRANSPORT_NOT_READY');
});

test('out node surfaces config-dependent link failures (TCP_NOT_CONNECTED / SERIAL_NOT_OPEN)', async () => {
  /**
   * A disconnected tcp-client or serial link only recovers when Reconnect is
   * enabled; with reconnect off it is permanently down, so these must surface
   * rather than be swallowed as "waiting" — a Catch node needs to see a link
   * that can't recover on its own (Codex review).
   */
  for (const code of ['TCP_NOT_CONNECTED', 'SERIAL_NOT_OPEN']) {
    const e = Object.assign(new Error(code), { code });
    const { RED } = setup({ sendError: e });
    const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
    const { err } = await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
    assert.ok(err, `${code} surfaces via done(err)`);
    assert.strictEqual(err.code, code);
  }
});

test('out node surfaces a failed listener start (UDP_NOT_STARTED / TCP_NOT_LISTENING), not "waiting"', async () => {
  /**
   * A udp-peer / tcp-server whose socket or server is null never came up — often
   * a permanent failure (a port already in use). The transports reject that with
   * a distinct not-started code *before* the transient UDP_NO_PEER / TCP_NO_CLIENT
   * waiting states, so a listener that failed to start surfaces to a Catch node
   * instead of being silently swallowed as "waiting for link" (Codex review).
   */
  for (const code of ['UDP_NOT_STARTED', 'TCP_NOT_LISTENING']) {
    const e = Object.assign(new Error(code), { code });
    const { RED } = setup({ sendError: e });
    const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
    const { err } = await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
    assert.ok(err, `${code} surfaces via done(err)`);
    assert.strictEqual(err.code, code);
  }
});

test('out node forwards a clamped msg.priority to the connection (#241)', async () => {
  /**
   * The advanced override: msg.priority picks the outbound band, clamped to
   * [0, 3]; absent means "no override" so the queue default applies. The
   * command node stamps this on critical build-only commands.
   */
  const captured = [];
  const RED = new MockRED().loadNodes();
  RED.nodes.registerType('cap-connection', function CapConnection(config) {
    RED.nodes.createNode(this, config);
    this.name = 'cap';
    this.statusState = 'connected';
    this.emitter = new EventEmitter();
    this.send = (message, options) => {
      captured.push(options && options.priority);
      return Promise.resolve();
    };
    this.sendRaw = this.send;
  });
  RED.create('cap-connection', { id: 'cap1' });
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'cap1' });

  await RED.inject(node, { topic: 'mavlink/send', priority: 0, payload: { name: 'HEARTBEAT', fields: {} } });
  await RED.inject(node, { topic: 'mavlink/send', priority: 99, payload: { name: 'HEARTBEAT', fields: {} } });
  await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
  assert.deepStrictEqual(captured, [0, 3, undefined]);
});

/**
 * #285: every node with an error-carrying output now delivers through the
 * shared makeFail exit. One representative failure per remaining node pins
 * the #89 contract — exactly one structured error on the right output,
 * done() without an error — across the single-output family.
 */

test('move node: missing profile delivers one mavlink/error, done() clean (#285)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-move', { id: 'mv1' });
  const { collected, err } = await RED.inject(node, { payload: { lat: 1, lon: 2, alt: 10 } });
  assert.strictEqual(err, undefined, 'done() without the error — Catch must not fire too');
  assert.strictEqual(collected.length, 1, 'exactly one error message');
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'MISSING_PROFILE');
  assert.strictEqual(collected[0].payload.node, 'mavlink-ai-move');
});

test('payload node: missing profile delivers one mavlink/error, done() clean (#285)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-payload', { id: 'pl1', action: 'gripper_grab', delivery: 'build' });
  const { collected, err } = await RED.inject(node, { payload: {} });
  assert.strictEqual(err, undefined);
  assert.strictEqual(collected.length, 1);
  assert.strictEqual(collected[0][1].topic, 'mavlink/error');
  assert.strictEqual(collected[0][1].payload.code, 'MISSING_PROFILE');
  assert.strictEqual(collected[0][1].payload.node, 'mavlink-ai-payload');
});

test('fanout node: missing profile delivers one mavlink/error, done() clean (#285)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-fanout', { id: 'fo1' });
  const { collected, err } = await RED.inject(node, { payload: { command: 'MAV_CMD_NAV_TAKEOFF', targets: [1] } });
  assert.strictEqual(err, undefined);
  assert.strictEqual(collected.length, 1);
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'MISSING_PROFILE');
  assert.strictEqual(collected[0].payload.node, 'mavlink-ai-fanout');
});

test('formation node: empty vehicle set delivers one mavlink/error, done() clean (#285)', async () => {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-formation', { id: 'fm1', shape: 'wedge', anchorMode: 'msg' });
  const { collected, err } = await RED.inject(node, { payload: { lat: 1, lon: 2, alt: 10, sysids: [] } });
  assert.strictEqual(err, undefined);
  assert.strictEqual(collected.length, 1);
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'NO_TARGETS');
  assert.strictEqual(collected[0].payload.node, 'mavlink-ai-formation');
});

/**
 * #207: MAVLink Out is hardened with a positive allowlist. It encodes/sends
 * only an outbound build envelope (topic mavlink/send) or a raw buffer
 * (topic mavlink/raw, or Buffer.isBuffer(msg.payload)). Every other topic —
 * command/ack, swarm/ack, mission/*, param/*, vehicle/*, mavlink/error, or an
 * unknown topic — is a result/ack/error, not an outbound message, and is
 * rejected via done(err) with err.code === 'NOT_OUTBOUND'. This replaces the
 * old behavior of silently dropping mavlink/error.
 */

test('out node rejects a non-outbound topic with NOT_OUTBOUND, nothing sent (#207)', async () => {
  const { RED } = setup();
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const sends = [];
  node.connection.send = (p) => {
    sends.push(p);
    return Promise.resolve();
  };
  node.connection.sendRaw = (p) => {
    sends.push(p);
    return Promise.resolve();
  };
  const { err } = await RED.inject(node, { topic: 'command/ack', payload: { command: 'arm', result: 'ACCEPTED' } });
  assert.ok(err, 'rejected via done(err)');
  assert.strictEqual(err.code, 'NOT_OUTBOUND');
  assert.strictEqual(sends.length, 0, 'nothing was encoded/sent');
});

test('out node rejects mavlink/error with NOT_OUTBOUND — was silently dropped before (#207)', async () => {
  const { RED } = setup();
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const sends = [];
  node.connection.send = (p) => {
    sends.push(p);
    return Promise.resolve();
  };
  const { err } = await RED.inject(node, { topic: 'mavlink/error', payload: { code: 'X', message: 'boom' } });
  assert.ok(err, 'rejected via done(err)');
  assert.strictEqual(err.code, 'NOT_OUTBOUND');
  assert.strictEqual(sends.length, 0, 'nothing was encoded/sent');
});

test('out node still accepts and sends mavlink/send (#207)', async () => {
  const { RED } = setup();
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const sends = [];
  node.connection.send = (p) => {
    sends.push(p);
    return Promise.resolve();
  };
  const { err } = await RED.inject(node, { topic: 'mavlink/send', payload: { name: 'HEARTBEAT', fields: {} } });
  assert.strictEqual(err, undefined);
  assert.strictEqual(sends.length, 1);
});

test('out node still accepts and sends a raw Buffer / mavlink/raw (#207)', async () => {
  const { RED } = setup();
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const sends = [];
  node.connection.sendRaw = (p) => {
    sends.push(p);
    return Promise.resolve();
  };
  const { err: err1 } = await RED.inject(node, { topic: 'mavlink/raw', payload: Buffer.from([1, 2, 3]) });
  assert.strictEqual(err1, undefined);
  const { err: err2 } = await RED.inject(node, { payload: Buffer.from([4, 5, 6]) });
  assert.strictEqual(err2, undefined);
  assert.strictEqual(sends.length, 2);
});
