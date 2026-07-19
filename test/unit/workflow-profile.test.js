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

test('a compid-0-only route cannot make a component-broadcast target viable', (t) => {
  /**
   * Codex review round 3 on #302: replies to a target_component-0 request
   * come from REAL (nonzero) component ids. A route matching only compid 0
   * itself (1:0) accepts no actual responder, so with unmatched 'reject' the
   * workflow is still hopeless and must fail fast — while with unmatched
   * 'default' real responders decode under the default profile, so the
   * target is viable via the fallback.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const make = (unmatchedPolicy, id) => RED.create('mavlink-ai-connection', {
    id, name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'routed', unmatchedPolicy,
    routeTable: JSON.stringify([{ sysid: 1, compid: 0, profile: 'p1' }])
  });
  const rejecting = make('reject', 'c1');
  const defaulting = make('default', 'c2');
  t.after(() => { RED.close(rejecting); RED.close(defaulting); });

  const rej = rejecting.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(rej.accepted, false, 'no real responder component can get through');

  const def = defaulting.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(def.accepted, true, 'real responders decode under the default profile');
  assert.strictEqual(def.profile && def.profile.id, 'p1');
});

test('a compid-0-only accept filter rejects a component-broadcast target', (t) => {
  /**
   * Same round-3 case in single-profile mode: acceptedCompids [0] admits no
   * real responder component, so (1, 0) must fail fast; adding any nonzero
   * component to the filter makes it viable again.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const make = (acceptedCompids, id) => RED.create('mavlink-ai-connection', {
    id, name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'single-profile', acceptedSysids: '1', acceptedCompids
  });
  const zeroOnly = make('0', 'c1');
  const zeroAndOne = make('0,1', 'c2');
  t.after(() => { RED.close(zeroOnly); RED.close(zeroAndOne); });

  const rej = zeroOnly.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(rej.accepted, false);
  assert.strictEqual(rej.reason, 'compid-rejected');

  assert.strictEqual(zeroAndOne.getRouteDecision({ sysid: 1, compid: 0 }).accepted, true);
});

test('an unresolvable compid-wildcard route shadows all responders and rejects compid-0 targets', (t) => {
  /**
   * Codex review round 4 on #302: inbound route() rejects a packet on its
   * FIRST matching route. An unresolvable 1:* route is the first match for
   * every real responder component of system 1, so nothing gets through even
   * under unmatchedPolicy 'default' — the compid-0 viability scan must
   * reject with profile-unresolved, not fall through to the fallback. An
   * unresolvable compid-EXACT route only shadows its own component, so
   * falling through past it stays correct.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const make = (routeTable, id) => RED.create('mavlink-ai-connection', {
    id, name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'routed', unmatchedPolicy: 'default',
    routeTable: JSON.stringify(routeTable)
  });
  /** 1:* -> missing shadows every responder: reject despite unmatched-default. */
  const shadowed = make([{ sysid: 1, compid: '*', profile: 'missing' }], 'c1');
  /** 1:5 -> missing shadows only component 5; 1:* -> p1 carries the rest. */
  const partial = make([
    { sysid: 1, compid: 5, profile: 'missing' },
    { sysid: 1, compid: '*', profile: 'p1' }
  ], 'c2');
  /** 1:5 -> missing alone: other components fall to the default profile. */
  const exactOnly = make([{ sysid: 1, compid: 5, profile: 'missing' }], 'c3');
  t.after(() => { RED.close(shadowed); RED.close(partial); RED.close(exactOnly); });

  const rej = shadowed.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(rej.accepted, false);
  assert.strictEqual(rej.reason, 'profile-unresolved');

  const viaWildcard = partial.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(viaWildcard.accepted, true);
  assert.strictEqual(viaWildcard.profile && viaWildcard.profile.id, 'p1');

  const viaDefault = exactOnly.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(viaDefault.accepted, true);
  assert.strictEqual(viaDefault.profile && viaDefault.profile.id, 'p1');
});

