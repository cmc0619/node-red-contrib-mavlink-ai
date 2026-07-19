'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveWorkflowContext } = require('../../lib/util/workflow-profile');
const { MockRED } = require('../helpers/mock-red');

/**
 * Workflow context resolution vs the connection's inbound routing (#196).
 *
 * A workflow (mission, param, command await-ack) addressed at a target whose
 * inbound packets the connection REJECTS — routed mode unmatched-reject, a
 * route whose profile cannot resolve, or a single-profile accept filter — can
 * never complete: its own sends leave, but every reply from the target is
 * dropped before decode. Resolution must fail fast with ROUTE_REJECTED before
 * any packet reaches the wire, instead of running the workflow into a
 * guaranteed timeout.
 */

/** Minimal valid profile config-node stand-in. */
function profileStub(id, name, defaults = {}) {
  return {
    id,
    name,
    getDialect: () => ({ enums: null }),
    isValid: () => true,
    getDefaults: () => defaults
  };
}

test('a route-rejected target fails fast with ROUTE_REJECTED', () => {
  const connection = {
    profile: profileStub('p1', 'Default', { defaultTargetSystem: 1, defaultTargetComponent: 1 }),
    getRouteDecision: () => ({ accepted: false, profile: null, reason: 'unmatched-reject' })
  };
  assert.throws(
    () => resolveWorkflowContext(connection, { targetSystem: 5, targetComponent: 1 }),
    (err) => {
      assert.strictEqual(err.code, 'ROUTE_REJECTED');
      assert.strictEqual(err.context.reason, 'unmatched-reject');
      assert.strictEqual(err.context.targetSystem, 5);
      return true;
    }
  );
});

test('an explicit profile override does not bypass the route-reject fail-fast', () => {
  /**
   * The explicit profile only changes which dialect the workflow encodes
   * with — inbound replies from a route-rejected target are still dropped, so
   * the workflow is just as doomed. The check applies to both paths.
   */
  const explicit = profileStub('p2', 'Override', { defaultTargetSystem: 7 });
  const connection = {
    profile: profileStub('p1', 'Default', {}),
    resolveProfile: (ref) => (ref === 'p2' ? explicit : { name: ref }),
    getRouteDecision: () => ({ accepted: false, profile: null, reason: 'unmatched-reject' })
  };
  assert.throws(
    () => resolveWorkflowContext(connection, { profile: 'p2' }),
    (err) => err.code === 'ROUTE_REJECTED'
  );
});

test('an accepted decision routes the workflow to the target profile', () => {
  const routed = profileStub('p_routed', 'Routed', { preferredMissionItemType: 'MISSION_ITEM' });
  const connection = {
    profile: profileStub('p1', 'Default', { defaultTargetSystem: 2 }),
    getRouteDecision: ({ sysid }) =>
      sysid === 2 ? { accepted: true, profile: routed } : { accepted: false, profile: null, reason: 'unmatched-reject' }
  };
  const ctx = resolveWorkflowContext(connection, {});
  assert.strictEqual(ctx.profile, routed);
  assert.strictEqual(ctx.defaults.preferredMissionItemType, 'MISSION_ITEM');
  assert.strictEqual(ctx.targetSystem, 2);
});

test('an accepted decision never overrides an explicit profile', () => {
  const routed = profileStub('p_routed', 'Routed', {});
  const explicit = profileStub('p2', 'Override', {});
  const connection = {
    profile: profileStub('p1', 'Default', {}),
    resolveProfile: (ref) => (ref === 'p2' ? explicit : { name: ref }),
    getRouteDecision: () => ({ accepted: true, profile: routed })
  };
  const ctx = resolveWorkflowContext(connection, { profile: 'p2', targetSystem: 3 });
  assert.strictEqual(ctx.profile, explicit, 'explicit override must win over routing');
});

test('the connection node exposes the router decision, reject reason included (#196)', (t) => {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'routed', unmatchedPolicy: 'reject',
    routeTable: JSON.stringify([{ sysid: 1, compid: '*', profile: 'p1' }])
  });
  t.after(() => RED.close(conn));

  const hit = conn.getRouteDecision({ sysid: 1, compid: 1 });
  assert.strictEqual(hit.accepted, true);
  assert.ok(hit.profile, 'matched route resolves its profile');

  const miss = conn.getRouteDecision({ sysid: 99, compid: 1 });
  assert.strictEqual(miss.accepted, false);
  assert.strictEqual(miss.reason, 'unmatched-reject');
});

