'use strict';

/**
 * Node-RED runtime load check (issue #102).
 *
 * Loads this module's nodes into a real Node-RED runtime at whatever `node-red`
 * version is installed, proving the package registers and instantiates under
 * each supported Node.js/Node-RED combination — the mock-RED unit/integration
 * suite deliberately never touches the real runtime.
 *
 * Skips cleanly (exit 0) when `node-red` / `node-red-node-test-helper` aren't
 * installed, so the default `npm test` (which does not depend on them) is
 * unaffected. CI installs both, pinned to each matrix Node-RED version, and runs
 * this against every claimed Node.js/Node-RED pair.
 */

let helper;
let nodeRedPath;
try {
  helper = require('node-red-node-test-helper');
  nodeRedPath = require.resolve('node-red');
} catch (err) {
  console.log(`SKIP: node-red / node-red-node-test-helper not installed (${err.code || err.message}).`);
  process.exit(0);
}

const assert = require('node:assert');
const profileNode = require('../nodes/mavlink-ai-profile.js');
const buildNode = require('../nodes/mavlink-ai-build.js');

helper.init(nodeRedPath);

/**
 * Load the profile + build nodes into a real Node-RED runtime and assert they
 * register and expose their runtime API. Always tears the runtime down, and
 * never lets a cleanup failure mask the real test outcome.
 *
 * @returns {Promise<void>}
 */
async function main() {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const nodeRedVersion = require('node-red/package.json').version;
  console.log(`Loading nodes on Node ${process.version} / Node-RED ${nodeRedVersion}`);

  await new Promise((resolve) => helper.startServer(resolve));
  try {
    const flow = [
      { id: 'p1', type: 'mavlink-ai-profile', name: 'Test', dialect: 'common', mavlinkVersion: 'v2' },
      { id: 'b1', type: 'mavlink-ai-build', name: 'build', profile: 'p1', messageName: 'HEARTBEAT' }
    ];
    await helper.load([profileNode, buildNode], flow);

    const p1 = helper.getNode('p1');
    const b1 = helper.getNode('b1');
    assert.ok(p1, 'profile config node was instantiated');
    assert.ok(b1, 'build node was instantiated');
    assert.strictEqual(typeof p1.getDialect, 'function', 'profile exposes its runtime API');
    assert.ok(p1.isValid && p1.isValid(), 'common dialect profile is valid');

    console.log(`OK: nodes registered and instantiated under Node-RED ${nodeRedVersion}.`);
  } finally {
    // Run both cleanup steps independently so an unload failure can't skip the
    // server shutdown or replace the real test outcome with a cleanup error.
    try {
      await helper.unload();
    } catch (e) {
      console.error('unload error:', e);
    }
    try {
      await new Promise((resolve) => helper.stopServer(resolve));
    } catch (e) {
      console.error('stopServer error:', e);
    }
  }
}

// Fail fast if any Node-RED lifecycle callback never fires, so a hung helper
// surfaces a clear error instead of stalling CI until the runner kills the job.
const timeout = setTimeout(() => {
  console.error('TIMEOUT: Node-RED load check did not complete within 60s.');
  process.exit(1);
}, 60000);
timeout.unref();

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
