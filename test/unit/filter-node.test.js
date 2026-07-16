'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * Behavioral coverage for mavlink-ai-filter — previously the only node with no
 * tests (#152). Its building blocks (subscription registry, fields-signature)
 * were tested, but the node-level name/id/identity/target/field/rate/changed
 * behavior was not.
 */

/** Build a decoded §14.1 message envelope. */
function msg(name, { id = 0, sysid = 1, compid = 1, fields = {}, profile, profile_id } = {}) {
  return { payload: { name, id, sysid, compid, fields, profile, profile_id } };
}

/** Create a filter node with the given editor config. */
function setup(config = {}) {
  const RED = new MockRED().loadNodes();
  const node = RED.create('mavlink-ai-filter', Object.assign({ id: 'f1' }, config));
  return { RED, node };
}

/** True when the injected message passed the filter (was sent onward). */
async function passes(RED, node, message) {
  const { collected } = await RED.inject(node, message);
  return collected.length === 1;
}

test('message-name filter passes listed names and drops others', async () => {
  const { RED, node } = setup({ messageNames: 'HEARTBEAT, ATTITUDE' });
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT')), true);
  assert.strictEqual(await passes(RED, node, msg('attitude')), true);
  assert.strictEqual(await passes(RED, node, msg('GLOBAL_POSITION_INT')), false);
});

test('sysid/compid accept comma lists', async () => {
  const { RED, node } = setup({ sysid: '1,2', compid: '1' });
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { sysid: 1 })), true);
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { sysid: 2 })), true);
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { sysid: 3 })), false);
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { sysid: 1, compid: 99 })), false);
});

test('blank identity filters accept everything', async () => {
  const { RED, node } = setup({});
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { sysid: 42, compid: 7 })), true);
});

test('target filter drops mismatches but passes messages without the target field', async () => {
  const { RED, node } = setup({ targetSystem: '5' });
  assert.strictEqual(await passes(RED, node, msg('COMMAND_LONG', { fields: { target_system: 5 } })), true);
  assert.strictEqual(await passes(RED, node, msg('COMMAND_LONG', { fields: { target_system: 6 } })), false);
  /** Broadcast/no-target messages are not dropped by a target filter. */
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { fields: {} })), true);
});

test('field-value filter matches on stringified equality; field-exists requires presence', async () => {
  const byValue = setup({ fieldName: 'result', fieldValue: '0' });
  assert.strictEqual(await passes(byValue.RED, byValue.node, msg('COMMAND_ACK', { fields: { result: 0 } })), true);
  assert.strictEqual(await passes(byValue.RED, byValue.node, msg('COMMAND_ACK', { fields: { result: 4 } })), false);

  const byExists = setup({ fieldName: 'lat', fieldExists: true });
  assert.strictEqual(await passes(byExists.RED, byExists.node, msg('GPI', { fields: { lat: 0 } })), true);
  assert.strictEqual(await passes(byExists.RED, byExists.node, msg('GPI', { fields: {} })), false);
});

/** 2 Hz is a 500 ms window, so two synchronous injects fall inside it and the second is dropped. */
test('rate limit drops a burst within the window', async () => {
  const { RED, node } = setup({ rateLimitHz: 2 });
  assert.strictEqual(await passes(RED, node, msg('ATTITUDE')), true);
  assert.strictEqual(await passes(RED, node, msg('ATTITUDE')), false);
});

test('changed-only drops repeats and passes a changed value; per sysid key', async () => {
  const { RED, node } = setup({ changedOnly: true });
  assert.strictEqual(await passes(RED, node, msg('ATTITUDE', { fields: { roll: 1 } })), true);
  assert.strictEqual(await passes(RED, node, msg('ATTITUDE', { fields: { roll: 1 } })), false);
  assert.strictEqual(await passes(RED, node, msg('ATTITUDE', { fields: { roll: 2 } })), true);
  /** A different sysid is tracked independently. */
  assert.strictEqual(await passes(RED, node, msg('ATTITUDE', { sysid: 9, fields: { roll: 1 } })), true);
});

test('profile filter matches the display name or the config-node id', async () => {
  const { RED, node } = setup({ profileFilter: 'Copter' });
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { profile: 'Copter' })), true);
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { profile_id: 'Copter' })), true);
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { profile: 'Plane' })), false);
});

test('a malformed id filter drops everything (fails closed) instead of widening (#193)', async () => {
  /**
   * "1,2x" used to silently narrow to [1]; a fully-malformed value used to
   * become [] = accept everything. Both must now fail the filter closed.
   */
  const { RED, node } = setup({ sysid: '1,2x' });
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { sysid: 1 })), false);
  assert.strictEqual(await passes(RED, node, msg('HEARTBEAT', { sysid: 99 })), false);

  const bad = setup({ compid: '1O' });
  assert.strictEqual(await passes(bad.RED, bad.node, msg('HEARTBEAT', { sysid: 5, compid: 5 })), false);
});
