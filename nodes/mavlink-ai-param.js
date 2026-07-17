'use strict';

const { ParamRead, ParamSet, ParamSetAuto, ParamList } = require('../lib/param/param-workflow');
const { toInt, firstDefined } = require('../lib/util/validation');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { resolveWorkflowContext } = require('../lib/util/workflow-profile');
const { watchConfigBadge } = require('../lib/util/node-lifecycle');

/**
 * mavlink-ai-param (planner #8).
 *
 * PARAM protocol workflow node: read one parameter, set one parameter, or
 * request the full parameter list. Stateful and timeout-driven, so — like the
 * mission node — it runs behind a per-connection/profile lock and keeps its
 * protocol logic in lib/param rather than in the transport.
 *
 * Outputs: 1) result  2) progress events  3) errors/timeouts
 */
module.exports = function registerMavlinkAiParam(RED) {
  function MavlinkAiParamNode(config) {
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
    node.action = config.action || 'read';
    node.paramId = config.paramId || '';
    node.paramIndex = config.paramIndex == null ? '' : String(config.paramIndex).trim();
    /** 'auto' detects the wire type from the vehicle before a set (read-before-set). */
    node.paramType = config.paramType || 'auto';
    // Static "Set one" value. Trimmed to '' when unset so a blank field falls
    // through to msg.payload.param_value rather than coercing to 0 (Number('')).
    node.paramValue = config.paramValue == null ? '' : String(config.paramValue).trim();
    node.timeoutMs = toInt(config.timeoutMs, 3000);
    node.maxRetries = toInt(config.maxRetries, 3);

    // Active workflow objects, aborted when the node closes (#83) so a partial
    // deploy doesn't leave subscriptions, response timers, and the param lock
    // running until success/timeout on an obsolete node.
    const activeWorkflows = new Set();
    let closed = false;

    node.on('input', async (msg, send, done) => {
      if (!node.connection) {
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-param',
          code: 'NO_CONNECTION',
          message: 'Param node has no connection configured.'
        }));
      }

      /**
       * The single error exit: red badge, structured §14.5 payload, delivered
       * exactly once via finishError (#89). Every failure below leaves through
       * this one door, so there is one place to change how param errors
       * leave the node instead of copies that can drift apart.
       *
       * @param {*} err  the thrown/failed value
       * @param {string} fallbackCode  code when err carries none
       * @param {string} [badgeText]  status badge override (defaults to the code)
       * @returns {void}
       */
      const fail = (err, fallbackCode, badgeText) => {
        const e = toMavlinkError(err, fallbackCode);
        node.status({ fill: 'red', shape: 'ring', text: badgeText || e.code });
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      };

      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const action = msg.action || payload.action || node.action;

      // Effective profile for the whole workflow: an explicit override (msg or
      // node config) or the target's routed profile, not blindly the
      // connection's default. It supplies dialect/enums, firmware behavior,
      // target defaults, and rides on every send.
      let profile, defaults, targetSystem, targetComponent;
      try {
        ({ profile, defaults, targetSystem, targetComponent } = resolveWorkflowContext(node.connection, {
          profile: firstDefined(payload.vehicleProfile, payload.profile, node.profileRef || undefined),
          targetSystem: payload.target_system,
          targetComponent: payload.target_component
        }));
      } catch (err) {
        return fail(err, 'PROFILE_UNRESOLVED');
      }
      const bundle = profile && profile.getDialect ? profile.getDialect() : null;

      // Reject out-of-range targets before locking/sending (#55).
      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
      } catch (err) {
        return fail(err, 'INVALID_FIELD');
      }

      /**
       * PARAM read/set/list are single-responder handshakes matched on the
       * target sysid; a broadcast (target_system 0) would fan the request
       * across the fleet — a broadcast PARAM_SET writes every vehicle — while
       * every echo is ignored and the workflow times out. Reject it before
       * locking/sending, like the command/payload/fanout nodes (#197).
       */
      if (Number(targetSystem) === 0) {
        node.status({ fill: 'red', shape: 'ring', text: 'BROADCAST_NO_ACK' });
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: 'BROADCAST_NO_ACK',
          message:
            'Broadcast (target_system 0) cannot run a parameter handshake — every echo is ignored and the request times out after the fleet may have applied it. Address a specific system.'
        }));
      }

      // Only one PARAM workflow per connection/profile/target at a time — the
      // param list stream and a concurrent read/set would otherwise interleave.
      const lockKey = `param:${node.connection.id}:${profile ? profile.id : 'default'}:${targetSystem}:${targetComponent}`;
      let lock;
      try {
        lock = node.connection.acquireLock(lockKey, node.id);
      } catch (err) {
        return fail(err, 'LOCK_HELD', 'busy');
      }

      const onProgress = (progress) => {
        node.status({ fill: 'blue', shape: 'dot', text: progressText(progress.payload) });
        send([null, progress, null]);
      };

      // Resolve the Local Identity for this workflow (#228): the explicit
      // payload request when present, else the connection default. Param
      // workflows carry it on every send; an unattached/ambiguous request
      // fails closed here rather than transmitting as the wrong participant.
      let localIdentity;
      try {
        node.connection.resolveOutboundIdentity(payload.localIdentity);
        localIdentity = payload.localIdentity;
      } catch (err) {
        const e = toMavlinkError(err, 'LOCAL_IDENTITY_UNRESOLVED');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        lock.release();
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      const opts = {
        connection: node.connection,
        // Carried on every send so the connection encodes with the effective
        // Vehicle Profile's dialect, not its default.
        vehicleProfile: profile ? profile.id : null,
        // Explicit identity request passes through; blank means the default.
        localIdentity,
        targetSystem,
        targetComponent,
        enums: bundle ? bundle.enums : null,
        // 'px4' switches integer param values to the byte-union convention.
        firmware: defaults.firmware,
        timeoutMs: node.timeoutMs,
        maxRetries: node.maxRetries,
        onProgress
      };

      let workflow;
      try {
        if (action === 'read') {
          opts.paramId = firstDefined(payload.param_id, node.paramId, '');
          /**
           * Param ID takes precedence; the index is only used when no id is
           * given, avoiding a conflicting request that names an id but a
           * vehicle reads by the (>=0) index.
           */
          const index = firstDefined(payload.param_index, indexOrUndefined(node.paramIndex));
          opts.paramIndex = opts.paramId ? undefined : index;
          workflow = new ParamRead(opts);
        } else if (action === 'set') {
          opts.paramId = firstDefined(payload.param_id, node.paramId, '');
          // Editor Value is a fallback for the flow value; an empty field is
          // treated as "unset" (not 0) so a blank editor leaves it to the msg.
          const configValue = node.paramValue === '' ? undefined : node.paramValue;
          opts.value = firstDefined(payload.param_value, payload.value, configValue);
          const requestedType = firstDefined(payload.param_type, node.paramType);
          if (isAutoType(requestedType)) {
            /** Detect the wire type from the vehicle, then set with it. */
            workflow = new ParamSetAuto(opts);
          } else {
            opts.paramType = requestedType;
            workflow = new ParamSet(opts);
          }
        } else if (action === 'list') {
          workflow = new ParamList(opts);
        } else {
          throw Object.assign(new Error(`Unsupported param action '${action}'.`), { code: 'UNSUPPORTED_ACTION' });
        }
      } catch (err) {
        lock.release();
        return fail(err, 'BAD_PARAM_REQUEST');
      }

      activeWorkflows.add(workflow);
      try {
        const result = await workflow.run();
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
        fail(err, 'PARAM_FAILED');
      } finally {
        /**
         * Exactly-once release on every path (#150). The old success/catch pair
         * both released, so a throw after the first release would release twice
         * — and since the owner is the node id, that could free a lock a later
         * same-node message had just re-acquired, running two workflows at once.
         */
        lock.release();
        activeWorkflows.delete(workflow);
      }
    });

    // Abort in-flight PARAM workflows on close (#83). Their run() promises
    // reject with PARAM_ABORTED, which settles the pending input handlers
    // (releasing the param lock) through the catch above.
    node.on('close', function closeParam(done) {
      closed = true;
      for (const active of activeWorkflows) {
        active.abort('mavlink-ai-param node closed');
      }
      activeWorkflows.clear();
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-param', MavlinkAiParamNode);
};

/**
 * True when a param type selection means "detect from the vehicle" rather than
 * a concrete MAV_PARAM_TYPE.
 *
 * @param {*} type
 * @returns {boolean}
 */
function isAutoType(type) {
  return String(type == null ? '' : type).trim().toLowerCase() === 'auto';
}

/**
 * Parse a configured read-by-index value to a non-negative integer, or
 * undefined for a blank/invalid field (so it never overrides a msg index or
 * turns into a spurious index-0 read).
 *
 * @param {*} v
 * @returns {number|undefined}
 */
function indexOrUndefined(v) {
  if (v === undefined || v === null || String(v).trim() === '') {
    return undefined;
  }
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Build a short status-bar label for a progress event.
 *
 * @param {object} p  progress payload
 * @returns {string}
 */
function progressText(p) {
  if (p.count != null) {
    return `list ${p.received || 0}/${p.count}`;
  }
  return p.param_id ? `${p.state} ${p.param_id}` : p.state;
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
function finishError(node, msg, send, done, payload) {
  /**
   * Re-use the inbound msg (Node-RED convention): a fresh object would drop
   * `_msgid` correlation, `msg.parts` (split/join), and user-attached
   * properties on exactly the error branch — the success paths already mutate
   * and forward `msg`, and the command/fanout nodes do the same for errors.
   */
  msg.topic = 'mavlink/error';
  msg.payload = payload;
  send([null, null, msg]);
  done();
}
