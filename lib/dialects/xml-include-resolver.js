'use strict';

const fs = require('fs');
const path = require('path');
const { MavlinkError } = require('../util/errors');

/**
 * MAVLink dialect XML `<include>` graph resolver (issue #3).
 *
 * A MAVLink dialect is composed from other dialects via `<include>` directives
 * (e.g. `ardupilotmega.xml` includes `common.xml`, which includes
 * `standard.xml`, which includes `minimal.xml`). `<include>` of `common.xml` is
 * *typical but not mandatory* — a dialect may define its own base set and
 * include nothing (RELEASE_SCOPE §1). The old loader baked fixed include chains
 * and assumed `common`; this resolver instead walks the real include graph so
 * custom dialects that don't include `common` load correctly.
 *
 * This module only resolves *dialect composition* (`<include>`). It does not
 * touch MAVLink 2 `<extensions/>` field boundaries — those are a per-message
 * field concern the runtime already tracks separately.
 *
 * It never fetches network URLs: a resolved include must be a local file.
 */

// A dialect `<include>foo.xml</include>` directive. The body is a filename,
// occasionally wrapped in whitespace/newlines.
const INCLUDE_RE = /<include>\s*([^<]+?)\s*<\/include>/g;

/**
 * Resolve a dialect XML file's full include graph.
 *
 * @param {string} rootPath  path to the root dialect `.xml`
 * @param {object} [opts]
 * @param {string[]} [opts.includeDirs]  extra directories to search for includes
 * @param {boolean} [opts.allowOutsideRoot]  permit includes that resolve outside
 *   the root file's directory / includeDirs (default false)
 * @returns {{rootPath: string, orderedFiles: string[],
 *   documents: Object<string, {path: string, text: string, includes: string[]}>,
 *   includeGraph: Object<string, string[]>}}
 *   `orderedFiles` is dependency-first, root-last, de-duplicated.
 * @throws {MavlinkError} DIALECT_INCLUDE_NOT_FOUND | DIALECT_INCLUDE_CYCLE |
 *   DIALECT_XML_NOT_FOUND
 */
function resolveXmlIncludeGraph(rootPath, opts = {}) {
  const includeDirs = (opts.includeDirs || []).map((d) => path.resolve(d));
  const allowOutsideRoot = Boolean(opts.allowOutsideRoot);

  const absRoot = path.resolve(rootPath);
  if (!fileExists(absRoot)) {
    throw new MavlinkError('DIALECT_XML_NOT_FOUND', `Dialect XML not found: '${rootPath}'.`, {
      path: rootPath
    });
  }
  // Containment roots: the root file's directory plus any explicit includeDirs.
  const rootDir = path.dirname(absRoot);
  const allowedRoots = [rootDir, ...includeDirs];

  const documents = {};
  const includeGraph = {};
  const orderedFiles = [];
  const visited = new Set(); // fully-resolved files
  const stack = new Set(); // files currently on the DFS stack (cycle detection)
  const stackOrder = []; // for a readable cycle message

  /**
   * Depth-first visit: resolve a file's includes (dependencies) before adding
   * the file itself, so `orderedFiles` ends up dependency-first / root-last.
   *
   * @param {string} absFile  absolute path of the file to visit
   * @param {?string} fromFile  the including file (for error context), or null
   * @returns {void}
   */
  function visit(absFile, fromFile) {
    if (visited.has(absFile)) {
      return; // already fully resolved; do not duplicate
    }
    if (stack.has(absFile)) {
      const cycle = [...stackOrder, absFile].map((f) => path.basename(f)).join(' -> ');
      throw new MavlinkError('DIALECT_INCLUDE_CYCLE', `Include cycle detected: ${cycle}.`, {
        cycle: [...stackOrder, absFile]
      });
    }

    stack.add(absFile);
    stackOrder.push(absFile);

    const text = readFile(absFile, fromFile);
    const includeNames = extractIncludes(text);
    const includeDir = path.dirname(absFile);
    const resolvedIncludes = [];

    for (const name of includeNames) {
      const target = resolveInclude(name, includeDir, includeDirs, allowedRoots, allowOutsideRoot, absFile);
      resolvedIncludes.push(target);
      visit(target, absFile);
    }

    documents[absFile] = { path: absFile, text, includes: resolvedIncludes };
    includeGraph[absFile] = resolvedIncludes;
    orderedFiles.push(absFile);
    visited.add(absFile);

    stack.delete(absFile);
    stackOrder.pop();
  }

  visit(absRoot, null);

  return { rootPath: absRoot, orderedFiles, documents, includeGraph };
}

