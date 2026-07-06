'use strict';

const { MissionDownload } = require('../lib/mission/mission-download');
const { MissionUpload } = require('../lib/mission/mission-upload');
const { MissionClear } = require('../lib/mission/mission-clear');
const { missionTypeToNumber } = require('../lib/mission/mission-state-machine');
const { topicAction, normalizeUploadItems, validateMissionItems } = require('../lib/mission/upload-input');
const { toInt, toBool, firstDefined } = require('../lib/util/validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');

/**
 * mavlink-ai-mission (DESIGN.md §13.6, §23, §24).
 *
 * Mission protocol workflow node. Stateful and timeout-driven, so it is kept
 * isolated and runs behind a per-connection/profile/mission-type lock. Mission
 * protocol logic lives in lib/mission — never buried in transport.
 *
 * Outputs: 1) completed mission object  2) progress events  3) errors/timeouts
 */
module.exports = function registerMavlinkAiMission(RED) {
  function MavlinkAiMissionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.connection = RED.nodes.getNode(config.connection);
    node.action = config.action || 'download';
    // 10s default (#58): legacy parity and safe for real radio/serial links.
    node.timeoutMs = toInt(config.timeoutMs, 10000);
    node.maxRetries = toInt(config.maxRetries, 3);

    if (!node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
    }

    node.on('input', async (msg, send, done) => {
      if (!node.connection) {
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-mission',
          code: 'NO_CONNECTION',
          message: 'Mission node has no connection configured.'
        }));
      }

      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      // Aigen-style topic aliases (#56): `upload_mission` etc. select the action
      // without an explicit payload.action. Explicit action still wins.
      const action = msg.action || payload.action || topicAction(msg.topic) || node.action;
      const profile = node.connection.profile;
      const defaults = profile && profile.getDefaults ? profile.getDefaults() : {};

      const targetSystem = firstDefined(payload.target_system, defaults.defaultTargetSystem, 1);
      const targetComponent = firstDefined(payload.target_component, defaults.defaultTargetComponent, 1);
      const missionTypeName = payload.mission_type || defaults.defaultMissionType || 'mission';
      const bundle = profile && profile.getDialect ? profile.getDialect() : null;
      let missionTypeNum;
      try {
        missionTypeNum = missionTypeToNumber(missionTypeName, bundle ? bundle.enums : null);
      } catch (err) {
        const e = toMavlinkError(err, 'BAD_MISSION_TYPE');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-mission',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }
      const useInt = (defaults.preferredMissionItemType || 'MISSION_ITEM_INT') === 'MISSION_ITEM_INT';

      const lockKey = `mission:${node.connection.id}:${profile ? profile.id : 'default'}:${missionTypeNum}`;
      let lock;
      try {
        lock = node.connection.acquireLock(lockKey, node.id);
      } catch (err) {
        const e = toMavlinkError(err, 'LOCK_HELD');
        node.status({ fill: 'red', shape: 'ring', text: 'busy' });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-mission',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      const onProgress = (progress) => {
        node.status({ fill: 'blue', shape: 'dot', text: progress.payload.state });
        send([null, progress, null]);
      };

      const opts = {
        connection: node.connection,
        targetSystem,
        targetComponent,
        // Our own identity, so responses addressed to another GCS on the same
        // vehicle don't advance this workflow.
        sourceSystem: defaults.sourceSystemId,
        sourceComponent: defaults.sourceComponentId,
        missionType: missionTypeName,
        enums: bundle ? bundle.enums : null,
        useInt,
        timeoutMs: node.timeoutMs,
        maxRetries: node.maxRetries,
        onProgress
      };

      try {
        let result;
        if (action === 'download') {
          result = await new MissionDownload(opts).run();
        } else if (action === 'upload') {
          opts.items = validateMissionItems(normalizeUploadItems(payload));
          result = await new MissionUpload(opts).run();
        } else if (action === 'clear') {
          // Best-effort by default (resolve once sent); opt into waiting for a
          // MISSION_ACK with wait_ack, optionally overriding the timeout (#59).
          const waitAck = toBool(firstDefined(msg.wait_ack, payload.wait_ack), false);
          if (waitAck) {
            const clearOpts = Object.assign({}, opts, {
              timeoutMs: toInt(payload.timeout_ms, node.timeoutMs)
            });
            result = await new MissionClear(clearOpts).run();
          } else {
            result = await clearMission(node.connection, targetSystem, targetComponent, missionTypeNum, missionTypeName);
          }
        } else {
          throw Object.assign(new Error(`Unsupported mission action '${action}'.`), { code: 'UNSUPPORTED_ACTION' });
        }

        lock.release();
        node.status({ fill: 'green', shape: 'dot', text: `${action} ok` });
        send([result, null, null]);
        done();
      } catch (err) {
        lock.release();
        const e = toMavlinkError(err, 'MISSION_FAILED');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-mission',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }), err);
      }
    });
  }

  RED.nodes.registerType('mavlink-ai-mission', MavlinkAiMissionNode);
};

/**
 * Clear a mission: send MISSION_CLEAR_ALL. Best-effort — we resolve once the
 * message is sent rather than blocking on an ack, since some stacks do not ack
 * a clear of an already-empty mission.
 */
async function clearMission(connection, targetSystem, targetComponent, missionTypeNum, missionTypeName) {
  await connection.send({
    name: 'MISSION_CLEAR_ALL',
    fields: { target_system: targetSystem, target_component: targetComponent, mission_type: missionTypeNum }
  });
  return {
    topic: 'mission/cleared',
    payload: {
      target_system: targetSystem,
      target_component: targetComponent,
      mission_type: missionTypeName,
      // Best-effort clear: resolved on send, not on a vehicle ack. Set wait_ack
      // to get an acknowledged clear (#59).
      acked: false
    }
  };
}

/**
 * Emit an error on output 3 and finish the input handler.
 *
 * @param {object} node
 * @param {function} send
 * @param {function} done
 * @param {object} payload  error payload (§14.5)
 * @param {Error} [rawErr]  optional error to pass to done()
 * @returns {void}
 */
function finishError(node, send, done, payload, rawErr) {
  send([null, null, { topic: 'mavlink/error', payload }]);
  done(rawErr);
}
