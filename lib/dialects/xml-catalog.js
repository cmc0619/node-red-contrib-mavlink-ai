'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MavlinkError } = require('../util/errors');
const { knownDialects, loadDialect } = require('./dialect-loader');

/**
 * Downloadable MAVLink XML dialect catalog (issue #61).
 *
 * This does NOT add a third runtime dialect mode: downloaded XML files are just
 * managed **Custom** XML paths that the existing runtime compiler already knows
 * how to load. What the catalog adds is a local cache of official MAVLink XML
 * snapshots (with provenance metadata) plus an informational comparison against
 * the installed bundled dialects, so a user can tell whether a downloaded XML is
 * newer/different from what ships in `mavlink-mappings`.
 *
 * Layout under the base dir (typically `<userDir>/mavlink-ai/xml`):
 *
 *   manifests/<snapshotId>.json   provenance + file list + per-file hash
 *   snapshots/<snapshotId>/*.xml  the downloaded XML set (includes together)
 *   latest/*.xml                  the most recent snapshot's files (stable path)
 *
 * Downloads go through an injectable fetcher so the logic is fully testable
 * offline; the default fetcher uses global `fetch` against raw.githubusercontent.
 * Includes are followed at *download* time (so a snapshot is self-contained);
 * the runtime compiler never fetches remote includes.
 */

// Official MAVLink message definitions live here in the source repo.
const DEFINITIONS_DIR = 'message_definitions/v1.0';

const DEFAULT_SOURCE = { repo: 'mavlink/mavlink', ref: 'master' };

// Seed dialects to download; their `<include>` dependencies are pulled in too,
// so this list only needs the "leaf" dialects a user is likely to want.
const DEFAULT_FILES = ['common.xml', 'standard.xml', 'minimal.xml', 'ardupilotmega.xml', 'development.xml'];

// `<include>foo.xml</include>` (mirrors the runtime include resolver).
const INCLUDE_RE = /<include>\s*([^<]+?)\s*<\/include>/g;

/**
 * Default network fetcher for one definitions file. Uses global fetch (Node 18+),
 * so no new dependency. Rejects non-2xx loudly.
 *
 * @param {string} repo  e.g. "mavlink/mavlink"
 * @param {string} ref   branch/tag/sha
 * @param {string} file  file name within the definitions dir, e.g. "common.xml"
 * @returns {Promise<string>} the file text
 */
async function defaultFetchFile(repo, ref, file) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${DEFINITIONS_DIR}/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new MavlinkError('XML_CATALOG_FETCH_FAILED', `Failed to download ${file} (${res.status} ${res.statusText}).`, {
      file,
      url,
      status: res.status
    });
  }
  return res.text();
}

/**
 * Best-effort commit-sha resolver for a ref (records provenance honestly).
 * Returns null when unavailable rather than failing the whole update.
 *
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<?string>}
 */
async function defaultResolveCommit(repo, ref) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
      headers: { Accept: 'application/vnd.github.sha' }
    });
    if (!res.ok) {
      return null;
    }
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch (e) {
    return null;
  }
}

class XmlCatalog {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir  cache root (e.g. `<userDir>/mavlink-ai/xml`)
   * @param {function} [opts.fetchFile]      (repo, ref, file) -> Promise<string>
   * @param {function} [opts.resolveCommit]  (repo, ref) -> Promise<?string>
   * @param {function} [opts.now]            clock override (tests)
   */
  constructor(opts = {}) {
    if (!opts.baseDir) {
      throw new MavlinkError('XML_CATALOG_NO_DIR', 'XmlCatalog requires a baseDir.');
    }
    this.baseDir = opts.baseDir;
    this.fetchFile = opts.fetchFile || defaultFetchFile;
    this.resolveCommit = opts.resolveCommit || defaultResolveCommit;
    this.now = opts.now || Date.now;
  }

  /** @returns {string} */
  manifestsDir() {
    return path.join(this.baseDir, 'manifests');
  }

  /** @returns {string} */
  snapshotsDir() {
    return path.join(this.baseDir, 'snapshots');
  }

