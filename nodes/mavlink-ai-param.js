'use strict';

const { ParamRead, ParamSet, ParamList } = require('../lib/param/param-workflow');
const { toInt, firstDefined } = require('../lib/util/validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');

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
    node.action = config.action || 'read';
    node.paramId = config.paramId || '';
    node.paramType = config.paramType || 'MAV_PARAM_TYPE_REAL32';
    node.timeoutMs = toInt(config.timeoutMs, 3000);
    node.maxRetries = toInt(config.maxRetries, 3);

    if (!node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
    }

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
      const profile = node.connection.profile;
      const defaults = profile && profile.getDefaults ? profile.getDefaults() : {};
      const bundle = profile && profile.getDialect ? profile.getDialect() : null;

      const targetSystem = firstDefined(payload.target_system, defaults.defaultTargetSystem, 1);
      const targetComponent = firstDefined(payload.target_component, defaults.defaultTargetComponent, 1);

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
        targetSystem,
        targetComponent,
        enums: bundle ? bundle.enums : null,
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

      try {
        const result = await workflow.run();
        lock.release();
        node.status({ fill: 'green', shape: 'dot', text: `${action} ok` });
        send([result, null, null]);
        done();
      } catch (err) {
        lock.release();
        const e = toMavlinkError(err, 'PARAM_FAILED');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-param',
          connection: node.connection.name,
          code: e.code,
          message: e.message,
          context: e.context
        }), err);
      }
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