test('component-broadcast targets (compid 0) use any-responder semantics, not a literal compid-0 probe', (t) => {
  /**
   * Codex review on #302: a workflow addressed at target_component 0
   * (MAV_COMP_ID_ALL) accepts replies from ANY component of the target
   * system. A component-specific route table like 1:1 must therefore not
   * fail-fast the (1, 0) workflow — replies from component 1 would be
   * accepted. Only a target no component of which could get through is
   * rejected.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'routed', unmatchedPolicy: 'reject',
    routeTable: JSON.stringify([{ sysid: 1, compid: 1, profile: 'p1' }])
  });
  t.after(() => RED.close(conn));

  /** compid 0 is viable: the 1:1 route accepts replies from component 1. */
  const broadcast = conn.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(broadcast.accepted, true);
  assert.ok(broadcast.profile, 'the sysid-matching route supplies the profile');

  /** A specific unrouted component still fails fast. */
  assert.strictEqual(conn.getRouteDecision({ sysid: 1, compid: 2 }).accepted, false);

  /** A sysid no route matches is rejected even as a component broadcast. */
  const off = conn.getRouteDecision({ sysid: 2, compid: 0 });
  assert.strictEqual(off.accepted, false);
  assert.strictEqual(off.reason, 'unmatched-reject');
});

test('single-profile compid accept filters cannot reject a component-broadcast target', (t) => {
  /**
   * With acceptedCompids [1], replies from component 1 pass the filter, so a
   * (1, 0) workflow is viable; only the sysid filter can make it hopeless.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'single-profile', acceptedSysids: '1', acceptedCompids: '1'
  });
  t.after(() => RED.close(conn));

  assert.strictEqual(conn.getRouteDecision({ sysid: 1, compid: 0 }).accepted, true);
  const badSysid = conn.getRouteDecision({ sysid: 9, compid: 0 });
  assert.strictEqual(badSysid.accepted, false);
  assert.strictEqual(badSysid.reason, 'sysid-rejected');
});

test('unmatched-default does not shadow a sysid-matching responder route for compid-0 targets', (t) => {
  /**
   * Codex review round 2 on #302: with unmatchedPolicy 'default', the literal
   * (1, 0) probe is accepted by the unmatched-default fallback — but replies
   * from component 1 will be decoded under the 1:1 route's profile, so the
   * workflow must adopt THAT profile, not the connection default. Only a
   * literal route match short-circuits; unmatched-default keeps looking for a
   * sysid-matching responder route first.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Default', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'p2', name: 'Routed', vehicleFamily: 'generic', dialect: 'ardupilotmega', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'routed', unmatchedPolicy: 'default',
    routeTable: JSON.stringify([{ sysid: 1, compid: 1, profile: 'p2' }])
  });
  t.after(() => RED.close(conn));

  /** The 1:1 responder route wins over the unmatched-default fallback. */
  const broadcast = conn.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(broadcast.accepted, true);
  assert.strictEqual(broadcast.profile && broadcast.profile.id, 'p2');

  /** No responder route for sysid 2: the unmatched-default fallback stands. */
  const off = conn.getRouteDecision({ sysid: 2, compid: 0 });
  assert.strictEqual(off.accepted, true);
  assert.strictEqual(off.profile && off.profile.id, 'p1');

  /** A literal component route match still short-circuits untouched. */
  const literal = conn.getRouteDecision({ sysid: 1, compid: 1 });
  assert.strictEqual(literal.profile && literal.profile.id, 'p2');
});

test('broadcast and out-of-range targets skip the route check for the node guards to reject', () => {
  /**
   * Codex review round 2 on #302: target_system 0 and out-of-range ids are
   * invalid INPUT, not routing problems. The route fail-fast must not
   * preempt the nodes' BROADCAST_NO_ACK / INVALID_FIELD guards — those carry
   * the safety-specific messaging for destructive broadcast workflows (#197).
   */
  const rejectAll = {
    profile: profileStub('p1', 'Default', { defaultTargetSystem: 1, defaultTargetComponent: 1 }),
    getRouteDecision: () => ({ accepted: false, profile: null, reason: 'unmatched-reject' })
  };
  /** Broadcast sysid: resolves without throwing; the node guard fires next. */
  const ctx = resolveWorkflowContext(rejectAll, { targetSystem: 0 });
  assert.strictEqual(ctx.targetSystem, 0);
  /** Out-of-range / non-integer ids: same — INVALID_FIELD is the right error. */
  assert.strictEqual(resolveWorkflowContext(rejectAll, { targetSystem: 999 }).targetSystem, 999);
  assert.strictEqual(resolveWorkflowContext(rejectAll, { targetSystem: 1, targetComponent: 400 }).targetComponent, 400);
  /** A valid unicast target still fails fast. */
  assert.throws(
    () => resolveWorkflowContext(rejectAll, { targetSystem: 5, targetComponent: 1 }),
    (err) => err.code === 'ROUTE_REJECTED'
  );
});