  /** @returns {string} */
  latestDir() {
    return path.join(this.baseDir, 'latest');
  }

  /**
   * Download a MAVLink XML set into a new snapshot, following `<include>`
   * dependencies so the snapshot is self-contained. Records provenance in a
   * manifest and refreshes the `latest/` copy.
   *
   * @param {object} [opts]
   * @param {string} [opts.repo]   default mavlink/mavlink
   * @param {string} [opts.ref]    default master
   * @param {string[]} [opts.files]  seed dialect files (includes are followed)
   * @returns {Promise<object>} the written manifest
   */
  async update(opts = {}) {
    const repo = opts.repo || DEFAULT_SOURCE.repo;
    const ref = opts.ref || DEFAULT_SOURCE.ref;
    const seed = Array.isArray(opts.files) && opts.files.length ? opts.files.slice() : DEFAULT_FILES.slice();

    // BFS over the include graph, downloading each file once.
    const fetched = new Map(); // file -> text
    const queue = seed.slice();
    const missing = [];
    while (queue.length) {
      const file = normalizeFileName(queue.shift());
      if (fetched.has(file)) {
        continue;
      }
      let text;
      try {
        text = await this.fetchFile(repo, ref, file);
      } catch (err) {
        // A seed file may not exist in every ref (e.g. development.xml on old
        // tags); skip it rather than abort the whole snapshot, but record it.
        missing.push(file);
        continue;
      }
      fetched.set(file, text);
      for (const inc of extractIncludes(text)) {
        const incFile = normalizeFileName(inc);
        if (!fetched.has(incFile)) {
          queue.push(incFile);
        }
      }
    }

    if (fetched.size === 0) {
      throw new MavlinkError('XML_CATALOG_EMPTY', `No XML files could be downloaded from ${repo}@${ref}.`, {
        repo,
        ref,
        missing
      });
    }

    const commit = await this.resolveCommit(repo, ref);
    const downloadedAt = this.now();
    const snapshotId = makeSnapshotId(repo, ref, commit, downloadedAt);
    const snapDir = path.join(this.snapshotsDir(), snapshotId);
    fs.mkdirSync(snapDir, { recursive: true });

    const files = [];
    for (const [file, text] of fetched) {
      fs.writeFileSync(path.join(snapDir, file), text);
      files.push({ name: file, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));

    const manifest = {
      snapshotId,
      repo,
      ref,
      commit: commit || null,
      sourceUrlBase: `https://raw.githubusercontent.com/${repo}/${commit || ref}/${DEFINITIONS_DIR}`,
      downloadedAt,
      files,
      missing
    };

    fs.mkdirSync(this.manifestsDir(), { recursive: true });
    fs.writeFileSync(path.join(this.manifestsDir(), `${snapshotId}.json`), JSON.stringify(manifest, null, 2));

    // Refresh latest/ as a stable path pointing at the newest set.
    this._writeLatest(snapDir, files);

    return manifest;
  }

  /**
   * Copy a snapshot's files into latest/ (replacing what's there), so a profile
   * can reference a stable path that always resolves to the most recent set.
   *
   * @param {string} snapDir
   * @param {object[]} files
   * @returns {void}
   */
  _writeLatest(snapDir, files) {
    const latest = this.latestDir();
    fs.rmSync(latest, { recursive: true, force: true });
    fs.mkdirSync(latest, { recursive: true });
    for (const f of files) {
      fs.copyFileSync(path.join(snapDir, f.name), path.join(latest, f.name));
    }
  }

  /**
   * List downloaded snapshots (newest first).
   *
   * @returns {object[]} manifests
   */
  list() {
    const dir = this.manifestsDir();
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch (e) {
      return []; // nothing downloaded yet
    }
    const manifests = [];
    for (const name of names) {
      try {
        manifests.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      } catch (e) {
        // Skip a corrupt manifest rather than break the whole listing.
      }
    }
    return manifests.sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
  }

  /**
   * Absolute path to a downloaded XML file (in a specific snapshot, or latest/).
   *
   * @param {string} file  e.g. "common.xml"
   * @param {string} [snapshotId]  a snapshot id, or omitted for latest/
   * @returns {?string} the path, or null if it doesn't exist
   */
  filePath(file, snapshotId) {
    const name = normalizeFileName(file);
    let p;
    if (snapshotId) {
      const snap = normalizeSnapshotId(snapshotId);
      if (!snap) {
        return null; // reject traversal / absolute / empty snapshot ids
      }
      p = path.join(this.snapshotsDir(), snap, name);
    } else {
      p = path.join(this.latestDir(), name);
    }
    return fileExists(p) ? p : null;
  }

  /**
   * Compare a downloaded XML dialect against the installed bundled dialect of
   * the same basename (issue #61). Informational only — this never changes what
   * the runtime loads. When both compile, reports message/enum differences.
   *
   * @param {object} opts
   * @param {string} opts.file  e.g. "common.xml"
   * @param {string} [opts.snapshot]  snapshot id, or omitted for latest/
   * @returns {object} comparison result (see below)
   */
  compare(opts = {}) {
    const file = normalizeFileName(opts.file || '');
    const dialectName = path.basename(file, '.xml');
    const downloadedPath = this.filePath(file, opts.snapshot);
    if (!downloadedPath) {
      throw new MavlinkError('XML_CATALOG_FILE_NOT_FOUND', `Downloaded XML '${file}' not found in the catalog.`, {
        file,
        snapshot: opts.snapshot || 'latest'
      });
    }

    const bundledExists = knownDialects().includes(dialectName);
    const result = {
      file,
      dialect: dialectName,
      snapshot: opts.snapshot || 'latest',
      bundledExists,
      comparable: false
    };

    // Compile the downloaded XML (as a custom dialect) for a deeper diff.
    const downloaded = loadDialect('custom', { customDialectPath: downloadedPath });
    result.downloaded = summarizeBundle(downloaded);
    if (!downloaded.valid) {
      result.error = downloaded.error ? downloaded.error.message : 'Downloaded XML failed to compile.';
      return result;
    }
    if (!bundledExists) {
      // Nothing bundled to diff against; the message/enum summary still helps.
      return result;
    }

    const bundled = loadDialect(dialectName);
    result.bundled = summarizeBundle(bundled);
    if (!bundled.valid) {
      return result;
    }

    result.comparable = true;
    result.diff = diffBundles(bundled, downloaded);
    return result;
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * Extract `<include>` file names from XML text (comments stripped).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractIncludes(text) {
  const uncommented = String(text).replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  let m;
  INCLUDE_RE.lastIndex = 0;
  while ((m = INCLUDE_RE.exec(uncommented)) !== null) {
    const name = m[1].trim();
    if (name) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Reduce an include path to a bare `<name>.xml` basename, rejecting anything
 * that tries to escape the snapshot directory (path traversal / absolute /
 * network). The definitions dir is flat, so a plain filename is expected.
 *
 * @param {string} name
 * @returns {string}
 * @throws {MavlinkError} XML_CATALOG_BAD_FILE
 */
function normalizeFileName(name) {
  const base = path.basename(String(name).trim());
  if (!base || base !== String(name).trim() || !/^[\w.-]+\.xml$/i.test(base)) {
    throw new MavlinkError('XML_CATALOG_BAD_FILE', `Unsafe or invalid XML file name '${name}'.`, { name });
  }
  return base;
}

/**
 * Validate a snapshot id before it is joined into a filesystem path. Generated
 * ids only ever contain `[\w.-]` (see `makeSnapshotId`/`sanitize`), so anything
 * with a path separator, a `..` segment, or a leading dot is rejected here as
 * an attempted escape from `snapshots/`.
 *
 * @param {string} id
 * @returns {?string} the id if safe, else null
 */
function normalizeSnapshotId(id) {
  const s = String(id).trim();
  if (!s || s === '.' || s === '..' || s.includes('..') || !/^[\w.-]+$/.test(s)) {
    return null;
  }
  // Belt-and-suspenders: a valid id must be a single path segment.
  if (path.basename(s) !== s) {
    return null;
  }
  return s;
}

/**
 * Build a filesystem-safe, roughly-sortable snapshot id from provenance.
 *
 * @param {string} repo
 * @param {string} ref
 * @param {?string} commit
 * @param {number} downloadedAt
 * @returns {string}
 */
function makeSnapshotId(repo, ref, commit, downloadedAt) {
  const stamp = new Date(downloadedAt).toISOString().replace(/[:.]/g, '-');
  const shortCommit = commit ? commit.slice(0, 7) : 'nocommit';
  return `${sanitize(repo)}-${sanitize(ref)}-${shortCommit}-${stamp}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
  return String(s).replace(/[^\w.-]+/g, '_');
}

/**
 * CamelCase enum class name -> SCREAMING_SNAKE (MavType -> MAV_TYPE), matching
 * how enums are named elsewhere in the module.
 *
 * @param {string} name
 * @returns {string}
 */
function screaming(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/**
 * @param {string} text
 * @returns {string} hex sha256
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/**
 * Summarize a compiled bundle for the comparison output.
 *
 * @param {object} bundle
 * @returns {object}
 */
function summarizeBundle(bundle) {
  if (!bundle || !bundle.valid) {
    return { valid: false };
  }
  const messages = Object.values(bundle.registry).map((c) => c.MSG_NAME);
  const enums = Object.keys(bundle.enums.enumsByName);
  return { valid: true, messageCount: messages.length, enumCount: enums.length };
}

/**
 * Diff two compiled bundles by message name/id/CRC and enum names.
 *
 * @param {object} bundled   the installed bundled dialect
 * @param {object} downloaded  the compiled downloaded XML
 * @returns {object}
 */
function diffBundles(bundled, downloaded) {
  const bByName = indexByName(bundled);
  const dByName = indexByName(downloaded);

  const addedMessages = []; // in downloaded, not bundled
  const removedMessages = []; // in bundled, not downloaded
  const changedMessages = []; // same name, different id or CRC magic

  for (const [name, d] of dByName) {
    const b = bByName.get(name);
    if (!b) {
      addedMessages.push(name);
    } else if (b.MSG_ID !== d.MSG_ID || b.MAGIC_NUMBER !== d.MAGIC_NUMBER) {
      changedMessages.push({
        name,
        bundled: { id: b.MSG_ID, crc_extra: b.MAGIC_NUMBER },
        downloaded: { id: d.MSG_ID, crc_extra: d.MAGIC_NUMBER }
      });
    }
  }
  for (const name of bByName.keys()) {
    if (!dByName.has(name)) {
      removedMessages.push(name);
    }
  }

  // enumsByName keys are the generated CamelCase class names (MavType); show
  // the readable screaming-snake form (MAV_TYPE) used everywhere else.
  const bEnums = new Set(Object.keys(bundled.enums.enumsByName));
  const dEnums = new Set(Object.keys(downloaded.enums.enumsByName));
  const addedEnums = [...dEnums].filter((e) => !bEnums.has(e)).map(screaming);
  const removedEnums = [...bEnums].filter((e) => !dEnums.has(e)).map(screaming);

  return {
    addedMessages: addedMessages.sort(),
    removedMessages: removedMessages.sort(),
    changedMessages: changedMessages.sort((a, b) => a.name.localeCompare(b.name)),
    addedEnums: addedEnums.sort(),
    removedEnums: removedEnums.sort()
  };
}

/**
 * @param {object} bundle
 * @returns {Map<string, Function>} MSG_NAME -> class
 */
function indexByName(bundle) {
  const map = new Map();
  for (const clazz of Object.values(bundle.registry)) {
    map.set(clazz.MSG_NAME, clazz);
  }
  return map;
}

module.exports = {
  XmlCatalog,
  DEFAULT_SOURCE,
  DEFAULT_FILES,
  extractIncludes,
  normalizeFileName
};