/**
 * Extract `<include>` targets from XML text, in document order.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractIncludes(text) {
  const out = [];
  let m;
  INCLUDE_RE.lastIndex = 0;
  while ((m = INCLUDE_RE.exec(text)) !== null) {
    const name = m[1].trim();
    if (name) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Resolve one `<include>` name to an absolute local file. Searches the including
 * file's directory first, then each `includeDirs` entry. Network URLs are
 * rejected (never fetched at runtime).
 *
 * @param {string} name  the raw include target (e.g. "common.xml")
 * @param {string} includeDir  directory of the including file
 * @param {string[]} includeDirs  extra search directories (absolute)
 * @param {string[]} allowedRoots  containment roots when allowOutsideRoot=false
 * @param {boolean} allowOutsideRoot
 * @param {string} fromFile  the including file (for error context)
 * @returns {string} absolute path of the resolved include
 * @throws {MavlinkError} DIALECT_INCLUDE_NOT_FOUND
 */
function resolveInclude(name, includeDir, includeDirs, allowedRoots, allowOutsideRoot, fromFile) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) {
    throw new MavlinkError(
      'DIALECT_INCLUDE_NOT_FOUND',
      `Include '${name}' (from '${path.basename(fromFile)}') is a network URL; ` +
        `remote includes are not fetched at runtime.`,
      { include: name, from: fromFile }
    );
  }

  const candidates = [path.resolve(includeDir, name), ...includeDirs.map((d) => path.resolve(d, name))];
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      if (!allowOutsideRoot && !withinAllowedRoots(candidate, allowedRoots)) {
        throw new MavlinkError(
          'DIALECT_INCLUDE_NOT_FOUND',
          `Include '${name}' (from '${path.basename(fromFile)}') resolves outside the ` +
            `dialect directory; set allowOutsideRoot or add an includeDir to permit it.`,
          { include: name, from: fromFile, resolved: candidate }
        );
      }
      return candidate;
    }
  }

  throw new MavlinkError(
    'DIALECT_INCLUDE_NOT_FOUND',
    `Include '${name}' (from '${path.basename(fromFile)}') was not found. Searched: ${candidates.join(', ')}.`,
    { include: name, from: fromFile, searched: candidates }
  );
}

/**
 * True if `file` is inside one of the allowed root directories. Both sides are
 * resolved through `fs.realpathSync` first, so a symlink living under an allowed
 * directory that points elsewhere cannot slip past the containment check (the
 * subsequent read follows symlinks, so the lexical path alone is insufficient).
 *
 * @param {string} file  absolute file path (already known to exist)
 * @param {string[]} allowedRoots  absolute directory paths
 * @returns {boolean}
 */
function withinAllowedRoots(file, allowedRoots) {
  const realFile = realpathOrSelf(file);
  return allowedRoots.some((root) => {
    const realRoot = realpathOrSelf(root);
    const rel = path.relative(realRoot, realFile);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * Resolve a path through `fs.realpathSync`, falling back to the lexical path if
 * it cannot be resolved (e.g. an includeDir that does not exist).
 *
 * @param {string} p
 * @returns {string}
 */
function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return path.resolve(p);
  }
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
 * Read a file, raising a structured error that names the including file.
 *
 * @param {string} absFile
 * @param {?string} fromFile
 * @returns {string}
 */
function readFile(absFile, fromFile) {
  try {
    return fs.readFileSync(absFile, 'utf8');
  } catch (e) {
    throw new MavlinkError(
      'DIALECT_INCLUDE_NOT_FOUND',
      `Could not read dialect XML '${absFile}'` +
        (fromFile ? ` (included from '${path.basename(fromFile)}')` : '') +
        `: ${e.message}.`,
      { path: absFile, from: fromFile }
    );
  }
}

module.exports = { resolveXmlIncludeGraph };
