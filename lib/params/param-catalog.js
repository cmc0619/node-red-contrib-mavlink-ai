'use strict';

const fs = require('fs');
const path = require('path');
const { MavlinkError } = require('../util/errors');
const { resolveParamDefSource } = require('./param-def-sources');

/**
 * Downloadable parameter-definition catalog (issue #125).
 *
 * Mirrors the XML dialect catalog (`lib/dialects/xml-catalog.js`): an injectable
 * network fetcher keeps the logic testable offline, and a `baseDir` under the
 * Node-RED user dir (typically `<userDir>/mavlink-ai/params`) caches one
 * normalized index per firmware/vehicle source. The index powers the param
 * node's Param ID picker and per-param value pulldowns; when no source is cached
 * (or the firmware has none) the editor falls back to free-text / numeric input.
 *
 * Layout under the base dir:
 *
 *   <sourceKey>/index.json   normalized ParamDef[] + provenance (url, fetchedAt)
 *
 * where `<sourceKey>` is e.g. `ardupilot-copter` or `px4`.
 */

/** Abort a metadata fetch that hasn't completed (headers + body) within this. */
const FETCH_TIMEOUT_MS = 20000;

/** Per-process counter for unique temp file names during atomic cache writes. */
let tmpSeq = 0;

/**
 * Default network fetcher for one parameter-metadata file. Uses global fetch
 * (Node 18+), so no new dependency. Bounds the whole request (connect through
 * body read) with an AbortController timeout so an unresponsive metadata server
 * can't hang the editor, and normalizes every failure — transport error, non-2xx,
 * or a body-read error — onto the structured `PARAM_CATALOG_FETCH_FAILED` path.
 *
 * @param {string} url
 * @returns {Promise<string>} the file text
 */
