'use strict';

const { parseList, parseIdList, toNum, toBool, idAccepted } = require('../lib/util/validation');
const { fieldsSignature } = require('../lib/util/fields-signature');
const { registerEditorApi } = require('../lib/editor-api');

/**
 * mavlink-ai-filter (DESIGN.md §13.4).
 *
 * Filters decoded MAVLink messages by name/id/profile/identity/target/field,
 * with optional rate limiting and changed-only passing. High-rate telemetry can
 * flood Node-RED, so rate limiting here is survival, not decoration.
 */
module.exports = function registerMavlinkAiFilter(RED) {
  // Serve message/field/enum metadata to the editor's message/field pickers.
  registerEditorApi(RED);

  function MavlinkAiFilterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.messageNames = parseList(config.messageNames).map((n) => n.toUpperCase());
    node.messageIds = parseIdList(config.messageIds);
    node.profileFilter = config.profileFilter || '';
    node.sysids = parseIdList(config.sysid);
    node.compids = parseIdList(config.compid);
    node.targetSystems = parseIdList(config.targetSystem);
    node.targetComponents = parseIdList(config.targetComponent);
    node.fieldName = config.fieldName || '';
    node.fieldValue = config.fieldValue === '' ? undefined : config.fieldValue;
    node.fieldExists = toBool(config.fieldExists, false);
    // toNum, not toInt: sub-1Hz rates like 0.5 are meaningful and truncation
    // would silently disable the limit.
    node.rateLimitHz = toNum(config.rateLimitHz, 0);
    node.changedOnly = toBool(config.changedOnly, false);

    const lastDelivered = new Map(); // key -> timestamp
    const lastSignature = new Map(); // key -> JSON of fields

    node.on('input', (msg, send, done) => {
      const payload = msg.payload || {};
      const fields = payload.fields || {};

      if (node.messageNames.length && !node.messageNames.includes(String(payload.name).toUpperCase())) {
        return done();
      }
      if (node.messageIds.length && !node.messageIds.includes(Number(payload.id))) {
        return done();
      }
      // Matches the profile display name or the config-node id (the canonical
      // reference carried in payload.profile_id).
      if (node.profileFilter && payload.profile !== node.profileFilter && payload.profile_id !== node.profileFilter) {
        return done();
      }
      if (!idAccepted(payload.sysid, node.sysids)) {
        return done();
      }
      if (!idAccepted(payload.compid, node.compids)) {
        return done();
      }
      // target_* may legitimately be absent; treat "missing" as a pass-through
      // so broadcast messages are not dropped by a target filter.
      if (node.targetSystems.length && fields.target_system !== undefined) {
        if (!node.targetSystems.includes(Number(fields.target_system))) {
          return done();
        }
      }
      if (node.targetComponents.length && fields.target_component !== undefined) {
        if (!node.targetComponents.includes(Number(fields.target_component))) {
          return done();
        }
      }
      if (node.fieldName) {
        const has = Object.prototype.hasOwnProperty.call(fields, node.fieldName);
        if (node.fieldExists && !has) {
          return done();
        }
        if (node.fieldValue !== undefined) {
          if (!has || String(fields[node.fieldName]) !== String(node.fieldValue)) {
            return done();
          }
        }
      }

      const key = `${payload.name}:${payload.sysid}:${payload.compid}`;
      const now = Date.now();

      // Check the rate-limit window, but don't advance the clock until the
      // message clears every filter below — otherwise a message dropped by
      // changedOnly would still consume the delivery window and wrongly
      // suppress the next genuinely-new value.
      if (node.rateLimitHz > 0) {
        const minInterval = 1000 / node.rateLimitHz;
        if (now - (lastDelivered.get(key) || 0) < minInterval) {
          return done();
        }
      }

      if (node.changedOnly) {
        const sig = fieldsSignature(fields);
        if (lastSignature.get(key) === sig) {
          return done();
        }
        lastSignature.set(key, sig);
      }

      if (node.rateLimitHz > 0) {
        lastDelivered.set(key, now);
      }

      send(msg);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-filter', MavlinkAiFilterNode);
};
