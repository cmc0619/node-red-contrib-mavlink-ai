'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MockRED } = require('../helpers/mock-red');

/**
 * Routed mode with an empty route table and the default 'reject' policy fails
 * closed — every inbound packet is rejected (#150). That is correct, but silent
 * per-packet, so it presents as a dead link (no messages, not even heartbeats)
 * with no error. The connection warns once at deploy so the misconfiguration is
 * diagnosable.
 */

function profile(RED) {
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', vehicleFamily: 'generic', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
}

function connection(RED, extra) {
  return RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false,
    ...extra
  });
}

const routedWarn = /routed.*no routes.*rejected/i;

test('routed mode with no routes and reject policy warns at deploy (#150)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED);
  const conn = connection(RED, { routingMode: 'routed', unmatchedPolicy: 'reject', routeTable: '[]' });
  t.after(() => RED.close(conn));
  assert.ok(conn.warnings.some((w) => routedWarn.test(String(w))), 'expected a routed-no-routes warning');
});

test('routed mode with no routes but unmatched=default does not warn (decodes with default) (#150)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED);
  const conn = connection(RED, { routingMode: 'routed', unmatchedPolicy: 'default', routeTable: '[]' });
  t.after(() => RED.close(conn));
  assert.ok(!conn.warnings.some((w) => routedWarn.test(String(w))), 'unmatched=default should not warn');
});

test('routed mode with a route does not warn (#150)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED);
  const conn = connection(RED, {
    routingMode: 'routed', unmatchedPolicy: 'reject',
    routeTable: JSON.stringify([{ sysid: 1, compid: '*', profile: 'p1' }])
  });
  t.after(() => RED.close(conn));
  assert.ok(!conn.warnings.some((w) => routedWarn.test(String(w))), 'a populated route table should not warn');
});

test('single-profile mode does not warn (#150)', (t) => {
  const RED = new MockRED().loadNodes();
  profile(RED);
  const conn = connection(RED, { routingMode: 'single-profile' });
  t.after(() => RED.close(conn));
  assert.ok(!conn.warnings.some((w) => routedWarn.test(String(w))), 'single-profile should not warn');
});
