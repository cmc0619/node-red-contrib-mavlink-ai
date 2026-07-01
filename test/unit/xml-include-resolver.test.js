'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveXmlIncludeGraph } = require('../../lib/dialects/xml-include-resolver');

const DIR = path.join(__dirname, '..', 'fixtures', 'dialects');
const fixture = (name) => path.join(DIR, name);
const names = (graph) => graph.orderedFiles.map((f) => path.basename(f));

test('a dialect that includes nothing resolves to only itself', () => {
  const graph = resolveXmlIncludeGraph(fixture('custom_no_common.xml'));
  assert.deepStrictEqual(names(graph), ['custom_no_common.xml']);
  assert.strictEqual(path.basename(graph.rootPath), 'custom_no_common.xml');
});

test('include order is dependency-first, root-last', () => {
  const graph = resolveXmlIncludeGraph(fixture('custom_vehicle.xml'));
  // custom_vehicle -> common -> minimal, emitted deepest-first.
  assert.deepStrictEqual(names(graph), ['minimal.xml', 'common.xml', 'custom_vehicle.xml']);
});

test('a dialect without common still resolves (no forced common)', () => {
  const graph = resolveXmlIncludeGraph(fixture('custom_no_common.xml'));
  assert.ok(!names(graph).includes('common.xml'));
});

test('the same included file is not duplicated (diamond)', () => {
  const graph = resolveXmlIncludeGraph(fixture('custom_diamond.xml'));
  // minimal is reached via common and directly; it must appear exactly once,
  // before both of its dependents, with the root last.
  assert.deepStrictEqual(names(graph), ['minimal.xml', 'common.xml', 'custom_diamond.xml']);
  const minimalCount = names(graph).filter((n) => n === 'minimal.xml').length;
  assert.strictEqual(minimalCount, 1);
});

test('documents and includeGraph are populated with resolved edges', () => {
  const graph = resolveXmlIncludeGraph(fixture('custom_vehicle.xml'));
  const common = fixture('common.xml');
  assert.ok(graph.documents[common]);
  assert.match(graph.documents[common].text, /ATTITUDE/);
  // common's resolved include edge points at the absolute minimal.xml.
  assert.deepStrictEqual(
    graph.includeGraph[common].map((f) => path.basename(f)),
    ['minimal.xml']
  );
});

test('a missing include throws DIALECT_INCLUDE_NOT_FOUND', () => {
  assert.throws(
    () => resolveXmlIncludeGraph(fixture('missing_include.xml')),
    (e) => e.code === 'DIALECT_INCLUDE_NOT_FOUND'
  );
});

test('an include cycle throws DIALECT_INCLUDE_CYCLE', () => {
  assert.throws(
    () => resolveXmlIncludeGraph(fixture('cycle_a.xml')),
    (e) => e.code === 'DIALECT_INCLUDE_CYCLE'
  );
});

test('a missing root XML throws DIALECT_XML_NOT_FOUND', () => {
  assert.throws(
    () => resolveXmlIncludeGraph(fixture('does_not_exist.xml')),
    (e) => e.code === 'DIALECT_XML_NOT_FOUND'
  );
});

test('a network-URL include is rejected, not fetched', () => {
  // Build a throwaway root that includes a URL, without a fixture file on disk.
  const os = require('os');
  const fs = require('fs');
  const tmp = path.join(os.tmpdir(), `mav-url-include-${process.pid}.xml`);
  fs.writeFileSync(tmp, '<mavlink><include>https://example.com/common.xml</include></mavlink>');
  try {
    assert.throws(
      () => resolveXmlIncludeGraph(tmp),
      (e) => e.code === 'DIALECT_INCLUDE_NOT_FOUND' && /network URL/.test(e.message)
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('includeDirs lets a dialect find bases in a separate directory', () => {
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-inc-'));
  try {
    const root = path.join(dir, 'root.xml');
    fs.writeFileSync(root, '<mavlink><include>minimal.xml</include></mavlink>');
    // minimal.xml only exists in the fixtures dir, offered via includeDirs.
    const graph = resolveXmlIncludeGraph(root, { includeDirs: [DIR] });
    assert.deepStrictEqual(names(graph), ['minimal.xml', 'root.xml']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
