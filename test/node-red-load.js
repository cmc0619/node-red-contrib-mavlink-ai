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
    await helper.unload();
    await new Promise((resolve) => helper.stopServer(resolve));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
