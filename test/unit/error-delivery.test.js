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

test('out node has no outputs: failures go to done(err) for Catch nodes (#89)', async () => {
  const { RED } = setup({ sendError: boom });
  const node = RED.create('mavlink-ai-out', { id: 'o1', connection: 'conn1' });
  const { collected, err } = await RED.inject(node, {
    topic: 'mavlink/send',
    payload: { name: 'HEARTBEAT', fields: {} }
  });

  assert.strictEqual(collected.length, 0, 'no outputs to send on');
  assert.ok(err, 'done(err) is the delivery path');
  assert.strictEqual(err.code, 'UDP_NO_PEER');
});
