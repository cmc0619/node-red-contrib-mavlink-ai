'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RouteTable } = require('../../lib/routing/route-table');
const { PacketRouter } = require('../../lib/routing/packet-router');

test('most specific route wins', () => {
  const table = new RouteTable([
    { sysid: 3, compid: '*', profile: 'PlaneDefault' },
    { sysid: 3, compid: 154, profile: 'PlaneCamera' },
    { sysid: '*', compid: '*', profile: 'Fallback' }
  ]);
  assert.strictEqual(table.match(3, 154).profile, 'PlaneCamera');
  assert.strictEqual(table.match(3, 1).profile, 'PlaneDefault');
  assert.strictEqual(table.match(9, 9).profile, 'Fallback');
});

test('parse handles JSON strings', () => {
  const table = RouteTable.parse('[{"sysid":1,"compid":"*","profile":"Copter"}]');
  assert.strictEqual(table.size, 1);
  assert.strictEqual(table.match(1, 1).profile, 'Copter');
});

test('parse is loud on malformed config', () => {
  assert.strictEqual(RouteTable.parse('').size, 0); // empty is fine
  assert.throws(() => RouteTable.parse('{not json'), /Invalid route table JSON/);
  assert.throws(() => RouteTable.parse('{"sysid":1}'), /must be an array/);
});

test('routed mode rejects unmatched by default', () => {
  const router = new PacketRouter({
    mode: 'routed',
    routes: [{ sysid: 1, compid: '*', profile: 'Copter' }],
    resolveProfile: (p) => p
  });
  assert.deepStrictEqual(router.route(1, 1), { accepted: true, profile: 'Copter' });
  assert.strictEqual(router.route(2, 1).accepted, false);
});

test('routed mode can fall back to default profile', () => {
  const router = new PacketRouter({
    mode: 'routed',
    unmatched: 'default',
    defaultProfile: 'DefaultProfile',
    routes: [{ sysid: 1, compid: '*', profile: 'Copter' }],
    resolveProfile: (p) => p
  });
  const decision = router.route(2, 1);
  assert.strictEqual(decision.accepted, true);
  assert.strictEqual(decision.profile, 'DefaultProfile');
});

test('single-profile mode applies accept filters', () => {
  const router = new PacketRouter({
    mode: 'single-profile',
    defaultProfile: 'Copter',
    acceptedSysids: [1]
  });
  assert.strictEqual(router.route(1, 1).accepted, true);
  assert.strictEqual(router.route(2, 1).accepted, false);
});

test('malformed non-empty sysid/compid throws instead of collapsing to wildcard (#71)', () => {
  // A typo must fail loudly, not silently widen the route to every system.
  assert.throws(() => new RouteTable([{ sysid: '1O', compid: 1, profile: 'Copter' }]), /Invalid route sysid at index 0/);
  assert.throws(() => new RouteTable([{ sysid: 1, compid: 'autopilot', profile: 'Copter' }]), /Invalid route compid at index 0/);
  // Out-of-range uint8 ids also fail.
  assert.throws(() => new RouteTable([{ sysid: 300, compid: 1, profile: 'Copter' }]), /out of the MAVLink 0\.\.255 id range/);
  // Explicit wildcards and valid ids still work.
  const ok = new RouteTable([
    { sysid: '*', compid: 'any', profile: 'A' },
    { sysid: 5, compid: 0, profile: 'B' }
  ]);
  assert.strictEqual(ok.size, 2);
});

test('a routing typo surfaces through RouteTable.parse (#71)', () => {
  assert.throws(() => RouteTable.parse('[{"sysid":"1O","compid":1,"profile":"Copter"}]'), /Invalid route sysid/);
});
