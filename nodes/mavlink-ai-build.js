'use strict';

const { getMessageClass } = require('../lib/dialects/dialect-loader');
const normalizer = require('../lib/protocol/message-normalizer');
const { validate } = require('../lib/protocol/message-validator');
const { toBool } = require('../lib/util/validation');
const { errorPayload } = require('../lib/util/errors');

/**
 * mavlink-ai-build (DESIGN.md §13.3).
 *
 * Builds a normalized outbound MAVLink message object (the §14.2 contract)
 * without sending it. Resolves enum-name strings against the profile dialect
 * and optionally applies profile target defaults.
 */
module.exports = function registerMavlinkAiBuild(RED) {
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

      // Merge config fields with msg.payload fields (payload wins).
      const payloadFields =
        msg.payload && typeof msg.payload === 'object'
          ? msg.payload.fields && typeof msg.payload.fields === 'object'
            ? msg.payload.fields
            : msg.payload
          : {};
      const merged = Object.assign({}, configFields, payloadFields);

      const report = validate(bundle, name, merged);
      if (report.unknownFields.length) {
        node.warn(`mavlink-ai-build: ignoring unknown field(s) for ${name}: ${report.unknownFields.join(', ')}`);
      }

      const fields = normalizer.normalizeFields(bundle, clazz, merged);
      const defaults = node.profile.getDefaults();

      const out = {
        name: clazz.MSG_NAME,
        profile: node.profile.name,
        fields
      };
      if (node.applyDefaults) {
        out.target_system = firstDefined(merged.target_system, defaults.defaultTargetSystem);
        out.target_component = firstDefined(merged.target_component, defaults.defaultTargetComponent);
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

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) {
      return v;
    }
  }
  return undefined;
}

function sendError(node, msg, send, code, message) {
  node.status({ fill: 'red', shape: 'ring', text: code });
  msg.topic = 'mavlink/error';
  msg.payload = errorPayload({ node: 'mavlink-ai-build', code, message });
  send(msg);
}
