'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { XmlCatalog, extractIncludes, normalizeFileName } = require('../../lib/dialects/xml-catalog');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mav-xml-catalog-'));
}

// A tiny 3-file include chain: ardupilotmega -> common -> minimal.
const FILES = {
  'ardupilotmega.xml':
    '<?xml version="1.0"?><mavlink><include>common.xml</include><messages>' +
    '<message id="9300" name="APM_ONLY_MSG"><field type="uint8_t" name="v">v</field></message>' +
    '</messages></mavlink>',
  'common.xml':
    '<?xml version="1.0"?><mavlink><include>minimal.xml</include><messages>' +
    '<message id="9301" name="COMMON_MSG"><field type="uint8_t" name="v">v</field></message>' +
    '</messages></mavlink>',
  'minimal.xml':
    '<?xml version="1.0"?><mavlink><messages>' +
    '<message id="9302" name="MIN_MSG"><field type="uint8_t" name="v">v</field></message>' +
    '</messages></mavlink>'
};

function fakeFetcher(table) {
  return async (repo, ref, file) => {
    if (!(file in table)) {
      const e = new Error(`404 ${file}`);
      throw e;
    }
    return table[file];
  };
}

function makeCatalog(table, extra = {}) {
  return new XmlCatalog(
    Object.assign(
      {
        baseDir: tmpDir(),
        fetchFile: fakeFetcher(table),
        resolveCommit: async () => 'a'.repeat(40),
        now: () => 1751000000000
      },
      extra
    )
  );
}

test('extractIncludes finds include names and ignores comments (#61)', () => {
  assert.deepStrictEqual(extractIncludes('<include>common.xml</include>'), ['common.xml']);
  assert.deepStrictEqual(extractIncludes('<!-- <include>skip.xml</include> --><include>a.xml</include>'), ['a.xml']);
});

test('normalizeFileName rejects path traversal and non-xml (#61)', () => {
  assert.strictEqual(normalizeFileName('common.xml'), 'common.xml');
  assert.throws(() => normalizeFileName('../etc/passwd'), (e) => e.code === 'XML_CATALOG_BAD_FILE');
  assert.throws(() => normalizeFileName('/abs/common.xml'), (e) => e.code === 'XML_CATALOG_BAD_FILE');
  assert.throws(() => normalizeFileName('common.txt'), (e) => e.code === 'XML_CATALOG_BAD_FILE');
});

test('update downloads the seed and follows includes, with manifest + hashes (#61)', async () => {
  const cat = makeCatalog(FILES);
  const manifest = await cat.update({ repo: 'mavlink/mavlink', ref: 'master', files: ['ardupilotmega.xml'] });

  // All three files pulled in via the include chain.
  assert.deepStrictEqual(
    manifest.files.map((f) => f.name).sort(),
    ['ardupilotmega.xml', 'common.xml', 'minimal.xml']
  );
  for (const f of manifest.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.bytes > 0);
  }
  assert.strictEqual(manifest.repo, 'mavlink/mavlink');
  assert.strictEqual(manifest.ref, 'master');
  assert.strictEqual(manifest.commit, 'a'.repeat(40));
  assert.strictEqual(manifest.downloadedAt, 1751000000000);

  // Snapshot dir + latest/ + manifest on disk.
  assert.ok(fs.existsSync(path.join(cat.snapshotsDir(), manifest.snapshotId, 'common.xml')));
  assert.ok(fs.existsSync(path.join(cat.latestDir(), 'ardupilotmega.xml')));
  assert.ok(fs.existsSync(path.join(cat.manifestsDir(), `${manifest.snapshotId}.json`)));

  // filePath resolves latest and a specific snapshot.
  assert.ok(cat.filePath('common.xml'));
  assert.ok(cat.filePath('common.xml', manifest.snapshotId));
  assert.strictEqual(cat.filePath('nope.xml'), null);
});

test('filePath rejects traversal / absolute snapshot ids (#61)', async () => {
  const cat = makeCatalog(FILES);
  await cat.update({ files: ['common.xml'] });
  // A malicious snapshot id must not be able to escape snapshots/ even when the
  // file name itself is a valid basename.
  assert.strictEqual(cat.filePath('common.xml', '../latest'), null);
  assert.strictEqual(cat.filePath('common.xml', '../../etc'), null);
  assert.strictEqual(cat.filePath('common.xml', '..'), null);
  assert.strictEqual(cat.filePath('common.xml', 'a/../../b'), null);
  assert.strictEqual(cat.filePath('common.xml', '/abs/path'), null);
  assert.strictEqual(cat.filePath('common.xml', 'nested/id'), null);
});

