'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ParamCatalog, defaultFetchText } = require('../../lib/params/param-catalog');
const { resolveParamDefSource } = require('../../lib/params/param-def-sources');

/** A fresh temp cache dir per catalog. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mav-param-catalog-'));
}

/** A representative ArduPilot apm.pdef.json body. */
const APM_PDEF = JSON.stringify({
  ArduCopter: {
    '': { SYSID_THISMAV: { Description: 'sys id', Range: { low: 1, high: 255 } } },
    FLTMODE: { FLTMODE1: { Description: 'mode', Values: { 0: 'Stabilize', 2: 'AltHold' } } }
  }
});

/** Build a catalog whose network fetch returns `body` and whose clock is fixed. */
function makeCatalog(body) {
  return new ParamCatalog({
    baseDir: tmpDir(),
    fetchText: async () => body,
    now: () => Date.parse('2026-07-15T00:00:00Z')
  });
}

test('resolveParamDefSource maps firmware/vehicle and degrades for the rest (#125)', () => {
  const copter = resolveParamDefSource({ firmware: 'ardupilot', vehicleType: 'copter' });
  assert.strictEqual(copter.sourceKey, 'ardupilot-copter');
  assert.match(copter.url, /ArduCopter\/apm\.pdef\.json$/);
  assert.strictEqual(copter.urlRequired, false);

  assert.strictEqual(resolveParamDefSource({ firmware: 'ardupilot', vehicleType: 'gcs' }), null);

  const px4 = resolveParamDefSource({ firmware: 'px4', vehicleType: 'copter' });
  assert.strictEqual(px4.sourceKey, 'px4-copter', 'PX4 keys by vehicle so profiles do not collide');
  assert.strictEqual(px4.url, null);
  assert.strictEqual(px4.urlRequired, true);
  assert.strictEqual(resolveParamDefSource({ firmware: 'px4' }).sourceKey, 'px4');

  assert.strictEqual(resolveParamDefSource({ firmware: 'generic', vehicleType: 'copter' }), null);
  assert.strictEqual(resolveParamDefSource({ firmware: 'custom' }), null);
});

test('update downloads, caches, and get/paramChoices/list read it back (#125)', async () => {
  const catalog = makeCatalog(APM_PDEF);
  const index = await catalog.update({ firmware: 'ardupilot', vehicleType: 'copter' });
  assert.strictEqual(index.sourceKey, 'ardupilot-copter');
  assert.strictEqual(index.count, 2);
  assert.strictEqual(index.fetchedAt, '2026-07-15T00:00:00.000Z');

  const got = catalog.get({ firmware: 'ardupilot', vehicleType: 'copter' });
  assert.strictEqual(got.count, 2);

  /** Case-insensitive param lookup. */
  const mode = catalog.paramChoices({ firmware: 'ardupilot', vehicleType: 'copter', paramId: 'fltmode1' });
  assert.deepStrictEqual(mode.values, [
    { value: 0, label: 'Stabilize' },
    { value: 2, label: 'AltHold' }
  ]);
  assert.strictEqual(catalog.paramChoices({ firmware: 'ardupilot', vehicleType: 'copter', paramId: 'NOPE' }), null);

  const list = catalog.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].sourceKey, 'ardupilot-copter');
  assert.strictEqual(list[0].count, 2);
});

test('get returns null before any download (#125)', () => {
  const catalog = makeCatalog(APM_PDEF);
  assert.strictEqual(catalog.get({ firmware: 'ardupilot', vehicleType: 'copter' }), null);
  assert.deepStrictEqual(catalog.list(), []);
});

test('update rejects no-source, missing-url, and empty results loudly (#125)', async () => {
  await assert.rejects(makeCatalog(APM_PDEF).update({ firmware: 'generic' }), (e) => e.code === 'PARAM_CATALOG_NO_SOURCE');

  await assert.rejects(
    makeCatalog('{"parameters":[]}').update({ firmware: 'px4' }),
    (e) => e.code === 'PARAM_CATALOG_URL_REQUIRED'
  );

  await assert.rejects(
    makeCatalog('{"parameters":[]}').update({ firmware: 'px4', url: 'http://example/params.json' }),
    (e) => e.code === 'PARAM_CATALOG_EMPTY'
  );
});

test('update with an explicit url overrides the registry default and works for PX4 (#125)', async () => {
  const px4Body = JSON.stringify({ parameters: [{ name: 'MC_ROLLRATE_P', type: 'FLOAT' }] });
  const catalog = makeCatalog(px4Body);
  const index = await catalog.update({ firmware: 'px4', url: 'https://example.test/parameters.json' });
  assert.strictEqual(index.sourceKey, 'px4');
  assert.strictEqual(index.url, 'https://example.test/parameters.json');
  assert.strictEqual(index.count, 1);
});

test('a fetch failure propagates from update (#125)', async () => {
  const catalog = new ParamCatalog({
    baseDir: tmpDir(),
    fetchText: async () => {
      throw new Error('network down');
    }
  });
  await assert.rejects(catalog.update({ firmware: 'ardupilot', vehicleType: 'copter' }), /network down/);
});

test('defaultFetchText normalizes non-2xx and transport failures to a structured code (#125)', async () => {
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 503, statusText: 'Unavailable', text: async () => '' });
    await assert.rejects(defaultFetchText('http://x/params.json'), (e) => e.code === 'PARAM_CATALOG_FETCH_FAILED');
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.rejects(defaultFetchText('http://x/params.json'), (e) => e.code === 'PARAM_CATALOG_FETCH_FAILED');
  } finally {
    global.fetch = origFetch;
  }
});

test('a failed update leaves the previously cached catalog intact (#125)', async () => {
  const catalog = makeCatalog(APM_PDEF);
  await catalog.update({ firmware: 'ardupilot', vehicleType: 'copter' });
  assert.strictEqual(catalog.get({ firmware: 'ardupilot', vehicleType: 'copter' }).count, 2);
  /** A later download returning garbage fails to parse and must not clobber the good cache. */
  catalog.fetchText = async () => '{not json';
  await assert.rejects(
    catalog.update({ firmware: 'ardupilot', vehicleType: 'copter' }),
    (e) => e.code === 'PARAM_DEF_PARSE_FAILED'
  );
  assert.strictEqual(
    catalog.get({ firmware: 'ardupilot', vehicleType: 'copter' }).count,
    2,
    'previous cache survived the failed update'
  );
});

test('getByKey neutralizes path traversal in the source key (#125)', () => {
  const catalog = makeCatalog(APM_PDEF);
  /** A pure ".." collapses to an invalid segment and is rejected. */
  assert.throws(() => catalog.getByKey('..'), (e) => e.code === 'PARAM_CATALOG_BAD_SOURCE');
  /** A slashed key is sanitized to a single in-baseDir segment, so it can't escape. */
  assert.strictEqual(catalog.getByKey('../../etc/passwd'), null);
});

test('ParamCatalog requires a baseDir (#125)', () => {
  assert.throws(() => new ParamCatalog({}), (e) => e.code === 'PARAM_CATALOG_NO_DIR');
});
