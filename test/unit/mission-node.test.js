'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * Build a mission node backed by a real profile and a lightweight stub
 * connection. The stub is enough to exercise the node's pre-lock validation
 * (#74): the node reads `connection.profile` for defaults/dialect and errors
 * out before it would ever call acquireLock/subscribe/send.
 */
function setup() {
  const RED = new MockRED().loadNodes();
  const profile = RED.create('mavlink-ai-profile', {
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
    this.acquireLock = () => {
      throw new Error('acquireLock must not be reached for invalid targets');
    };
  });
  RED.create('stub-connection', { id: 'conn1' });

  const node = RED.create('mavlink-ai-mission', { id: 'm1', connection: 'conn1', action: 'download' });
  return { RED, node };
}

test('mission node rejects an out-of-range target_system before locking (#74)', async () => {
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'download', target_system: 999 } });
  const err = collected[0][2]; // output 3: errors
  assert.strictEqual(err.topic, 'mavlink/error');
  assert.strictEqual(err.payload.code, 'INVALID_FIELD');
  assert.strictEqual(err.payload.context.field, 'target_system');
});

test('mission node rejects an out-of-range target_component before locking (#74)', async () => {
  const { RED, node } = setup();
  const { collected } = await RED.inject(node, { payload: { action: 'clear', target_component: 300 } });
  const err = collected[0][2];
  assert.strictEqual(err.payload.code, 'INVALID_FIELD');
  assert.strictEqual(err.payload.context.field, 'target_component');
});