test('a missing seed file is skipped, not fatal (#61)', async () => {
  const cat = makeCatalog(FILES);
  const manifest = await cat.update({ files: ['minimal.xml', 'doesnotexist.xml'] });
  assert.deepStrictEqual(manifest.files.map((f) => f.name), ['minimal.xml']);
  assert.deepStrictEqual(manifest.missing, ['doesnotexist.xml']);
});

test('an entirely-failed download throws XML_CATALOG_EMPTY (#61)', async () => {
  const cat = makeCatalog({});
  await assert.rejects(cat.update({ files: ['nothing.xml'] }), (e) => e.code === 'XML_CATALOG_EMPTY');
});

// A self-contained downloaded "minimal.xml" that differs from the bundled one:
// HEARTBEAT with a different field set (=> changed CRC), a brand-new message,
// and a brand-new enum.
const COMPARE_FILES = {
  'minimal.xml':
    '<?xml version="1.0"?><mavlink><enums>' +
    '<enum name="CATALOG_ENUM"><entry value="0" name="CATALOG_ENUM_A"><description>a</description></entry></enum>' +
    '</enums><messages>' +
    '<message id="0" name="HEARTBEAT"><field type="uint8_t" name="type">t</field>' +
    '<field type="uint8_t" name="autopilot">a</field></message>' +
    '<message id="9400" name="CATALOG_EXTRA"><field type="uint16_t" name="x">x</field></message>' +
    '</messages></mavlink>',
  'notbundled.xml':
    '<?xml version="1.0"?><mavlink><messages>' +
    '<message id="9500" name="NOT_BUNDLED_MSG"><field type="uint8_t" name="v">v</field></message>' +
    '</messages></mavlink>'
};

test('compare diffs a downloaded XML against the same-named bundled dialect (#61)', async () => {
  const cat = makeCatalog(COMPARE_FILES);
  await cat.update({ files: ['minimal.xml'] });
  const cmp = cat.compare({ file: 'minimal.xml' });
  assert.strictEqual(cmp.bundledExists, true);
  assert.strictEqual(cmp.comparable, true);
  assert.ok(cmp.downloaded.valid && cmp.bundled.valid);
  // A message only in the downloaded XML shows as added.
  assert.ok(cmp.diff.addedMessages.includes('CATALOG_EXTRA'));
  // HEARTBEAT exists in both but with different fields -> changed CRC extra.
  assert.ok(cmp.diff.changedMessages.some((c) => c.name === 'HEARTBEAT'));
  // A new enum shows as added.
  assert.ok(cmp.diff.addedEnums.includes('CATALOG_ENUM'));
});

test('compare reports not-bundled downloads without a diff (#61)', async () => {
  const cat = makeCatalog(COMPARE_FILES);
  await cat.update({ files: ['notbundled.xml'] });
  const cmp = cat.compare({ file: 'notbundled.xml' });
  assert.strictEqual(cmp.bundledExists, false);
  assert.strictEqual(cmp.comparable, false);
  assert.ok(cmp.downloaded.valid);
  assert.strictEqual(cmp.diff, undefined);
});

test('compare on an unknown file throws (#61)', () => {
  const cat = makeCatalog(COMPARE_FILES);
  assert.throws(() => cat.compare({ file: 'never-downloaded.xml' }), (e) => e.code === 'XML_CATALOG_FILE_NOT_FOUND');
});

test('list returns manifests newest-first (#61)', async () => {
  const dir = tmpDir();
  let clock = 1000;
  const cat = new XmlCatalog({
    baseDir: dir,
    fetchFile: fakeFetcher(FILES),
    resolveCommit: async () => 'b'.repeat(40),
    now: () => (clock += 1000)
  });
  await cat.update({ files: ['minimal.xml'] });
  await cat.update({ files: ['common.xml'] });
  const list = cat.list();
  assert.strictEqual(list.length, 2);
  assert.ok(list[0].downloadedAt > list[1].downloadedAt); // newest first
});

// --- Provenance / discovery (#88) --------------------------------------------