async function defaultFetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      throw new MavlinkError('PARAM_CATALOG_FETCH_FAILED', `Failed to download param metadata: ${err.message}`, { url });
    }
    if (!res.ok) {
      throw new MavlinkError('PARAM_CATALOG_FETCH_FAILED', `Failed to download param metadata (${res.status} ${res.statusText}).`, {
        url,
        status: res.status
      });
    }
    try {
      return await res.text();
    } catch (err) {
      throw new MavlinkError('PARAM_CATALOG_FETCH_FAILED', `Failed to read param metadata body: ${err.message}`, { url });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sanitize a source key into a single safe path segment, rejecting traversal.
 *
 * @param {string} sourceKey
 * @returns {string}
 */
function safeSegment(sourceKey) {
  const seg = String(sourceKey || '').replace(/[^a-z0-9._-]+/gi, '-');
  if (seg === '' || seg === '.' || seg === '..') {
    throw new MavlinkError('PARAM_CATALOG_BAD_SOURCE', `Invalid param source key '${sourceKey}'.`);
  }
  return seg;
}

class ParamCatalog {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir  cache root (e.g. `<userDir>/mavlink-ai/params`)
   * @param {function} [opts.fetchText]  (url) -> Promise<string>
   * @param {function} [opts.now]        clock override (tests)
   */
  constructor(opts = {}) {
    if (!opts.baseDir) {
      throw new MavlinkError('PARAM_CATALOG_NO_DIR', 'ParamCatalog requires a baseDir.');
    }
    this.baseDir = opts.baseDir;
    this.fetchText = opts.fetchText || defaultFetchText;
    this.now = opts.now || Date.now;
  }

  /**
   * Absolute directory for one source's cached index.
   *
   * @param {string} sourceKey
   * @returns {string}
   */
  sourceDir(sourceKey) {
    return path.join(this.baseDir, safeSegment(sourceKey));
  }

  /**
   * Download and cache the normalized parameter index for a firmware/vehicle.
   * The URL comes from the request (`url`) or the registry default; PX4 has no
   * baked-in URL, so one must be supplied.
   *
   * @param {object} req
   * @param {string} req.firmware
   * @param {string} [req.vehicleType]
   * @param {string} [req.url]  override / required-for-PX4 metadata URL
   * @returns {Promise<object>} the cached index (provenance + params)
   */
  async update(req = {}) {
    const source = resolveParamDefSource({ firmware: req.firmware, vehicleType: req.vehicleType });
    if (!source) {
      throw new MavlinkError('PARAM_CATALOG_NO_SOURCE', `No parameter-definition source for firmware '${req.firmware}'.`, {
        firmware: req.firmware,
        vehicleType: req.vehicleType
      });
    }
    const url = req.url ? String(req.url) : source.url;
    if (!url) {
      throw new MavlinkError('PARAM_CATALOG_URL_REQUIRED', `A metadata URL is required for the '${source.sourceKey}' source.`, {
        sourceKey: source.sourceKey
      });
    }
    const raw = await this.fetchText(url);
    const params = source.parse(raw);
    if (!Array.isArray(params) || params.length === 0) {
      throw new MavlinkError('PARAM_CATALOG_EMPTY', 'The downloaded parameter metadata contained no parameters.', {
        sourceKey: source.sourceKey,
        url
      });
    }
    const index = {
      sourceKey: source.sourceKey,
      firmware: source.firmware,
      vehicleType: source.vehicleType,
      format: source.format,
      url,
      fetchedAt: new Date(this.now()).toISOString(),
      count: params.length,
      params
    };
    const dir = this.sourceDir(source.sourceKey);
    fs.mkdirSync(dir, { recursive: true });
    /**
     * Write to a unique temp file and rename it over index.json, so an
     * interrupted or failing write leaves the previous valid cache intact
     * instead of truncating it (a partial index.json reads as "uncached").
     */
    const target = path.join(dir, 'index.json');
    tmpSeq += 1;
    const tmp = path.join(dir, `.index.json.${process.pid}.${tmpSeq}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, target);
    return index;
  }

  /**
   * Read a cached index by its source key, or null when not cached.
   *
   * @param {string} sourceKey
   * @returns {?object}
   */
  getByKey(sourceKey) {
    /** Resolve (and validate) the path outside the try so a bad-key error propagates rather than reading as "not cached". */
    const file = path.join(this.sourceDir(sourceKey), 'index.json');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Read the cached index for a firmware/vehicle, or null when the firmware has
   * no source or nothing is cached yet.
   *
   * @param {object} ctx
   * @param {string} ctx.firmware
   * @param {string} [ctx.vehicleType]
   * @returns {?object}
   */
  get(ctx = {}) {
    const source = resolveParamDefSource(ctx);
    if (!source) {
      return null;
    }
    return this.getByKey(source.sourceKey);
  }

  /**
   * List every cached source's provenance (no params), newest first.
   *
   * @returns {Array<object>}
   */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const index = this.getByKey(entry.name);
      if (!index) {
        continue;
      }
      out.push({
        sourceKey: index.sourceKey,
        firmware: index.firmware,
        vehicleType: index.vehicleType,
        format: index.format,
        url: index.url,
        fetchedAt: index.fetchedAt,
        count: index.count
      });
    }
    out.sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)));
    return out;
  }

  /**
   * Resolve one parameter's choice metadata from the cached index for a
   * firmware/vehicle. Param IDs match case-insensitively (`rc1_min` == `RC1_MIN`).
   * Returns null when uncached or the id isn't in the catalog.
   *
   * @param {object} ctx
   * @param {string} ctx.firmware
   * @param {string} [ctx.vehicleType]
   * @param {string} ctx.paramId
   * @returns {?object} the ParamDef, or null
   */
  paramChoices(ctx = {}) {
    const index = this.get(ctx);
    if (!index || !Array.isArray(index.params)) {
      return null;
    }
    const wanted = String(ctx.paramId || '').trim().toUpperCase();
    if (wanted === '') {
      return null;
    }
    return index.params.find((p) => p.paramId === wanted) || null;
  }
}

module.exports = { ParamCatalog, defaultFetchText };
