'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');

/**
 * @param {string} dir
 * @returns {string[]}
 */
function filesBelow(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(full) : [full];
  });
}

test('every example flow parses, has unique ids, and only wires to included nodes', () => {
  const files = filesBelow(EXAMPLES).filter((file) => file.endsWith('.json'));
  assert.ok(files.length >= 27, `expected the expanded example suite, got ${files.length}`);

  for (const file of files) {
    const flow = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(flow), `${file} must contain a Node-RED flow array`);
    const ids = new Set();
    for (const node of flow) {
      assert.ok(node.id, `${file} contains a node without an id`);
      assert.ok(!ids.has(node.id), `${file} repeats id ${node.id}`);
      ids.add(node.id);
    }
    for (const node of flow) {
      for (const output of node.wires || []) {
        for (const target of output) {
          assert.ok(ids.has(target), `${file}: ${node.id} wires to missing ${target}`);
        }
      }
    }
  }
});

test('all Function-node bodies in examples are syntactically valid', () => {
  const files = filesBelow(EXAMPLES).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const flow = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const node of flow.filter((item) => item.type === 'function')) {
      assert.doesNotThrow(() => new Function(node.func || ''), `${file}: invalid function ${node.name || node.id}`);
    }
  }
});

test('web assets and telemetry replay fixture are packaged and valid', () => {
  for (const asset of ['vehicle-status-dashboard.html', 'parameter-browser.html']) {
    const content = fs.readFileSync(path.join(EXAMPLES, 'assets', asset), 'utf8');
    assert.match(content, /<!doctype html>/i);
    const scripts = [...content.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    assert.ok(scripts.length, `${asset} must contain its browser logic`);
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script), `${asset} contains invalid browser JavaScript`);
    }
  }

  const fixture = fs.readFileSync(path.join(EXAMPLES, 'fixtures', 'vehicle-status-demo.jsonl'), 'utf8');
  const records = fixture.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(records.length >= 6);
  assert.deepStrictEqual(records.map((record) => record.recordedAt), records.map((record) => record.recordedAt).sort((a, b) => a - b));
  for (const record of records) {
    assert.match(record.topic, /^mavlink\//);
    assert.ok(record.payload && record.payload.name);
    assert.ok(record.payload.profile_id);
  }
});

test('web example flows load packaged assets from the Node-RED Docker user directory', () => {
  const expectedPaths = new Map([
    ['03-parameters/24-parameter-browser-web.json', '/data/node_modules/node-red-contrib-mavlink-ai/examples/assets/parameter-browser.html'],
    ['09-observability/21-vehicle-status-web-dashboard.json', '/data/node_modules/node-red-contrib-mavlink-ai/examples/assets/vehicle-status-dashboard.html']
  ]);

  for (const [file, expectedPath] of expectedPaths) {
    const flow = JSON.parse(fs.readFileSync(path.join(EXAMPLES, file), 'utf8'));
    const assetNode = flow.find((node) => node.type === 'function' && node.func?.includes('msg.filename'));
    assert.ok(assetNode, `${file} must include an asset-path Function node`);
    assert.match(assetNode.func, new RegExp(`msg\\.filename = ['\"]${expectedPath.replaceAll('/', '\\/')}['\"]`));
  }
});
