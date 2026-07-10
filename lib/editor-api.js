'use strict';

const path = require('path');
const { knownDialects } = require('./dialects/dialect-loader');
const { buildMetadata } = require('./dialects/message-metadata');
const { knownModes } = require('./command/flight-modes');
const { XmlCatalog } = require('./dialects/xml-catalog');

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
}

module.exports = { registerEditorApi };
