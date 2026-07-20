'use strict';

const { ParamRead, ParamSet, ParamSetAuto, ParamList } = require('../lib/param/param-workflow');
const { resolveParamEncoding } = require('../lib/param/param-encoding');
const { boundedSet } = require('../lib/util/bounded-map');
const { toInt, firstDefined } = require('../lib/util/validation');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { MavlinkError } = require('../lib/util/errors');
const { truncateStatus } = require('../lib/util/status');
const { makeFail } = require('../lib/util/node-errors');
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

    /**
     * Wire identities already warned about a capability/label encoding
     * mismatch (#233) — the disagreement holds for every subsequent op, so
     * one warning per vehicle per deploy is signal, repetition is noise.
     * Bounded because the key is wire-derived (#281).
     */
    const encodingMismatchWarned = new Map();

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
        nodeName: 'mavlink-ai-param',
        msg,
        send,
        done,
        outputs: 3,
        errorIndex: 2,
        connectionName: () => node.connection && node.connection.name
      });
      if (!node.connection) {
        return fail(new MavlinkError('NO_CONNECTION', 'Param node has no connection configured.'));
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
          profile: firstDefined(payload.vehicleProfile, node.profileRef || undefined),
          targetSystem: payload.target_system,
          targetComponent: payload.target_component
        }));
      } catch (err) {
        return fail(err, 'PROFILE_UNRESOLVED');
      }
      const bundle = profile.getDialect();

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
        return fail(new MavlinkError('BROADCAST_NO_ACK',
          'Broadcast (target_system 0) cannot run a parameter handshake — every echo is ignored and the request times out after the fleet may have applied it. Address a specific system.'));
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
        node.status({ fill: 'blue', shape: 'dot', text: truncateStatus(progressText(progress.payload)) });
        send([null, progress, null]);
      };

      /**
       * Resolve the Local Identity for this workflow (#228): the explicit
       * payload request when present, else the connection default. Param
       * workflows carry it on every send; an unattached/ambiguous request
       * fails closed here rather than transmitting as the wrong participant.
       * This block used to hand-roll the error delivery and dropped the `msg`
       * argument — the arity shift called done() with a truthy value (firing
       * Catch with garbage) and then crashed calling the payload as a
       * function; the shared exit takes the arguments it actually needs.
       */
      let localIdentity;
      try {
        node.connection.resolveOutboundIdentity(payload.localIdentity);
        localIdentity = payload.localIdentity;
      } catch (err) {
        lock.release();
        return fail(err, 'LOCAL_IDENTITY_UNRESOLVED');
      }

      /**
       * Integer-encoding resolution (#233): ask the vehicle for
       * AUTOPILOT_VERSION once (fire-and-forget — a non-reporting vehicle
       * costs nothing), then resolve lazily at every encode/decode so bits
       * that arrive mid-workflow apply immediately. Probed bits win over the
       * profile firmware label; a disagreement warns once per vehicle,
       * because a mislabeled profile silently corrupts every integer
       * parameter — the exact failure this probe exists to prevent.
       *
       * Deliberate residual window (#294 review, owner decision): a write
       * racing the FIRST probe answer still encodes via the label — #233
       * prescribes that the probe never delays or fails the op, because
       * blocking would tax every integer write to vehicles that never report
       * AUTOPILOT_VERSION. Against a mislabeled profile this narrows the
       * exposure from "every write, forever" to "writes in the first seconds
       * after deploy", and the once-per-vehicle warning surfaces the mislabel
       * the moment bits arrive.
       */
      node.connection.requestVehicleCapabilities({
        targetSystem,
        targetComponent,
        vehicleProfile: profile ? profile.id : null,
        localIdentity
      });
      const paramEncoding = () => {
        const resolved = resolveParamEncoding({
          capabilities: node.connection.getVehicleCapabilities(targetSystem, targetComponent),
          firmware: defaults.firmware,
          enums: bundle.enums,
          dialect: bundle.name
        });
        if (resolved.source === 'capabilities') {
          const labeled = defaults.firmware === 'px4' ? 'bytewise' : 'ccast';
          const vehicleKey = `${targetSystem}:${targetComponent}`;
          if (resolved.encoding !== labeled && !encodingMismatchWarned.has(vehicleKey)) {
            boundedSet(encodingMismatchWarned, vehicleKey, true);
            node.warn(
              `mavlink-ai-param: vehicle ${vehicleKey} advertises ${resolved.encoding} integer-parameter ` +
                `encoding, but the profile firmware label ('${defaults.firmware || 'generic'}') implies ${labeled}. ` +
                'Using the vehicle’s advertised encoding; fix the Vehicle Profile firmware to silence this.'
            );
          }
        }
        return resolved.encoding;
      };

      const opts = {
        connection: node.connection,
        // Carried on every send so the connection encodes with the effective
        // Vehicle Profile's dialect, not its default.
        vehicleProfile: profile ? profile.id : null,
        // Explicit identity request passes through; blank means the default.
        localIdentity,
        targetSystem,
        targetComponent,
        enums: bundle.enums,
        dialect: bundle.name,
        // Label fallback for vehicles that never report capabilities.
        firmware: defaults.firmware,
        paramEncoding,
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

