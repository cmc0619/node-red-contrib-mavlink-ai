'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ardupilotmega } = require('node-mavlink');
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
    },
    post(path, ...handlers) {
      routes['POST ' + path] = handlers[handlers.length - 1];
    }
  }
};
registerEditorApi(RED);

function invoke(handler, query, body) {
  return new Promise((resolve) => {
    const res = {
      _status: 200,
      status(code) {
        this._status = code;
        return this;
      },
      json(payload) {
        resolve({ status: this._status, body: payload });
      }
    };
    handler({ query: query || {}, body: body || {} }, res);
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

test('modes endpoint serves firmware/vehicle-aware flight-mode names (#49)', async () => {
  const copter = await invoke(routes['/mavlink-ai/modes'], {
    firmware: 'ardupilot',
    vehicleType: 'copter',
    dialect: 'ardupilotmega'
  });
  assert.strictEqual(copter.body.ok, true);
  assert.ok(copter.body.modes.includes('GUIDED'));
  assert.ok(copter.body.modes.includes('LOITER'));
  const plane = await invoke(routes['/mavlink-ai/modes'], {
    firmware: 'ardupilot',
    vehicleType: 'plane',
    dialect: 'ardupilotmega'
  });
  assert.ok(plane.body.modes.includes('FLY_BY_WIRE_A'));
  assert.ok(plane.body.modes.includes('INITIALIZING'));
  assert.ok(!plane.body.modes.includes('FBWA'));
  const px4 = await invoke(routes['/mavlink-ai/modes'], { firmware: 'px4', dialect: 'ardupilotmega' });
  assert.ok(px4.body.modes.includes('OFFBOARD'));
  // Unsupported combination: empty list, so the editor falls back to numerics.
  const generic = await invoke(routes['/mavlink-ai/modes'], { firmware: 'generic', dialect: 'ardupilotmega' });
  assert.deepStrictEqual(generic.body.modes, []);
});

test('modes endpoint fails without a valid active dialect', async () => {
  const missing = await invoke(routes['/mavlink-ai/modes'], { firmware: 'ardupilot', vehicleType: 'copter' });
  assert.strictEqual(missing.body.ok, false);
  assert.ok(missing.body.error);
  const invalid = await invoke(routes['/mavlink-ai/modes'], {
    firmware: 'ardupilot',
    vehicleType: 'copter',
    dialect: 'not-a-dialect'
  });
  assert.strictEqual(invalid.body.ok, false);
  assert.ok(invalid.body.error);
});

test('param-choices endpoint resolves Copter vs Plane modes (GUIDED 4 vs 15) (#97)', async () => {
  const copter = await invoke(routes['/mavlink-ai/param-choices'], {
    resolver: 'profile-flight-mode',
    firmware: 'ardupilot',
    vehicleType: 'copter',
    dialect: 'ardupilotmega'
  });
  assert.strictEqual(copter.body.ok, true);
  assert.strictEqual(copter.body.scope, 'profile');
  assert.strictEqual(copter.body.generic, false);
  assert.strictEqual(copter.body.choices.find((c) => c.name === 'GUIDED').value, ardupilotmega.CopterMode.GUIDED);
  const plane = await invoke(routes['/mavlink-ai/param-choices'], {
    resolver: 'profile-flight-mode',
    firmware: 'ardupilot',
    vehicleType: 'plane',
    dialect: 'ardupilotmega'
  });
  assert.strictEqual(plane.body.choices.find((c) => c.name === 'GUIDED').value, ardupilotmega.PlaneMode.GUIDED);
  assert.ok(plane.body.choices.some((c) => c.name === 'FLY_BY_WIRE_A'));
  assert.ok(!plane.body.choices.some((c) => c.name === 'FBWA'));
});

test('param-choices endpoint resolves component-specific choices from the dialect (#97)', async () => {
  const camera = await invoke(routes['/mavlink-ai/param-choices'], {
    resolver: 'component-mode',
    componentType: 'camera',
    dialect: 'ardupilotmega'
  });
  assert.strictEqual(camera.body.ok, true);
  assert.strictEqual(camera.body.enum, 'CAMERA_MODE');
  assert.ok(camera.body.choices.length > 0);
  const gimbal = await invoke(routes['/mavlink-ai/param-choices'], {
    resolver: 'component-mode',
    componentType: 'gimbal',
    dialect: 'ardupilotmega'
  });
  assert.strictEqual(gimbal.body.enum, 'MAV_MOUNT_MODE');
});

test('metadata endpoint forwards control metadata on raw command params (#97)', async () => {
  const { body } = await invoke(routes['/mavlink-ai/metadata'], { dialect: 'ardupilotmega' });
  const setMode = body.commands.MAV_CMD_DO_SET_MODE.params;
  assert.strictEqual(setMode.find((p) => p.index === 1).bitmask, 'MAV_MODE_FLAG');
  assert.strictEqual(setMode.find((p) => p.index === 2).resolver, 'profile-flight-mode');
  const speedType = body.commands.MAV_CMD_DO_CHANGE_SPEED.params.find((p) => p.index === 1);
  assert.strictEqual(speedType.enum, 'SPEED_TYPE');
});

test('registerEditorApi registers routes per RED instance, not once per process (#35)', () => {
  function makeRed() {
    const captured = {};
    return {
      captured,
      auth: { needsPermission: () => (req, res, next) => next() },
      httpAdmin: {
        get(path, ...handlers) {
          captured[path] = handlers[handlers.length - 1];
        },
        post(path, ...handlers) {
          captured['POST ' + path] = handlers[handlers.length - 1];
        }
      }
    };
  }
  const redA = makeRed();
  const redB = makeRed();
  registerEditorApi(redA);
  registerEditorApi(redB); // a second runtime in the same process
  assert.ok(redA.captured['/mavlink-ai/dialects']);
  assert.ok(redB.captured['/mavlink-ai/dialects'], 'second RED instance must get its routes too');

  // Re-registering the same instance stays idempotent (no double-registration).
  const before = Object.keys(redA.captured).length;
  registerEditorApi(redA);
  assert.strictEqual(Object.keys(redA.captured).length, before);
});

test('xml-catalog endpoints: update (fetch-stubbed), list, and compare (#61)', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-red-'));

  const captured = {};
  const RED2 = {
    settings: { userDir },
    auth: { needsPermission: () => (req, res, next) => next() },
    httpAdmin: {
      get(p, ...h) {
        captured['GET ' + p] = h[h.length - 1];
      },
      post(p, ...h) {
        captured['POST ' + p] = h[h.length - 1];
      }
    }
  };
  registerEditorApi(RED2);

  // A self-contained minimal.xml (differs from the bundled 'minimal').
  const minimalXml =
    '<?xml version="1.0"?><mavlink><messages>' +
    '<message id="0" name="HEARTBEAT"><field type="uint8_t" name="type">t</field></message>' +
    '<message id="9600" name="CATALOG_ENDPOINT_MSG"><field type="uint8_t" name="v">v</field></message>' +
    '</messages></mavlink>';

  const origFetch = global.fetch;
  const COMMIT = '1234567890abcdef1234567890abcdef12345678';
  global.fetch = async (url) => {
    if (/\/commits\//.test(url)) {
      // The ref is pinned to a commit before any download (#88).
      return { ok: true, status: 200, statusText: 'OK', text: async () => COMMIT };
    }
    if (/minimal\.xml$/.test(url)) {
      // Files must be fetched at the pinned commit, not the mutable ref.
      assert.ok(String(url).includes(COMMIT), `file fetched at the pinned commit: ${url}`);
      return { ok: true, status: 200, statusText: 'OK', text: async () => minimalXml };
    }
    // any other file: not found.
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
  };
  try {
    const upd = await invoke(captured['POST /mavlink-ai/xml-catalog/update'], {}, {
      repo: 'mavlink/mavlink',
      ref: 'master',
      files: ['minimal.xml']
    });
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(upd.body.ok, true);
    assert.deepStrictEqual(upd.body.manifest.files.map((f) => f.name), ['minimal.xml']);

    const list = await invoke(captured['GET /mavlink-ai/xml-catalog']);
    assert.strictEqual(list.body.ok, true);
    assert.strictEqual(list.body.snapshots.length, 1);
    const fileEntry = list.body.snapshots[0].files[0];
    assert.strictEqual(fileEntry.dialect, 'minimal');
    assert.strictEqual(fileEntry.bundledExists, true); // 'minimal' is bundled

    const cmp = await invoke(captured['GET /mavlink-ai/xml-catalog/compare'], { file: 'minimal.xml' });
    assert.strictEqual(cmp.body.ok, true);
    assert.strictEqual(cmp.body.comparison.comparable, true);
    assert.ok(cmp.body.comparison.diff.addedMessages.includes('CATALOG_ENDPOINT_MSG'));

    // Comparing a file that was never downloaded is a 404.
    const missing = await invoke(captured['GET /mavlink-ai/xml-catalog/compare'], { file: 'nope.xml' });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body.ok, false);
  } finally {
    global.fetch = origFetch;
  }
});

test('param-catalog endpoints: source discovery, update (fetch-stubbed), params, and param (#125)', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-red-params-'));

  const captured = {};
  const RED3 = {
    settings: { userDir },
    auth: { needsPermission: () => (req, res, next) => next() },
    httpAdmin: {
      get(p, ...h) {
        captured['GET ' + p] = h[h.length - 1];
      },
      post(p, ...h) {
        captured['POST ' + p] = h[h.length - 1];
      }
    }
  };
  registerEditorApi(RED3);

  /** Generic firmware has no source — the editor keeps free-text/numeric. */
  const generic = await invoke(captured['GET /mavlink-ai/param-catalog'], { firmware: 'generic' });
  assert.strictEqual(generic.body.ok, true);
  assert.strictEqual(generic.body.source, null);

  /** ArduPilot copter resolves a source but nothing is cached yet. */
  const before = await invoke(captured['GET /mavlink-ai/param-catalog'], { firmware: 'ardupilot', vehicleType: 'copter' });
  assert.strictEqual(before.body.source.sourceKey, 'ardupilot-copter');
  assert.strictEqual(before.body.cached, null);

  const apmPdef = JSON.stringify({
    ArduCopter: {
      FLTMODE: { FLTMODE1: { Description: 'Flight mode', Values: { 0: 'Stabilize', 2: 'AltHold' } } },
      RC: { RC1_MIN: { Description: 'RC min', Units: 'PWM' } }
    }
  });
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => apmPdef });
  try {
    const upd = await invoke(captured['POST /mavlink-ai/param-catalog/update'], {}, { firmware: 'ardupilot', vehicleType: 'copter' });
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(upd.body.count, 2);

    const list = await invoke(captured['GET /mavlink-ai/param-catalog/params'], { firmware: 'ardupilot', vehicleType: 'copter' });
    assert.strictEqual(list.body.cached, true);
    const fltmode = list.body.params.find((p) => p.paramId === 'FLTMODE1');
    assert.strictEqual(fltmode.hasValues, true);
    assert.strictEqual(list.body.params.find((p) => p.paramId === 'RC1_MIN').hasValues, false);

    const detail = await invoke(captured['GET /mavlink-ai/param-catalog/param'], {
      firmware: 'ardupilot',
      vehicleType: 'copter',
      paramId: 'fltmode1'
    });
    assert.strictEqual(detail.body.found, true);
    assert.deepStrictEqual(detail.body.param.values, [
      { value: 0, label: 'Stabilize' },
      { value: 2, label: 'AltHold' }
    ]);

    const miss = await invoke(captured['GET /mavlink-ai/param-catalog/param'], {
      firmware: 'ardupilot',
      vehicleType: 'copter',
      paramId: 'NO_SUCH'
    });
    assert.strictEqual(miss.body.found, false);
  } finally {
    global.fetch = origFetch;
  }
});
