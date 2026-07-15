'use strict';

const path = require('path');
const { knownDialects } = require('./dialects/dialect-loader');
const { buildMetadata } = require('./dialects/message-metadata');
const { knownModes } = require('./command/flight-modes');
const { resolveParamChoices } = require('./command/param-resolvers');
const { XmlCatalog } = require('./dialects/xml-catalog');
const { ParamCatalog } = require('./params/param-catalog');
const { resolveParamDefSource } = require('./params/param-def-sources');

/**
 * Resolve the XML catalog cache dir under the Node-RED user directory (issue
 * #61), falling back to the cwd when settings aren't available.
 *
 * @param {object} RED
 * @returns {string}
 */
function catalogBaseDir(RED) {
  const userDir = (RED && RED.settings && RED.settings.userDir) || process.cwd();
  return path.join(userDir, 'mavlink-ai', 'xml');
}

/**
 * Resolve the parameter-definition catalog cache dir under the Node-RED user
 * directory (issue #125), falling back to the cwd when settings aren't available.
 *
 * @param {object} RED
 * @returns {string}
 */
function paramCatalogBaseDir(RED) {
  const userDir = (RED && RED.settings && RED.settings.userDir) || process.cwd();
  return path.join(userDir, 'mavlink-ai', 'params');
}

/**
 * Editor-side HTTP API used by the dynamic message-field UI (mavlink-ai-build,
 * and later command/filter). It serves, per dialect, the message list and each
 * message's fields with readable enum tables — the data the browser editor
 * needs to render "pick a message, get labeled fields with enum dropdowns".
 *
 * Registration is idempotent and guarded, so multiple node modules can call it
 * without double-registering routes. It is a no-op when RED has no httpAdmin
 * (e.g. the smoke-load / MockRED test harnesses).
 */

// Track registration per RED instance (not a module-level boolean): two
// Node-RED runtimes sharing this module in one process (embedded usage, test
// harnesses) must each get their routes (issue #35).
const registeredInstances = new WeakSet();

/**
 * Register the editor metadata endpoints on RED.httpAdmin (once per RED
 * instance).
 *
 * @param {object} RED  the Node-RED runtime
 * @returns {void}
 */
