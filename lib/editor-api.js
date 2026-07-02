'use strict';

const { knownDialects } = require('./dialects/dialect-loader');
const { buildMetadata } = require('./dialects/message-metadata');

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

let registered = false;

/**
 * Register the editor metadata endpoints on RED.httpAdmin (once).
 *
 * @param {object} RED  the Node-RED runtime
 * @returns {void}
 */
function registerEditorApi(RED) {
  if (registered || !RED || !RED.httpAdmin) {
    return;
  }
  registered = true;

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
}

module.exports = { registerEditorApi };
