'use strict';

const { ParamRead, ParamSet, ParamList } = require('../lib/param/param-workflow');
const { toInt, firstDefined } = require('../lib/util/validation');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { resolveWorkflowContext } = require('../lib/util/workflow-profile');

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
    node.connection = RED.nodes.getNode(config.connection);
    // Optional profile override. Kept as the raw config-node id (not resolved
    // here) so a dangling reference fails the workflow loudly instead of
    // silently running under the connection's default profile.
    node.profileRef = config.profile || '';
    node.action = config.action || 'read';
    node.paramId = config.paramId || '';
    node.paramType = config.paramType || 'MAV_PARAM_TYPE_REAL32';
    node.timeoutMs = toInt(config.timeoutMs, 3000);
    node.maxRetries = toInt(config.maxRetries, 3);

    if (!node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
    }

    // Active workflow objects, aborted when the node closes (#83) so a partial
    // deploy doesn't leave subscriptions, response timers, and the param lock
    // running until success/timeout on an obsolete node.
    const activeWorkflows = new Set();
    let closed = false;

    node.on('input', async (msg, send, done) => {
      if (!node.connection) {
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-param',
          code: 'NO_CONNECTION',
          message: 'Param node has no connection configured.'
        }));
      }

      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const action = msg.action || payload.action || node.action;

      // Effective profile for the whole workflow: an explicit override (msg or
      // node config) or the target's routed profile, not blindly the
      // connection's default. It supplies dialect/enums, firmware behavior,
      // target defaults, and rides on every send.
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
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }
      const bundle = profile && profile.getDialect ? profile.getDialect() : null;

      // Reject out-of-range targets before locking/sending (#55).
      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
      } catch (err) {
        const e = toMavlinkError(err, 'INVALID_FIELD');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      // Only one PARAM workflow per connection/profile/target at a time — the
      // param list stream and a concurrent read/set would otherwise interleave.
      const lockKey = `param:${node.connection.id}:${profile ? profile.id : 'default'}:${targetSystem}:${targetComponent}`;
      let lock;
      try {
        lock = node.connection.acquireLock(lockKey, node.id);
      } catch (err) {
        const e = toMavlinkError(err, 'LOCK_HELD');
        node.status({ fill: 'red', shape: 'ring', text: 'busy' });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      const onProgress = (progress) => {
        node.status({ fill: 'blue', shape: 'dot', text: progressText(progress.payload) });
        send([null, progress, null]);
      };

      const opts = {
        connection: node.connection,
        // Carried on every send so the connection encodes with the effective
        // profile's dialect/identity/signing, not its default.
        profile: profile ? profile.id : null,
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
          opts.paramIndex = payload.param_index;
          workflow = new ParamRead(opts);
        } else if (action === 'set') {
          opts.paramId = firstDefined(payload.param_id, node.paramId, '');
          opts.value = firstDefined(payload.param_value, payload.value);
          opts.paramType = firstDefined(payload.param_type, node.paramType);
          workflow = new ParamSet(opts);
        } else if (action === 'list') {
          workflow = new ParamList(opts);
        } else {
          throw Object.assign(new Error(`Unsupported param action '${action}'.`), { code: 'UNSUPPORTED_ACTION' });
        }
      } catch (err) {
        lock.release();
        const e = toMavlinkError(err, 'BAD_PARAM_REQUEST');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      activeWorkflows.add(workflow);
      try {
        const result = await workflow.run();
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
        const e = toMavlinkError(err, 'PARAM_FAILED');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }));
      } finally {
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
function finishError(node, send, done, payload) {
  send([null, null, { topic: 'mavlink/error', payload }]);
  done();
}