function registerEditorApi(RED) {
  if (!RED || !RED.httpAdmin || registeredInstances.has(RED)) {
    return;
  }
  registeredInstances.add(RED);

  const guard =
    RED.auth && typeof RED.auth.needsPermission === 'function'
      ? RED.auth.needsPermission('mavlink-ai.read')
      : (req, res, next) => next();

  // List the dialects the loader can serve.
  RED.httpAdmin.get('/mavlink-ai/dialects', guard, (req, res) => {
    res.json({ ok: true, dialects: knownDialects() });
  });

  // Full editor metadata (messages + fields + enum tables) for one dialect.
  // For a custom-XML profile the editors also pass customDialectPath, so the
  // dynamic field UI works for runtime-compiled dialects too (same trust level
  // as deploying the profile, and behind the same admin permission).
  RED.httpAdmin.get('/mavlink-ai/metadata', guard, (req, res) => {
    const dialect = String(req.query.dialect || 'ardupilotmega');
    const customDialectPath = req.query.customDialectPath ? String(req.query.customDialectPath) : '';
    let md;
    try {
      md = buildMetadata(dialect, customDialectPath ? { customDialectPath } : {});
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
      return;
    }
    res.json({
      ok: md.valid,
      dialect: md.dialect,
      error: md.error,
      messages: md.messages,
      enums: md.enums,
      // Command-specific param metadata (MAV_CMD_* -> named param labels) drives
      // the command editor's parameter form; without it every MAV_CMD falls back
      // to raw param1..7 (#7).
      commands: md.commands
    });
  });

  // Flight-mode names for a firmware/vehicle combination (#49). Drives the
  // command editor's Set Mode dropdown; an empty list means mode names are
  // not supported for the combination and the editor falls back to numeric
  // custom-mode input.
  RED.httpAdmin.get('/mavlink-ai/modes', guard, (req, res) => {
    const firmware = String(req.query.firmware || '');
    const vehicleType = String(req.query.vehicleType || '');
    res.json({ ok: true, firmware, vehicleType, modes: knownModes(firmware, vehicleType) });
  });

  // Profile/target-context-aware choices for a raw MAV_CMD_* parameter (#97).
  // Given a resolver name and the current context (profile firmware/vehicle
  // type, target component type, dialect), return the readable name + numeric
  // wire value pairs to populate a profile-aware dropdown. An empty choice list
  // means the editor should fall back to numeric input for the combination.
  RED.httpAdmin.get('/mavlink-ai/param-choices', guard, (req, res) => {
    const resolver = String(req.query.resolver || '');
    const firmware = String(req.query.firmware || '');
    const vehicleType = String(req.query.vehicleType || '');
    const componentType = String(req.query.componentType || '');
    // Component-aware resolvers pull their choice sets from the dialect enum
    // tables (so custom dialects that define those enums work too).
    let enums = {};
    const dialect = req.query.dialect ? String(req.query.dialect) : '';
    if (dialect) {
      const customDialectPath = req.query.customDialectPath ? String(req.query.customDialectPath) : '';
      try {
        const md = buildMetadata(dialect, customDialectPath ? { customDialectPath } : {});
        if (md.valid) {
          enums = md.enums;
        }
      } catch (err) {
        // Fall through with empty enums: a resolver that doesn't need them
        // (e.g. profile-flight-mode) still works; component ones return empty.
      }
    }
    const result = resolveParamChoices(resolver, { firmware, vehicleType, componentType, enums });
    res.json({ ok: true, firmware, vehicleType, componentType, ...result });
  });

  // Downloading writes to the user directory and hits the network, so guard it
  // with a write permission where available (falling back to the read guard).
  const writeGuard =
    RED.auth && typeof RED.auth.needsPermission === 'function'
      ? RED.auth.needsPermission('mavlink-ai.write')
      : guard;

  // --- MAVLink XML catalog (issue #61) ------------------------------------
  // Downloaded XML files are managed *Custom* dialect paths, not a new runtime
  // mode and not a replacement for bundled dialects.

  /** List downloaded snapshots + which dialects are also bundled. */
  RED.httpAdmin.get('/mavlink-ai/xml-catalog', guard, (req, res) => {
    try {
      const catalog = new XmlCatalog({ baseDir: catalogBaseDir(RED) });
      const bundled = new Set(knownDialects());
      const snapshots = catalog.list().map((m) => {
        // A root whose required include closure is incomplete (#88) must not
        // be presented as selectable — surface why instead.
        const unusableBy = new Map((m.unusable || []).map((u) => [u.file, u.missingIncludes]));
        return {
          snapshotId: m.snapshotId,
          repo: m.repo,
          ref: m.ref,
          commit: m.commit,
          downloadedAt: m.downloadedAt,
          files: (m.files || []).map((f) => ({
            name: f.name,
            sha256: f.sha256,
            bytes: f.bytes,
            dialect: f.name.replace(/\.xml$/i, ''),
            bundledExists: bundled.has(f.name.replace(/\.xml$/i, '')),
            usable: !unusableBy.has(f.name),
            missingIncludes: unusableBy.get(f.name) || [],
            // Concrete, immutable path to persist in a profile's customDialectPath.
            path: path.join(catalog.snapshotsDir(), m.snapshotId, f.name)
          })),
          missing: m.missing || [],
          unusable: m.unusable || []
        };
      });
      res.json({ ok: true, baseDir: catalog.baseDir, snapshots });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Download/refresh the catalog from an official source. */
  RED.httpAdmin.post('/mavlink-ai/xml-catalog/update', writeGuard, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const catalog = new XmlCatalog({ baseDir: catalogBaseDir(RED) });
    catalog
      .update({ repo: body.repo, ref: body.ref, files: Array.isArray(body.files) ? body.files : undefined })
      .then((manifest) => res.json({ ok: true, manifest }))
      .catch((err) => res.status(500).json({ ok: false, error: err.message, code: err.code }));
  });

  /** Compare one downloaded XML against the same-named bundled dialect. */
  RED.httpAdmin.get('/mavlink-ai/xml-catalog/compare', guard, (req, res) => {
    try {
      const catalog = new XmlCatalog({ baseDir: catalogBaseDir(RED) });
      const result = catalog.compare({
        file: String(req.query.file || ''),
        snapshot: req.query.snapshot ? String(req.query.snapshot) : undefined
      });
      res.json({ ok: true, comparison: result });
    } catch (err) {
      res.status(err.code === 'XML_CATALOG_FILE_NOT_FOUND' ? 404 : 500).json({ ok: false, error: err.message, code: err.code });
    }
  });

  /**
   * Parameter-definition catalog (issue #125). Firmware-specific param metadata
   * (ranges, Values, Bitmask) that MAVLink XML doesn't carry, cached per
   * firmware/vehicle to drive the Param ID picker and value pulldowns. Degrades
   * to free text when a firmware has no source.
   *
   * Report the source for a firmware/vehicle (whether one exists, its URL, and
   * whether a URL must be supplied) plus every cached source. The editor uses
   * this to decide between a picker and plain free text.
   */
  RED.httpAdmin.get('/mavlink-ai/param-catalog', guard, (req, res) => {
    try {
      const firmware = String(req.query.firmware || '');
      const vehicleType = String(req.query.vehicleType || '');
      const source = resolveParamDefSource({ firmware, vehicleType });
      const catalog = new ParamCatalog({ baseDir: paramCatalogBaseDir(RED) });
      const cached = source ? catalog.getByKey(source.sourceKey) : null;
      res.json({
        ok: true,
        firmware,
        vehicleType,
        source: source
          ? { sourceKey: source.sourceKey, format: source.format, url: source.url, urlRequired: source.urlRequired }
          : null,
        cached: cached ? { fetchedAt: cached.fetchedAt, count: cached.count, url: cached.url } : null,
        sources: catalog.list()
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });

  /** Download/refresh the parameter metadata for a firmware/vehicle. */
  RED.httpAdmin.post('/mavlink-ai/param-catalog/update', writeGuard, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const catalog = new ParamCatalog({ baseDir: paramCatalogBaseDir(RED) });
    catalog
      .update({ firmware: body.firmware, vehicleType: body.vehicleType, url: body.url })
      .then((index) =>
        res.json({ ok: true, sourceKey: index.sourceKey, count: index.count, url: index.url, fetchedAt: index.fetchedAt })
      )
      .catch((err) => res.status(500).json({ ok: false, error: err.message, code: err.code }));
  });

  /**
   * Return the cached param list for a firmware/vehicle as lightweight rows
   * (id + description + whether it has value/bitmask choices) to populate the
   * searchable Param ID picker without shipping every choice table.
   */
  RED.httpAdmin.get('/mavlink-ai/param-catalog/params', guard, (req, res) => {
    try {
      const firmware = String(req.query.firmware || '');
      const vehicleType = String(req.query.vehicleType || '');
      const catalog = new ParamCatalog({ baseDir: paramCatalogBaseDir(RED) });
      const index = catalog.get({ firmware, vehicleType });
      if (!index) {
        res.json({ ok: true, cached: false, params: [] });
        return;
      }
      const params = index.params.map((p) => ({
        paramId: p.paramId,
        type: p.type,
        units: p.units,
        description: p.description,
        hasValues: p.values.length > 0,
        hasBitmask: p.bitmask.length > 0
      }));
      res.json({ ok: true, cached: true, fetchedAt: index.fetchedAt, count: index.count, params });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });

  /** Return one parameter's full choice metadata for the value control. */
  RED.httpAdmin.get('/mavlink-ai/param-catalog/param', guard, (req, res) => {
    try {
      const firmware = String(req.query.firmware || '');
      const vehicleType = String(req.query.vehicleType || '');
      const paramId = String(req.query.paramId || '');
      const catalog = new ParamCatalog({ baseDir: paramCatalogBaseDir(RED) });
      const def = catalog.paramChoices({ firmware, vehicleType, paramId });
      res.json({ ok: true, found: !!def, param: def || null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, code: err.code });
    }
  });
}

module.exports = { registerEditorApi };