test('a route to an existing but invalid profile rejects the workflow target (profile-invalid)', (t) => {
  /**
   * Codex review round 5 on #302: a route can resolve to a Vehicle Profile
   * node whose dialect failed to load. Inbound replies matching that route
   * are rejected as profile-invalid before subscribers see them, so the
   * workflow is exactly as doomed as with an unresolvable route — the
   * decision must reject, not accept-without-adoption. Same shadowing rules
   * as unresolvable routes for compid-0 targets: a wildcard-compid invalid
   * route blocks everything, an exact one only its own component.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Good', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-vehicle', {
    id: 'pBad', name: 'Broken', vehicleFamily: 'generic', dialect: 'no-such-dialect', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const make = (routeTable, unmatchedPolicy, id) => RED.create('mavlink-ai-connection', {
    id, name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'routed', unmatchedPolicy,
    routeTable: JSON.stringify(routeTable)
  });
  const direct = make([{ sysid: 1, compid: 1, profile: 'pBad' }], 'reject', 'c1');
  const shadowAll = make([{ sysid: 1, compid: '*', profile: 'pBad' }], 'default', 'c2');
  const partial = make([
    { sysid: 1, compid: 5, profile: 'pBad' },
    { sysid: 1, compid: '*', profile: 'p1' }
  ], 'reject', 'c3');
  t.after(() => { RED.close(direct); RED.close(shadowAll); RED.close(partial); });

  /** A literal match on an invalid profile is a rejection, not an adoption skip. */
  const lit = direct.getRouteDecision({ sysid: 1, compid: 1 });
  assert.strictEqual(lit.accepted, false);
  assert.strictEqual(lit.reason, 'profile-invalid');

  /** compid-0: an invalid 1:* route shadows every responder despite unmatched-default. */
  const rej = shadowAll.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(rej.accepted, false);
  assert.strictEqual(rej.reason, 'profile-invalid');

  /** compid-0: an invalid exact route only shadows component 5; 1:* -> p1 carries the rest. */
  const ok = partial.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(ok.accepted, true);
  assert.strictEqual(ok.profile && ok.profile.id, 'p1');
});

test('malformed target ids that coerce in-range skip the route check for strict validation to reject', () => {
  /**
   * Codex review round 6 on #302: Number('') and Number(true) coerce to
   * in-range 0/1, so a hand-rolled numeric gate would route-check them and a
   * reject-policy connection would emit ROUTE_REJECTED — shadowing the
   * nodes' strict INVALID_FIELD validation that runs right after context
   * resolution. The gate uses the same strict validators as the nodes, so
   * exactly the values they reject skip the route check.
   */
  const rejectAll = {
    profile: profileStub('p1', 'Default', { defaultTargetSystem: 1, defaultTargetComponent: 1 }),
    getRouteDecision: () => ({ accepted: false, profile: null, reason: 'unmatched-reject' })
  };
  for (const bad of ['', '   ', true, false]) {
    const ctx = resolveWorkflowContext(rejectAll, { targetSystem: 1, targetComponent: bad });
    assert.strictEqual(ctx.targetComponent, bad, `targetComponent ${JSON.stringify(bad)} must pass through unrouted`);
    const ctx2 = resolveWorkflowContext(rejectAll, { targetSystem: bad, targetComponent: 1 });
    assert.strictEqual(ctx2.targetSystem, bad, `targetSystem ${JSON.stringify(bad)} must pass through unrouted`);
  }
  /** Numeric strings are valid ids for the nodes, so they still fail fast. */
  assert.throws(
    () => resolveWorkflowContext(rejectAll, { targetSystem: '5', targetComponent: '1' }),
    (err) => err.code === 'ROUTE_REJECTED'
  );
});

test('a shadowed exact route cannot revive a compid-0 target via a less-specific same-component route', (t) => {
  /**
   * Codex review round 7 on #302: with 1:5 -> missing and *:5 -> good under
   * unmatchedPolicy 'reject', inbound replies from (1,5) match the broken
   * 1:5 route first and are rejected — and no other component can pass,
   * because *:5 only admits the same shadowed component. The scan must not
   * count a later exact route for a component already shadowed by a broken
   * more-specific route. A later exact route for a DIFFERENT component
   * (*:6) still makes the target viable.
   */
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'Good', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const make = (routeTable, id) => RED.create('mavlink-ai-connection', {
    id, name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    routingMode: 'routed', unmatchedPolicy: 'reject',
    routeTable: JSON.stringify(routeTable)
  });
  const revived = make([
    { sysid: 1, compid: 5, profile: 'missing' },
    { sysid: '*', compid: 5, profile: 'p1' }
  ], 'c1');
  const otherComponent = make([
    { sysid: 1, compid: 5, profile: 'missing' },
    { sysid: '*', compid: 6, profile: 'p1' }
  ], 'c2');
  t.after(() => { RED.close(revived); RED.close(otherComponent); });

  /** *:5 only admits the component the broken 1:5 already shadows. */
  const rej = revived.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(rej.accepted, false);
  assert.strictEqual(rej.reason, 'profile-unresolved');

  /** *:6 admits component 6, whose first match it is — still viable. */
  const ok = otherComponent.getRouteDecision({ sysid: 1, compid: 0 });
  assert.strictEqual(ok.accepted, true);
  assert.strictEqual(ok.profile && ok.profile.id, 'p1');
});
