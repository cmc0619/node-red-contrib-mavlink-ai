'use strict';

const { MissionDownload } = require('../lib/mission/mission-download');
const { MissionUpload } = require('../lib/mission/mission-upload');
const { MissionClear } = require('../lib/mission/mission-clear');
const { missionTypeToNumber } = require('../lib/mission/mission-state-machine');
const { topicAction, normalizeUploadItems, validateMissionItems } = require('../lib/mission/upload-input');
const { toInt, toBool, firstDefined } = require('../lib/util/validation');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { resolveWorkflowContext } = require('../lib/util/workflow-profile');
const { watchConfigBadge } = require('../lib/util/node-lifecycle');

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
    /**
     * Resolve node.connection and keep its "missing connection" badge live
     * across deploys — a connection added/fixed after the first deploy would
     * otherwise leave a stale red badge (#164).
     */
    watchConfigBadge(RED, node, config, { connection: 'required' });
    /**
     * Optional profile override. Kept as the raw config-node id (not resolved
     * here) so a dangling reference fails the workflow loudly instead of
     * silently running under the connection's default profile.
     */
    node.profileRef = config.profile || '';
    node.action = config.action || 'download';
    // 10s default (#58): legacy parity and safe for real radio/serial links.
    node.timeoutMs = toInt(config.timeoutMs, 10000);
    node.maxRetries = toInt(config.maxRetries, 3);

    // Active workflow objects, aborted when the node closes (#83) so a partial
    // deploy doesn't leave subscriptions, response timers, and the mission
    // lock running until success/timeout on an obsolete node.
    const activeWorkflows = new Set();
    let closed = false;

    /**
     * Run a workflow while tracking it for close-time abort.
     *
     * @param {object} workflow  a Mission* workflow instance
     * @returns {Promise<object>} the workflow result
     */
    async function runTracked(workflow) {
      activeWorkflows.add(workflow);
      try {
        return await workflow.run();
      } finally {
        activeWorkflows.delete(workflow);
      }
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

      // Effective profile for the whole workflow: an explicit override (msg or
      // node config) or the target's routed profile, not blindly the
      // connection's default. It supplies dialect/enums, source identity,
      // mission preferences, target defaults, and rides on every send.
      let profile, defaults, targetSystem, targetComponent;
      try {
        ({ profile, defaults, targetSystem, targetComponent } = resolveWorkflowContext(node.connection, {
          profile: firstDefined(payload.profile, node.profileRef || undefined),
          targetSystem: payload.target_system,
          targetComponent: payload.target_component
        }));
      } catch (err) {
        const e = toMavlinkError(err, 'PROFILE_UNRESOLVED');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-mission',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

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

      // Reject out-of-range targets before locking/sending (#74), matching the
      // param/command paths. Done before acquiring the lock so invalid input
      // never occupies the lock or starts a workflow.
      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
      } catch (err) {
        const e = toMavlinkError(err, 'INVALID_FIELD');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-mission',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

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
        // Carried on every send so the connection encodes with the effective
        // profile's dialect/identity/signing, not its default.
        profile: profile ? profile.id : null,
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
          result = await runTracked(new MissionDownload(opts));
        } else if (action === 'upload') {
          opts.items = validateMissionItems(normalizeUploadItems(payload));
          result = await runTracked(new MissionUpload(opts));
        } else if (action === 'clear') {
          // Best-effort by default (resolve once sent); opt into waiting for a
          // MISSION_ACK with wait_ack, optionally overriding the timeout (#59).
          const waitAck = toBool(firstDefined(msg.wait_ack, payload.wait_ack), false);
          if (waitAck) {
            const clearOpts = Object.assign({}, opts, {
              timeoutMs: toInt(payload.timeout_ms, node.timeoutMs)
            });
            result = await runTracked(new MissionClear(clearOpts));
          } else {
            result = await clearMission(node.connection, opts.profile, targetSystem, targetComponent, missionTypeNum, missionTypeName);
          }
        } else {
          throw Object.assign(new Error(`Unsupported mission action '${action}'.`), { code: 'UNSUPPORTED_ACTION' });
        }

        lock.release();
        if (closed) {
          return done(); // aborted by close: no output from an obsolete node
        }
        node.status({ fill: 'green', shape: 'dot', text: `${action} ok` });
        send([result, null, null]);
        done();
      } catch (err) {
        lock.release();
        if (closed) {
          return done(); // aborted by close: no output from an obsolete node
        }
        const e = toMavlinkError(err, 'MISSION_FAILED');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-mission',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }
    });

    // Abort in-flight mission workflows on close (#83). Their run() promises
    // reject with MISSION_ABORTED, which settles the pending input handlers
    // (releasing the mission lock) through the catch above.
    node.on('close', function closeMission(done) {
      closed = true;
      for (const workflow of activeWorkflows) {
        workflow.abort('mavlink-ai-mission node closed');
      }
      activeWorkflows.clear();
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-mission', MavlinkAiMissionNode);
};

/**
 * Clear a mission: send MISSION_CLEAR_ALL. Best-effort — we resolve once the
 * message is sent rather than blocking on an ack, since some stacks do not ack
 * a clear of an already-empty mission.
 */
async function clearMission(connection, profile, targetSystem, targetComponent, missionTypeNum, missionTypeName) {
  const message = {
    name: 'MISSION_CLEAR_ALL',
    fields: { target_system: targetSystem, target_component: targetComponent, mission_type: missionTypeNum }
  };
  if (profile != null) {
    message.profile = profile;
  }
  await connection.send(message);
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
 * Package rule (#89): a node with a dedicated error output delivers an
 * operational failure exactly once — as a structured message on that output —
 * and finishes with done(), so the same failure does not also fire Catch
 * nodes. Nodes without outputs (e.g. mavlink-ai-out) use done(err) instead.
 *
 * @param {object} node
 * @param {function} send
 * @param {function} done
 * @param {object} payload  error payload (§14.5)
 * @returns {void}
 */
function finishError(node, send, done, payload) {
  send([null, null, { topic: 'mavlink/error', payload }]);
  done();
}
