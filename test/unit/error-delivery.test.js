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

function setup({ sendError } = {}) {
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
    this.resolveOutboundIdentity = () => fakeIdentity();
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

test('command await-ack failure: error on the output, done() (#89)', async () => {
  const { RED } = setup({ sendError: boom });
  const node = RED.create('mavlink-ai-command', {
    id: 'c1',
    profile: 'p1',
    connection: 'conn1',
    command: 'arm',
    awaitAck: true
  });
  const { collected, err } = await RED.inject(node, { payload: {} });

  assert.strictEqual(collected.length, 1, 'exactly one error message on the output');
  assert.strictEqual(collected[0].topic, 'mavlink/error');
  assert.strictEqual(collected[0].payload.code, 'COMMAND_FAILED');
  assert.match(collected[0].payload.message, /link down/);
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
  assert.ok(err, 'a permanent udp-out misconfiguration surfaces via done(err)');
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
