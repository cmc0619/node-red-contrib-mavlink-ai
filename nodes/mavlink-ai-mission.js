'use strict';

const { MissionDownload } = require('../lib/mission/mission-download');
const { MissionUpload } = require('../lib/mission/mission-upload');
const { MissionClear } = require('../lib/mission/mission-clear');
const { missionTypeToNumber } = require('../lib/mission/mission-state-machine');
const { PRIORITY } = require('../lib/runtime/send-priority');
const { normalizeUploadItems, resolveUploadItems, validateMissionItems } = require('../lib/mission/upload-input');
const { toInt, toBool, firstDefined } = require('../lib/util/validation');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { MavlinkError } = require('../lib/util/errors');
const { makeFail } = require('../lib/util/node-errors');
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
    /**
     * Which MAVLink list this workflow operates on (MAV_MISSION_TYPE):
     * mission/fence/rally/all. Owned by this behavior node, not the Vehicle
     * Profile — a mission is a per-operation choice, and one profile may back
     * several Mission nodes handling different list types. `msg.payload.mission_type`
     * still overrides per message; `all` is clear-only (rejected for upload).
     */
    node.missionType = config.missionType || 'mission';
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
      /**
       * The single error exit: red badge, structured §14.5 payload, delivered
       * exactly once (#89). Every failure, the no-connection guard included,
       * leaves through this one shared door (#285), so a call site can only
       * get the failure itself wrong. The connection label is read lazily:
       * absent for the no-connection guard, named on every later exit.
       */
      const fail = makeFail({
        node,
        nodeName: 'mavlink-ai-mission',
        msg,
        send,
        done,
        outputs: 3,
        errorIndex: 2,
        connectionName: () => node.connection && node.connection.name
      });
      if (!node.connection) {
        return fail(new MavlinkError('NO_CONNECTION', 'Mission node has no connection configured.'));
      }

      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      /** Canonical action selection (#283): msg.action / payload.action /
       * the editor config — the pre-1.0 topic aliases are gone. */
      const action = msg.action || payload.action || node.action;

      // Effective profile for the whole workflow: an explicit override (msg or
      // node config) or the target's routed profile, not blindly the
      // connection's default. It supplies dialect/enums, source identity,
      // mission preferences, target defaults, and rides on every send.
      let profile, defaults, targetSystem, targetComponent;
      try {
        ({ profile, defaults, targetSystem, targetComponent } = resolveWorkflowContext(node.connection, {
          profile: firstDefined(payload.vehicleProfile, node.profileRef || undefined),
          targetSystem: payload.target_system,
          targetComponent: payload.target_component
        }));
      } catch (err) {
        return fail(err, 'PROFILE_UNRESOLVED');
      }

      /**
       * Presence-based, not truthy: a caller may pass the numeric
       * MAV_MISSION_TYPE `0` (= mission) to override a node configured for
       * fence/rally/all, and `||` would drop that valid `0` as "absent". Only
       * undefined/null/'' fall through to the node's Mission Type, then the
       * 'mission' default.
       */
      const payloadType = payload.mission_type;
      const hasPayloadType = payloadType !== undefined && payloadType !== null && payloadType !== '';
      const missionTypeName = hasPayloadType ? payloadType : node.missionType || 'mission';
      const bundle = profile && profile.getDialect ? profile.getDialect() : null;
      let missionTypeNum;
      try {
        missionTypeNum = missionTypeToNumber(missionTypeName, bundle ? bundle.enums : null);
      } catch (err) {
        return fail(err, 'BAD_MISSION_TYPE');
      }
      const useInt = (defaults.preferredMissionItemType || 'MISSION_ITEM_INT') === 'MISSION_ITEM_INT';

      // Reject out-of-range targets before locking/sending (#74), matching the
      // param/command paths. Done before acquiring the lock so invalid input
      // never occupies the lock or starts a workflow.
      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
      } catch (err) {
        return fail(err, 'INVALID_FIELD');
      }

      /**
       * A mission transfer is a single-responder handshake: the state machine
       * filters responses by the target sysid and no real responder sources
       * from sysid 0. A broadcast (target_system 0) can execute on every
       * reachable vehicle — a broadcast clear is especially destructive — while
       * every reply is ignored and the workflow times out, telling the operator
       * it failed after the fleet already acted. Reject it before locking/
       * sending, like the command/payload/fanout nodes (#197).
       */
      if (Number(targetSystem) === 0) {
        return fail(new MavlinkError('BROADCAST_NO_ACK',
          'Broadcast (target_system 0) cannot run a mission handshake — every reply is ignored and the transfer times out after the fleet may have acted. Address a specific system.'));
      }

      /**
       * Prepare upload items BEFORE the lock (#236). A missing or non-array
       * items payload must fail loudly rather than be uploaded as
       * MISSION_COUNT 0 — which the mission spec treats as a clear, silently
       * erasing the vehicle's mission on a wiring typo. An explicit empty upload
       * clears only with an allow_empty confirmation (the separate `clear` action
       * is the normal path). Every item field is validated against its wire type
       * here too, so malformed input never occupies the lock or ships defaulted
       * zeros.
       */
      let uploadItems;
      if (action === 'upload') {
        try {
          /**
           * Confirming an empty (destructive) upload requires an explicit
           * boolean or true-string. A wrong-shaped upstream value ({}/[]) would
           * otherwise be truthy through toBool's Boolean() fallback and silently
           * reopen the empty-clear path this guard closes (Codex review).
           */
          const rawAllowEmpty = firstDefined(msg.allow_empty, payload.allow_empty);
          const allowEmpty =
            typeof rawAllowEmpty === 'boolean' || typeof rawAllowEmpty === 'string' ? toBool(rawAllowEmpty, false) : false;
          resolveUploadItems(payload, { allowEmpty });
          uploadItems = validateMissionItems(normalizeUploadItems(payload), bundle ? bundle.enums : null);
        } catch (err) {
          return fail(err, 'INVALID_FIELD');
        }
      }

      const lockKey = `mission:${node.connection.id}:${profile ? profile.id : 'default'}:${missionTypeNum}`;
      let lock;
      try {
        lock = node.connection.acquireLock(lockKey, node.id);
      } catch (err) {
        return fail(err, 'LOCK_HELD', 'busy');
      }

      const onProgress = (progress) => {
        node.status({ fill: 'blue', shape: 'dot', text: progress.payload.state });
        send([null, progress, null]);
      };

      /**
       * The Local Identity this workflow transmits as (#228): the explicit
       * payload request when present, else the connection default. Its source
       * ids also gate inbound protocol-message addressing checks below. This
       * block used to hand-roll the error delivery and dropped the `msg`
       * argument — the arity shift called done() with a truthy value (firing
       * Catch with garbage) and then crashed calling the payload as a
       * function; the shared exit takes the arguments it actually needs.
       */
      let identity;
      try {
        identity = node.connection.resolveOutboundIdentity(payload.localIdentity);
      } catch (err) {
        lock.release();
        return fail(err, 'LOCAL_IDENTITY_UNRESOLVED');
      }
      const source = identity.getIdentity();

      const opts = {
        connection: node.connection,
        // Carried on every send so the connection encodes with the effective
        // Vehicle Profile's dialect, not its default.
        vehicleProfile: profile ? profile.id : null,
        // Carried on every send only when the caller explicitly requested an
        // identity; otherwise the connection default applies.
        localIdentity: payload.localIdentity,
        targetSystem,
        targetComponent,
        // Our own identity, so responses addressed to another GCS on the same
        // vehicle don't advance this workflow.
        sourceSystem: source.sysid,
        sourceComponent: source.compid,
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
          opts.items = uploadItems;
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
            result = await clearMission(node.connection, opts, targetSystem, targetComponent, missionTypeNum, missionTypeName);
          }
        } else {
          throw Object.assign(new Error(`Unsupported mission action '${action}'.`), { code: 'UNSUPPORTED_ACTION' });
        }

        if (closed) {
          /** Aborted by close: no output from an obsolete node. */
          return done();
        }
        node.status({ fill: 'green', shape: 'dot', text: `${action} ok` });
        send([result, null, null]);
        done();
      } catch (err) {
        if (closed) {
          /** Aborted by close: no output from an obsolete node. */
          return done();
        }
        fail(err, 'MISSION_FAILED');
      } finally {
        /**
         * Exactly-once release on every path (#150). Releasing in both the
         * success and catch branches risked a double free: if anything after
         * the first release threw, the catch released again — and because the
         * lock owner is the node id, that second release could free a lock a
         * later message on the same node had just re-acquired, letting two
         * workflows run concurrently. `finally` releases once, whatever happens.
         */
        lock.release();
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
async function clearMission(connection, opts, targetSystem, targetComponent, missionTypeNum, missionTypeName) {
  const message = {
    name: 'MISSION_CLEAR_ALL',
    fields: { target_system: targetSystem, target_component: targetComponent, mission_type: missionTypeNum }
  };
  if (opts.vehicleProfile != null) {
    message.vehicleProfile = opts.vehicleProfile;
  }
  if (opts.localIdentity != null && opts.localIdentity !== '') {
    message.localIdentity = opts.localIdentity;
  }
  await connection.send(message, { priority: PRIORITY.NORMAL });
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

