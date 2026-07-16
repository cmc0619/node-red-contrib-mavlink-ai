'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { PRIORITY, commandPriority, commandPriorityFor, clampPriority } = require('../../lib/runtime/send-priority');
const { CommandSend } = require('../../lib/command/command-workflow');
const { OutboundQueue } = require('../../lib/runtime/outbound-queue');

test('the critical set is exactly the documented safety commands (#241)', () => {
  for (const id of [400, 176, 185, 208]) {
    assert.strictEqual(commandPriority(id), PRIORITY.CRITICAL, `MAV_CMD ${id} is critical`);
  }
  for (const id of [16, 22, 20, 511]) {
    assert.strictEqual(commandPriority(id), PRIORITY.NORMAL, `MAV_CMD ${id} rides normal`);
  }
});

test('commandPriorityFor resolves names against MavCmd only (#241)', () => {
  const enums = loadDialect('ardupilotmega').enums;
  assert.strictEqual(commandPriorityFor(enums, 'MAV_CMD_COMPONENT_ARM_DISARM'), PRIORITY.CRITICAL);
  assert.strictEqual(commandPriorityFor(enums, 'MAV_CMD_DO_PARACHUTE'), PRIORITY.CRITICAL);
  assert.strictEqual(commandPriorityFor(enums, 'MAV_CMD_NAV_TAKEOFF'), PRIORITY.NORMAL);
  assert.strictEqual(commandPriorityFor(enums, 400), PRIORITY.CRITICAL, 'numeric id passes through');
  /** A cross-enum name whose value collides with a critical id must not match. */
  assert.strictEqual(commandPriorityFor(enums, 'MAV_STATE_EMERGENCY'), PRIORITY.NORMAL);
  /** Without enums a name cannot be identified — never guess critical. */
  assert.strictEqual(commandPriorityFor(null, 'MAV_CMD_COMPONENT_ARM_DISARM'), PRIORITY.NORMAL);
});

test('clampPriority bounds the advanced override into valid bands (#241)', () => {
  assert.strictEqual(clampPriority(undefined), undefined);
  assert.strictEqual(clampPriority(null), undefined);
  assert.strictEqual(clampPriority(''), undefined);
  assert.strictEqual(clampPriority('   '), undefined, "whitespace is 'left blank', not band 0");
  assert.strictEqual(clampPriority('nope'), undefined);
  assert.strictEqual(clampPriority(NaN), undefined);
  /** Number(false) is 0 — a boolean "not a priority" flag must not claim CRITICAL. */
  assert.strictEqual(clampPriority(false), undefined);
  assert.strictEqual(clampPriority(true), undefined);
  assert.strictEqual(clampPriority({}), undefined);
  assert.strictEqual(clampPriority([]), undefined);
  assert.strictEqual(clampPriority(0), 0);
  assert.strictEqual(clampPriority('2'), 2);
  assert.strictEqual(clampPriority(1.7), 1, 'truncated to an integer band');
  assert.strictEqual(clampPriority(-5), 0, 'cannot invent a band above critical');
  assert.strictEqual(clampPriority(99), 3, 'cannot park below background');
});

/**
 * A stub connection that records every send with its options and can deliver
 * an accepted COMMAND_ACK to settle the workflow.
 */
function stubConnection() {
  const conn = { sent: [], _subs: [] };
  conn.send = (message, options) => {
    conn.sent.push({ message, options });
    return Promise.resolve();
  };
  conn.subscribe = (filter, cb) => conn._subs.push(cb) - 1;
  conn.unsubscribe = () => true;
  conn.acquireLock = () => ({ release: () => {} });
  conn.ack = (command, targetSystem) => {
    for (const cb of conn._subs) {
      cb({ payload: { name: 'COMMAND_ACK', sysid: 1, fields: { command, result: 0, target_system: targetSystem } } });
    }
  };
  return conn;
}

test('the command workflow stamps the policy band on every send (#241)', async () => {
  /** Arm/disarm rides CRITICAL... */
  const armConn = stubConnection();
  const arm = new CommandSend({ connection: armConn, targetSystem: 1, targetComponent: 1, command: 400 });
  const armRun = arm.run();
  assert.strictEqual(armConn.sent[0].options.priority, PRIORITY.CRITICAL);
  armConn.ack(400, 255);
  await armRun;

  /** ...an ordinary command rides NORMAL. */
  const navConn = stubConnection();
  const nav = new CommandSend({ connection: navConn, targetSystem: 1, targetComponent: 1, command: 22 });
  const navRun = nav.run();
  assert.strictEqual(navConn.sent[0].options.priority, PRIORITY.NORMAL);
  navConn.ack(22, 255);
  await navRun;
});

test('a critical command overtakes queued normal traffic without reordering it (#241)', async () => {
  const written = [];
  let releaseFirst;
  const firstGate = new Promise((r) => (releaseFirst = r));
  let calls = 0;
  const queue = new OutboundQueue((buf) => {
    calls += 1;
    written.push(buf[0]);
    return calls === 1 ? firstGate : Promise.resolve();
  });

  /** An in-flight normal item, a backlog of normal-band mission-ish traffic,
   * then an arm command at the policy's critical band. */
  const inflight = queue.enqueue(Buffer.from([1]), PRIORITY.NORMAL);
  const m1 = queue.enqueue(Buffer.from([2]), PRIORITY.NORMAL);
  const m2 = queue.enqueue(Buffer.from([3]), PRIORITY.NORMAL);
  const arm = queue.enqueue(Buffer.from([9]), commandPriority(400));
  releaseFirst();
  await Promise.all([inflight, m1, m2, arm]);

  /** The critical send jumps the backlog; the normal items keep FIFO order. */
  assert.deepStrictEqual(written, [1, 9, 2, 3]);
});
