'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');
const { fakeIdentity } = require('../helpers/v3-config');
const { LockManager } = require('../../lib/runtime/lock-manager');

/**
 * Node close must abort in-flight protocol workflows (#83): a partial deploy
 * or node delete may not leave subscriptions, retransmit/response timers, or
 * held locks running until success/timeout, and an obsolete node must not
 * emit output after it closed.
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared runtime setup: real profile + a stub connection with real locks. */
function setup() {
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
    /** #196 routing API (required by the contract): accept everything. */
    this.getRouteDecision = () => ({ accepted: true, profile: null });
    this.locks = new LockManager();
    this.sent = [];
    this._subs = new Map();
    this._nextSub = 1;
    this.subscribe = (filter, cb) => {
      const id = this._nextSub++;
      this._subs.set(id, { filter, cb });
      return id;
    };
    this.unsubscribe = (id) => this._subs.delete(id);
    this.send = (message) => {
      this.sent.push(message);
      return Promise.resolve();
    };
    this.acquireLock = (key, owner) => this.locks.acquire(key, owner);
    this.releaseLock = (key, owner) => this.locks.release(key, owner);
    this.resolveOutboundIdentity = () => fakeIdentity();
    /** #233 capability API (unused here, required by the contract). */
    this.getVehicleCapabilities = () => undefined;
    this.requestVehicleCapabilities = () => {};
  });
  const conn = RED.create('stub-connection', { id: 'conn1' });
  return { RED, conn };
}

test('command node close aborts an in-flight await-ack workflow (#83)', async () => {
  const { RED, conn } = setup();
  const node = RED.create('mavlink-ai-command', {
    id: 'c1',
    profile: 'p1',
    connection: 'conn1',
    command: 'arm',
    delivery: 'await',
    timeoutMs: 60000,
    maxRetries: 3
  });

  const pending = RED.inject(node, { payload: {} });
  await delay(10); // let the workflow send and subscribe

  assert.strictEqual(conn.sent.length, 1, 'command was sent');
  assert.strictEqual(conn._subs.size, 1, 'ACK subscription active');
  assert.strictEqual(conn.locks.isHeld('command:1:1:400'), true, 'command lock held');

  await RED.close(node);
  const { collected, err } = await pending; // done() settles instead of hanging

  assert.strictEqual(collected.length, 0, 'no output from the closed node');
  assert.strictEqual(err, undefined, 'close-abort is not reported as a node error');
  assert.strictEqual(conn._subs.size, 0, 'subscription dropped');
  assert.strictEqual(conn.locks.isHeld('command:1:1:400'), false, 'command lock released');
  assert.strictEqual(conn.sent.length, 1, 'no retransmit after close');
});

test('mission node close aborts the active workflow and releases its lock (#83)', async () => {
  const { RED, conn } = setup();
  const node = RED.create('mavlink-ai-mission', {
    id: 'm1',
    connection: 'conn1',
    action: 'download',
    timeoutMs: 60000
  });

  const pending = RED.inject(node, { payload: { action: 'download' } });
  await delay(10);

  assert.strictEqual(conn.sent.length, 1, 'MISSION_REQUEST_LIST was sent');
  assert.strictEqual(conn.locks.isHeld('mission:conn1:p1:0'), true, 'mission lock held');

  await RED.close(node);
  const { collected, err } = await pending;

  // Progress events emitted while the workflow was live are fine; the closed
  // node must not emit a result (output 1) or an error (output 3).
  for (const out of collected) {
    assert.strictEqual(out[0], null, 'no result output from the closed node');
    assert.strictEqual(out[2], null, 'no error output from the closed node');
  }
  assert.strictEqual(err, undefined);
  assert.strictEqual(conn._subs.size, 0, 'subscriptions dropped');
  assert.strictEqual(conn.locks.isHeld('mission:conn1:p1:0'), false, 'mission lock released');
});

test('param node close aborts the active workflow and releases its lock (#83)', async () => {
  const { RED, conn } = setup();
  const node = RED.create('mavlink-ai-param', {
    id: 'pr1',
    connection: 'conn1',
    action: 'read',
    paramId: 'SYSID_THISMAV',
    timeoutMs: 60000
  });

  const pending = RED.inject(node, { payload: {} });
  await delay(10);

  assert.strictEqual(conn.sent.length, 1, 'PARAM_REQUEST_READ was sent');
  assert.strictEqual(conn.locks.isHeld('param:conn1:p1:1:1'), true, 'param lock held');

  await RED.close(node);
  const { collected, err } = await pending;

  // Progress events emitted while the workflow was live are fine; the closed
  // node must not emit a result (output 1) or an error (output 3).
  for (const out of collected) {
    assert.strictEqual(out[0], null, 'no result output from the closed node');
    assert.strictEqual(out[2], null, 'no error output from the closed node');
  }
  assert.strictEqual(err, undefined);
  assert.strictEqual(conn._subs.size, 0, 'subscriptions dropped');
  assert.strictEqual(conn.locks.isHeld('param:conn1:p1:1:1'), false, 'param lock released');
});

test('fanout close aborts the current ACK workflow and skips remaining targets (#83)', async () => {
  const { RED, conn } = setup();
  const node = RED.create('mavlink-ai-fanout', {
    id: 'f1',
    profile: 'p1',
    connection: 'conn1',
    command: 'MAV_CMD_COMPONENT_ARM_DISARM',
    awaitAck: true,
    timeoutMs: 60000,
    maxRetries: 3
  });

  const pending = RED.inject(node, { payload: { targets: [1, 2, 3] } });
  await delay(10);

  assert.strictEqual(conn.sent.length, 1, 'first target command in flight');

  await RED.close(node);
  const { collected, err } = await pending;

  assert.strictEqual(collected.length, 0, 'no aggregate output from the closed node');
  assert.strictEqual(err, undefined);
  assert.strictEqual(conn.sent.length, 1, 'remaining targets were not commanded after close');
  assert.strictEqual(conn._subs.size, 0, 'subscriptions dropped');
  assert.strictEqual(conn.locks.isHeld('command:1:1:400'), false, 'per-target command lock released');
});
