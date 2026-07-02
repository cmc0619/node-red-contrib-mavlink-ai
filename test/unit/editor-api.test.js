'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { registerEditorApi } = require('../../lib/editor-api');

// Minimal RED.httpAdmin capture so we can invoke the route handlers directly.
// Registration is intentionally idempotent (guarded), so we register once on a
// shared RED and reuse its captured routes across tests.
const routes = {};
const RED = {
  auth: { needsPermission: () => (req, res, next) => next() },
  httpAdmin: {
    get(path, ...handlers) {
      routes[path] = handlers[handlers.length - 1];
    }
  }
};
registerEditorApi(RED);

function invoke(handler, query) {
  return new Promise((resolve) => {
    const res = {
      _status: 200,
      status(code) {
        this._status = code;
        return this;
      },
      json(body) {
        resolve({ status: this._status, body });
      }
    };
    handler({ query: query || {} }, res);
  });
}

test('registerEditorApi is a no-op without httpAdmin (does not throw)', () => {
  assert.doesNotThrow(() => registerEditorApi({}));
  assert.doesNotThrow(() => registerEditorApi(null));
});

test('routes are registered', () => {
  assert.ok(routes['/mavlink-ai/metadata'], 'metadata route registered');
  assert.ok(routes['/mavlink-ai/dialects'], 'dialects route registered');
});

test('metadata endpoint serves messages + enums + field enum mapping', async () => {
  const { status, body } = await invoke(routes['/mavlink-ai/metadata'], { dialect: 'ardupilotmega' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.ok(body.messages.COMMAND_LONG);
  const cmd = body.messages.COMMAND_LONG.fields.find((f) => f.name === 'command');
  assert.strictEqual(cmd.enum, 'MAV_CMD');
  assert.ok(body.enums.MAV_CMD.some((e) => e.name === 'MAV_CMD_COMPONENT_ARM_DISARM' && e.value === 400));
  // The endpoint must forward command-specific param metadata, or the command
  // editor falls back to raw param1..7 for every MAV_CMD (#7).
  assert.ok(body.commands, 'commands present in response');
  const wp = body.commands.MAV_CMD_NAV_WAYPOINT;
  assert.ok(wp && wp.params && wp.params.length, 'NAV_WAYPOINT has named params');
  assert.strictEqual(wp.params[0].name, 'hold');
  // The exact command from the UI report must also carry named params.
  assert.ok(body.commands.MAV_CMD_DO_ILLUMINATOR_CONFIGURE, 'DO_ILLUMINATOR_CONFIGURE has named params');
});

test('metadata endpoint reports invalid dialect without throwing', async () => {
  const { body } = await invoke(routes['/mavlink-ai/metadata'], { dialect: 'nope' });
  assert.strictEqual(body.ok, false);
});

test('metadata endpoint serves a custom-XML dialect via customDialectPath', async () => {
  const path = require('path');
  const customDialectPath = path.join(__dirname, '..', 'fixtures', 'dialects', 'custom_vehicle.xml');
  const { body } = await invoke(routes['/mavlink-ai/metadata'], { dialect: 'custom', customDialectPath });
  assert.strictEqual(body.ok, true);
  // Messages come from the compiled registry (base + custom).
  assert.ok(body.messages.HEARTBEAT);
  assert.ok(body.messages.CUSTOM_VEHICLE_STATUS);
  // Without the path, 'custom' alone is (correctly) not resolvable.
  const bare = await invoke(routes['/mavlink-ai/metadata'], { dialect: 'custom' });
  assert.strictEqual(bare.body.ok, false);
});

test('dialects endpoint lists all loader dialects (dynamic discovery, #4)', async () => {
  const { knownDialects } = require('../../lib/dialects/dialect-loader');
  const { body } = await invoke(routes['/mavlink-ai/dialects']);
  assert.ok(Array.isArray(body.dialects));
  assert.ok(body.dialects.includes('ardupilotmega'));
  assert.ok(body.dialects.includes('common'));
  // The endpoint must expose the full loader list so the profile dropdown does
  // not need hand-editing when a dialect is added.
  assert.deepStrictEqual([...body.dialects].sort(), [...knownDialects()].sort());
});
