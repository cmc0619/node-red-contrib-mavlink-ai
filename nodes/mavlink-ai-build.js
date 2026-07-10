'use strict';

const { getMessageClass } = require('../lib/dialects/dialect-loader');
const normalizer = require('../lib/protocol/message-normalizer');
const { validate } = require('../lib/protocol/message-validator');
const { toBool, firstDefined } = require('../lib/util/validation');
const { errorPayload } = require('../lib/util/errors');
const { registerEditorApi } = require('../lib/editor-api');

/**
 * mavlink-ai-build (DESIGN.md §13.3).
 *
 * Builds a normalized outbound MAVLink message object (the §14.2 contract)
 * without sending it. Resolves enum-name strings against the profile dialect
 * and optionally applies profile target defaults.
 */
module.exports = function registerMavlinkAiBuild(RED) {
  // Serve message/field/enum metadata to the editor's dynamic field UI.
  registerEditorApi(RED);

  function MavlinkAiBuildNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.profile = RED.nodes.getNode(config.profile);
    node.messageName = config.messageName || 'HEARTBEAT';
    node.fieldsJson = config.fields || '';
    node.applyDefaults = toBool(config.applyDefaults, true);

    let configFields = {};
    if (node.fieldsJson) {
      try {
        configFields = JSON.parse(node.fieldsJson);
      } catch (e) {
        node.warn(`mavlink-ai-build: invalid fields JSON, ignoring (${e.message})`);
      }
    }

    if (!node.profile || !node.profile.isValid || !node.profile.isValid()) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid profile' });
    }

    node.on('input', (msg, send, done) => {
      const bundle = node.profile && node.profile.isValid() ? node.profile.getDialect() : null;
      const name = msg.messageName || (msg.payload && msg.payload.name) || node.messageName;

      if (!bundle) {
        sendError(node, msg, send, 'INVALID_PROFILE', 'Build node has no valid profile/dialect.');
        return done();
      }

      const clazz = getMessageClass(bundle, name);
      if (!clazz) {
        sendError(node, msg, send, 'UNKNOWN_MESSAGE', `Unknown message '${name}' for dialect '${bundle.name}'.`);
        return done();
      }

      // Merge config fields with msg.payload fields (payload wins). When the
      // payload is used directly as the field set, strip the reserved `name`/
      // `fields` keys so they don't show up as spurious "unknown field" warnings.
      let payloadFields = {};
      if (msg.payload && typeof msg.payload === 'object') {
        if (msg.payload.fields && typeof msg.payload.fields === 'object') {
          payloadFields = msg.payload.fields;
        } else {
          const { name: _ignoredName, fields: _ignoredFields, ...rest } = msg.payload;
          payloadFields = rest;
        }
      }
      const merged = Object.assign({}, configFields, payloadFields);

      const report = validate(bundle, name, merged);
      if (report.unknownFields.length) {
        node.warn(`mavlink-ai-build: ignoring unknown field(s) for ${name}: ${report.unknownFields.join(', ')}`);
      }

      let fields;
      try {
        fields = normalizer.normalizeFields(bundle, clazz, merged);
      } catch (e) {
        // e.g. UNRESOLVED_FIELD_VALUE: a misspelled enum name on a numeric field.
        sendError(node, msg, send, e.code || 'BAD_FIELDS', e.message);
        return done();
      }
      const defaults = node.profile.getDefaults();

      // `profile` carries the config-node id — the canonical reference the
      // connection resolves a codec by. The name is display-only.
      const out = {
        name: clazz.MSG_NAME,
        profile: node.profile.id,
        profile_name: node.profile.name,
        fields
      };
      if (node.applyDefaults) {
        out.target_system = firstDefined(merged.target_system, defaults.defaultTargetSystem, 1);
        out.target_component = firstDefined(merged.target_component, defaults.defaultTargetComponent, 1);
      }

      msg.topic = 'mavlink/send';
      msg.payload = out;
      node.status({ fill: 'green', shape: 'dot', text: clazz.MSG_NAME });
      send(msg);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-build', MavlinkAiBuildNode);
};

/**
 * Emit a structured `mavlink/error` message and set the node's error badge.
 *
 * @param {object} node
 * @param {object} msg   the message being processed
 * @param {function} send
 * @param {string} code
 * @param {string} message
 * @returns {void}
 */
function sendError(node, msg, send, code, message) {
  node.status({ fill: 'red', shape: 'ring', text: code });
  msg.topic = 'mavlink/error';
  msg.payload = errorPayload({ node: 'mavlink-ai-build', code, message });
  send(msg);
}
