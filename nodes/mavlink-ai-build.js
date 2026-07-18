'use strict';

const { getMessageClass } = require('../lib/dialects/dialect-loader');
const normalizer = require('../lib/protocol/message-normalizer');
const { validate } = require('../lib/protocol/message-validator');
const { toBool, firstDefined, parseJsonObjectConfig } = require('../lib/util/validation');
const { MavlinkError } = require('../lib/util/errors');
const { makeFail } = require('../lib/util/node-errors');
const { registerEditorApi } = require('../lib/editor-api');
const { watchConfigBadge } = require('../lib/util/node-lifecycle');

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
    /**
     * Resolves node.profile and keeps the "invalid profile" badge live across
     * deploys, so a profile fixed after this node was deployed clears the badge.
     */
    watchConfigBadge(RED, node, config, { profile: 'required' });
    node.messageName = config.messageName || 'HEARTBEAT';
    node.fieldsJson = config.fields || '';
    node.applyDefaults = toBool(config.applyDefaults, true);

    /**
     * Malformed static `fields` JSON makes the node invalid instead of silently
     * becoming `{}` and emitting a zero-filled message (#204). Blank stays the
     * documented empty default; the editor blocks bad JSON, but imported/API/
     * hand-edited flows bypass that validator.
     */
    const parsedFields = parseJsonObjectConfig(node.fieldsJson, 'fields');
    const configFields = parsedFields.value;
    node._configError = parsedFields.error;
    if (node._configError) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    }

    node.on('input', (msg, send, done) => {
      /**
       * The single error exit (#285): one closure binds node/msg/send/done,
       * so call sites pass only the failure — the shape that made the #276
       * arity-shift bug impossible to write.
       */
      const fail = makeFail({ node, nodeName: 'mavlink-ai-build', msg, send, done });
      if (node._configError) {
        return fail(new MavlinkError('INVALID_CONFIG', `mavlink-ai-build: ${node._configError}`));
      }
      const bundle = node.profile && node.profile.isValid() ? node.profile.getDialect() : null;
      const name = msg.messageName || (msg.payload && msg.payload.name) || node.messageName;

      if (!bundle) {
        return fail(new MavlinkError('INVALID_PROFILE', 'Build node has no valid profile/dialect.'));
      }

      const clazz = getMessageClass(bundle, name);
      if (!clazz) {
        return fail(new MavlinkError('UNKNOWN_MESSAGE', `Unknown message '${name}' for dialect '${bundle.name}'.`));
      }

      // Merge config fields with msg.payload fields (payload wins). When the
      // payload is used directly as the field set, strip the reserved `name`/
      // `fields` keys so they don't show up as spurious "unknown field" warnings.
      let payloadFields = {};
      if (msg.payload && typeof msg.payload === 'object') {
        if (msg.payload.fields && typeof msg.payload.fields === 'object') {
          payloadFields = msg.payload.fields;
        } else {
          const {
            name: _ignoredName,
            fields: _ignoredFields,
            vehicleProfile: _ignoredVehicleProfile,
            localIdentity: _ignoredLocalIdentity,
            profile: _ignoredProfile,
            ...rest
          } = msg.payload;
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
        /** e.g. UNRESOLVED_FIELD_VALUE: a misspelled enum name on a numeric field. */
        return fail(e, 'BAD_FIELDS');
      }
      const defaults = node.profile.getDefaults();

      // `vehicleProfile` carries the config-node id — the canonical reference
      // the connection resolves a codec by. The name is display-only. An
      // explicit localIdentity request on the incoming payload rides along
      // untouched; it is never derived from the Vehicle Profile (#228).
      const out = {
        name: clazz.MSG_NAME,
        vehicleProfile: node.profile.id,
        vehicleProfileName: node.profile.name,
        fields
      };
      const requestedIdentity = msg.payload && typeof msg.payload === 'object' ? msg.payload.localIdentity : undefined;
      if (requestedIdentity !== undefined && requestedIdentity !== null && requestedIdentity !== '') {
        out.localIdentity = requestedIdentity;
      }
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