test('update resolves the ref to a commit first and fetches at that commit (#88)', async () => {
  const fetchedRefs = [];
  const cat = new XmlCatalog({
    baseDir: tmpDir(),
    fetchFile: async (repo, ref, file) => {
      fetchedRefs.push(ref);
      if (!(file in FILES)) {
        throw new Error(`404 ${file}`);
      }
      return FILES[file];
    },
    resolveCommit: async () => 'c'.repeat(40),
    now: () => 1751000000000
  });
  const manifest = await cat.update({ ref: 'master', files: ['ardupilotmega.xml'] });
  assert.strictEqual(manifest.commit, 'c'.repeat(40));
  // Every single download (roots AND includes) used the pinned commit, never
  // the mutable branch name, so manifest.commit matches all files exactly.
  assert.ok(fetchedRefs.length >= 3);
  assert.ok(fetchedRefs.every((r) => r === 'c'.repeat(40)), `fetched at: ${fetchedRefs}`);
  assert.ok(manifest.sourceUrlBase.includes('c'.repeat(40)));
});

test('update fails when the ref cannot be pinned to a commit (#88)', async () => {
  const cat = new XmlCatalog({
    baseDir: tmpDir(),
    fetchFile: fakeFetcher(FILES),
    resolveCommit: async () => null,
    now: () => 1751000000000
  });
  await assert.rejects(cat.update({ files: ['minimal.xml'] }), (e) => e.code === 'XML_CATALOG_COMMIT_UNRESOLVED');
});

test('update discovers the full upstream dialect list by default (#88)', async () => {
  const listedAt = [];
  const cat = new XmlCatalog({
    baseDir: tmpDir(),
    fetchFile: fakeFetcher(FILES),
    resolveCommit: async () => 'd'.repeat(40),
    listFiles: async (repo, commit) => {
      listedAt.push(commit);
      return Object.keys(FILES); // the complete upstream directory listing
    },
    now: () => 1751000000000
  });
  const manifest = await cat.update({});
  assert.deepStrictEqual(listedAt, ['d'.repeat(40)], 'listing happens at the pinned commit');
  assert.deepStrictEqual(
    manifest.files.map((f) => f.name).sort(),
    ['ardupilotmega.xml', 'common.xml', 'minimal.xml']
  );
  assert.deepStrictEqual(manifest.usable.sort(), ['ardupilotmega.xml', 'common.xml', 'minimal.xml']);
  assert.deepStrictEqual(manifest.unusable, []);
});

test('update fails loudly when discovery is unavailable, not a partial seed (#88)', async () => {
  const cat = new XmlCatalog({
    baseDir: tmpDir(),
    fetchFile: fakeFetcher(FILES),
    resolveCommit: async () => 'e'.repeat(40),
    listFiles: async () => null,
    now: () => 1751000000000
  });
  await assert.rejects(cat.update({}), (e) => e.code === 'XML_CATALOG_LIST_FAILED');
});

test('a root with a missing required include is unusable, not published (#88)', async () => {
  // ardupilotmega -> common -> minimal, but common.xml is gone upstream:
  // ardupilotmega's include closure is incomplete, minimal stays fine.
  const partial = { 'ardupilotmega.xml': FILES['ardupilotmega.xml'], 'minimal.xml': FILES['minimal.xml'] };
  const cat = new XmlCatalog({
    baseDir: tmpDir(),
    fetchFile: fakeFetcher(partial),
    resolveCommit: async () => 'f'.repeat(40),
    now: () => 1751000000000
  });
  const manifest = await cat.update({ files: ['ardupilotmega.xml', 'minimal.xml'] });
  assert.deepStrictEqual(manifest.missing, ['common.xml']);
  assert.deepStrictEqual(manifest.unusable, [{ file: 'ardupilotmega.xml', missingIncludes: ['common.xml'] }]);
  assert.deepStrictEqual(manifest.usable, ['minimal.xml']);
});

test('a transitively missing include marks the root unusable too (#88)', async () => {
  // minimal.xml missing: common's closure breaks, and so does ardupilotmega's
  // (through common), even though ardupilotmega's direct include downloaded.
  const partial = { 'ardupilotmega.xml': FILES['ardupilotmega.xml'], 'common.xml': FILES['common.xml'] };
  const cat = new XmlCatalog({
    baseDir: tmpDir(),
    fetchFile: fakeFetcher(partial),
    resolveCommit: async () => 'a1'.padEnd(40, '0'),
    now: () => 1751000000000
  });
  const manifest = await cat.update({ files: ['ardupilotmega.xml', 'common.xml'] });
  assert.deepStrictEqual(manifest.missing, ['minimal.xml']);
  assert.deepStrictEqual(manifest.unusable, [
    { file: 'ardupilotmega.xml', missingIncludes: ['minimal.xml'] },
    { file: 'common.xml', missingIncludes: ['minimal.xml'] }
  ]);
  assert.deepStrictEqual(manifest.usable, []);
});
