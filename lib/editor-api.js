'use strict';

const { knownDialects } = require('./dialects/dialect-loader');
const { buildMetadata } = require('./dialects/message-metadata');
const { knownModes } = require('./command/flight-modes');

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
}

module.exports = { registerEditorApi };
