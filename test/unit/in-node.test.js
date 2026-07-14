'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { MockRED } = require('../helpers/mock-red');

/** Register a minimal connection stand-in under the given config-node id. */
function stubConnection(RED, id) {
  const emitter = new EventEmitter();
  const conn = {
    id,
    name: 'stub',
    emitter,
    statusState: 'connected',
    subscribe: () => 1,
    unsubscribe: () => true
  };
  RED._nodes.set(id, conn);
  return conn;
}

test('mavlink-ai-in errors output forwards decodeError and rejected events (#22)', () => {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  const node = RED.create('mavlink-ai-in', { id: 'in1', connection: 'c1', outputErrors: true });

  conn.emitter.emit('decodeError', {
    topic: 'mavlink/error',
    payload: { code: 'DECODE_FAILED', context: { msgid: 9999 } }
  });
  conn.emitter.emit('rejected', { sysid: 42, compid: 1, reason: 'sysid-rejected' });

  assert.strictEqual(node.sent.length, 2);
  // No raw output configured, so errors ride output index 1.
  assert.strictEqual(node.sent[0][0], undefined);
  assert.strictEqual(node.sent[0][1].topic, 'mavlink/error');
  assert.strictEqual(node.sent[0][1].payload.code, 'DECODE_FAILED');
  assert.strictEqual(node.sent[1][1].topic, 'mavlink/rejected');
  assert.strictEqual(node.sent[1][1].payload.reason, 'sysid-rejected');
});

test('mavlink-ai-in errors output sits after the raw output when both are enabled (#22)', () => {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  const node = RED.create('mavlink-ai-in', { id: 'in1', connection: 'c1', outputRaw: true, outputErrors: true });

  conn.emitter.emit('rejected', { sysid: 42, compid: 1, reason: 'compid-rejected' });
  assert.strictEqual(node.sent.length, 1);
  assert.strictEqual(node.sent[0][2].topic, 'mavlink/rejected');
});

test('mavlink-ai-in without errors output attaches no diagnostics listeners (#22)', () => {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  RED.create('mavlink-ai-in', { id: 'in1', connection: 'c1' });
  assert.strictEqual(conn.emitter.listenerCount('decodeError'), 0);
  assert.strictEqual(conn.emitter.listenerCount('rejected'), 0);
});

/** A comma-separated SysID config now yields a sysids list, not a narrowed single id (#154). */
test('mavlink-ai-in passes a sysids list from a comma-separated config (#154)', () => {
  const RED = new MockRED().loadNodes();
  let captured;
  const conn = {
    id: 'c1',
    name: 'stub',
    emitter: new EventEmitter(),
    statusState: 'connected',
    subscribe: (filter) => {
      captured = filter;
      return 1;
    },
    unsubscribe: () => true
  };
  RED._nodes.set('c1', conn);
  RED.create('mavlink-ai-in', { id: 'in1', connection: 'c1', sysid: '1,2', compid: '' });
  assert.deepStrictEqual(captured.sysids, [1, 2]);
  assert.deepStrictEqual(captured.compids, []);
});

/** An imported flow whose port count disagrees with raw/error settings warns rather than silently dropping (#154). */
test('mavlink-ai-in warns when declared outputs disagree with raw/error settings (#154)', () => {
  const RED = new MockRED().loadNodes();
  const conn = stubConnection(RED, 'c1');
  const node = RED.create('mavlink-ai-in', { id: 'in1', connection: 'c1', outputRaw: true, outputs: 1 });
  assert.ok(node.warnings.some((w) => /output count mismatch/.test(w)), 'expected an output-count warning');
  assert.ok(conn); // stubConnection registered
});
