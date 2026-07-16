'use strict';

const { buildPayload } = require('../lib/payload/payload');
const { DEFAULT_TARGET_COMPONENT } = require('../lib/payload/components');
const { CommandSend } = require('../lib/command/command-workflow');
const { toNum, toBool, firstDefined } = require('../lib/util/validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { watchConfigBadge } = require('../lib/util/node-lifecycle');
const { commandPriorityFor } = require('../lib/runtime/send-priority');

/**
 * mavlink-ai-payload.
 *
 * Friendly payload / peripheral control: camera, gimbal, servo, relay and
 * gripper verbs built into a `COMMAND_LONG` without the build node. The verbs
 * are vehicle-agnostic — servos, relays and grippers serve rovers, boats and
 * submarines (lights, manipulators, sample release) as much as cameras and
 * gimbals serve copters and survey planes.
 *
 * Payload devices are frequently separate MAVLink components (a camera at
 * `MAV_COMP_ID_CAMERA`, a gimbal, ...), so the target component is first-class
 * here rather than an afterthought.
 *
 * Like the command node, a Connection is optional: with one the node sends the
 * command directly; without one it emits a `mavlink/send` message for a
 * mavlink-ai-out node.
 */
module.exports = function registerMavlinkAiPayload(RED) {
  function MavlinkAiPayloadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    /**
     * Resolves node.profile AND node.connection, and keeps both live across
     * deploys (#238): Node-RED leaves this node in place when only a referenced
     * config node changed, so a Connection re-created on a later deploy would
     * otherwise leave the direct-send/await-ack path pointing at the destroyed
     * old object (the in/out/swarm nodes re-resolve the same way, #164). The
     * connection is optional — without one the node emits mavlink/send — so the
     * "missing connection" badge only shows when await-ack actually needs it.
     */
    watchConfigBadge(RED, node, config, {
      profile: 'required',
      connection: 'optional',
      connectionRequiredWhen: () => toBool(config.awaitAck, false)
    });
    node.action = config.action || 'camera_photo';
    node.targetComponent = config.targetComponent;
    node.interval = config.interval;
    node.count = config.count;
    node.sequence = config.sequence;
    node.streamId = config.streamId;
    node.statusFrequency = config.statusFrequency;
    node.pitch = config.pitch;
    node.roll = config.roll;
    node.yaw = config.yaw;
    node.instance = config.instance;
    node.pwm = config.pwm;
    node.relayOn = config.on;
    node.gripAction = config.gripAction;
    node.gimbalDeviceId = config.gimbalDeviceId;
    node.yawLock = config.yawLock;
    node.cameraMode = config.cameraMode;
    node.distance = config.distance;
    node.triggerNow = config.triggerNow;
    node.zoomType = config.zoomType;
    node.zoomValue = config.zoomValue;
    node.focusType = config.focusType;
    node.focusValue = config.focusValue;
    node.winchAction = config.winchAction;
    node.length = config.length;
    node.rate = config.rate;
    node.parachuteAction = config.parachuteAction;
    node.period = config.period;
    /** Optional COMMAND_ACK wait for the command-type verbs (#129). */
    node.awaitAck = toBool(config.awaitAck, false);
    node.timeoutMs = config.timeoutMs;
    node.maxRetries = config.maxRetries;
    /** In-flight await-ack workflows, aborted on close so a redeploy can't leak them. */
    node._active = new Set();
    /** Set once the node is closing, so an aborted await-ack emits no obsolete output. */
    node._closed = false;

    node.on('input', async (msg, send, done) => {
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      if (!node.profile || !node.profile.isValid || !node.profile.isValid()) {
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-payload',
          code: 'MISSING_PROFILE',
          message: 'Payload node has no valid profile/dialect.'
        }));
      }

      const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
      const defaults = node.profile.getDefaults ? node.profile.getDefaults() : {};
      const action = firstDefined(payload.action, node.action);
      const targetSystem = firstDefined(payload.target_system, defaults.defaultTargetSystem, 1);
      /**
       * Payload devices are often a distinct component; the node's own default
       * wins over the profile's autopilot component when set. The final fallback
       * is the autopilot component (MAV_COMP_ID_AUTOPILOT1) — a deliberate
       * default, not an accident: ArduPilot's onboard camera/gimbal drivers
       * answer there. A standalone MAVLink camera (component 100) or gimbal (154)
       * must be addressed explicitly via this field or msg.target_component; the
       * editor surfaces those ids with a verb-aware hint (#155).
       */
      const targetComponent = firstDefined(
        payload.target_component,
        toNum(node.targetComponent, undefined),
        defaults.defaultTargetComponent,
        DEFAULT_TARGET_COMPONENT
      );

      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
      } catch (err) {
        const e = toMavlinkError(err, 'INVALID_FIELD');
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-payload',
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      let built;
      try {
        built = buildPayload(action, {
          enums: bundle ? bundle.enums : null,
          targetSystem,
          targetComponent,
          interval: toNum(firstDefined(payload.interval, node.interval), undefined),
          count: toNum(firstDefined(payload.count, node.count), undefined),
          sequence: toNum(firstDefined(payload.sequence, node.sequence), undefined),
          streamId: toNum(firstDefined(payload.stream_id, node.streamId), undefined),
          statusFrequency: toNum(firstDefined(payload.status_frequency, node.statusFrequency), undefined),
          pitch: toNum(firstDefined(payload.pitch, node.pitch), undefined),
          roll: toNum(firstDefined(payload.roll, node.roll), undefined),
          yaw: toNum(firstDefined(payload.yaw, node.yaw), undefined),
          instance: toNum(firstDefined(payload.instance, node.instance), undefined),
          pwm: toNum(firstDefined(payload.pwm, node.pwm), undefined),
          on: toBool(firstDefined(payload.on, node.relayOn), false),
          action: firstDefined(payload.grip_action, node.gripAction),
          gimbalDeviceId: toNum(firstDefined(payload.gimbal_device_id, node.gimbalDeviceId), undefined),
          yawLock: toBool(firstDefined(payload.yaw_lock, node.yawLock), false),
          cameraMode: firstDefined(payload.camera_mode, node.cameraMode),
          distance: toNum(firstDefined(payload.distance, node.distance), undefined),
          triggerNow: toBool(firstDefined(payload.trigger_now, node.triggerNow), false),
          zoomType: firstDefined(payload.zoom_type, node.zoomType),
          zoomValue: toNum(firstDefined(payload.zoom_value, node.zoomValue), undefined),
          focusType: firstDefined(payload.focus_type, node.focusType),
          focusValue: toNum(firstDefined(payload.focus_value, node.focusValue), undefined),
          winchAction: firstDefined(payload.winch_action, node.winchAction),
          length: toNum(firstDefined(payload.length, node.length), undefined),
          rate: toNum(firstDefined(payload.rate, node.rate), undefined),
          parachuteAction: firstDefined(payload.parachute_action, node.parachuteAction),
          period: toNum(firstDefined(payload.period, node.period), undefined)
        });
      } catch (err) {
        const e = toMavlinkError(err, 'BAD_PAYLOAD');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-payload',
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      /**
       * Await-ack needs a Connection to receive the COMMAND_ACK. Without one the
       * request would silently fall through to the fire-and-forget `mavlink/send`
       * path below, giving the operator no ack and no error — so reject loudly
       * instead (only for the COMMAND_LONG verbs that can be acked).
       */
      if (node.awaitAck && built.name === 'COMMAND_LONG' && !node.connection) {
        node.status({ fill: 'red', shape: 'ring', text: 'NO_CONNECTION' });
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-payload',
          code: 'NO_CONNECTION',
          message: 'Await-ack requires a Connection to receive the COMMAND_ACK.'
        }));
      }

      /**
       * Await-ack can't work on a broadcast (target_system 0): CommandSend
       * matches the ACK on the target sysid, but responders reply from their own
       * nonzero sysid, so the ack is never observed and the workflow just retries
       * to a timeout. Reject loudly — mirroring the fan-out node — rather than
       * report a false failure. (Broadcast is fine for fire-and-forget verbs.)
       */
      if (node.awaitAck && built.name === 'COMMAND_LONG' && Number(targetSystem) === 0) {
        node.status({ fill: 'red', shape: 'ring', text: 'BROADCAST_NO_ACK' });
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-payload',
          code: 'BROADCAST_NO_ACK',
          message: 'Broadcast (target_system 0) cannot collect a COMMAND_ACK — address a specific system, or disable await-ack.'
        }));
      }

      /**
       * With a connection the node sends the command directly; without one it
       * hands the built COMMAND_LONG to a downstream mavlink-ai-out node. The
       * connection is captured before any await: the live flows:started refresh
       * (#238) can null or replace node.connection while a send/ack workflow is
       * pending, and the catch paths must name the connection actually used —
       * not TypeError on a stale null and leave done() uncalled.
       */
      const connection = node.connection;
      if (connection) {
        /**
         * Optional await-ack (#129): confirm the device accepted a command
         * instead of fire-and-forget. Only COMMAND_LONG verbs get a COMMAND_ACK
         * — the gimbal-manager messages don't — so message verbs stay
         * fire-and-forget even when await-ack is on.
         */
        if (node.awaitAck && built.name === 'COMMAND_LONG') {
          return runWithAck(node, msg, send, done, {
            connection,
            built,
            action,
            targetSystem,
            targetComponent,
            enums: bundle ? bundle.enums : null,
            defaults,
            payload
          });
        }
        try {
          /** Band from the shared policy (#241): the parachute verb resolves
           * to a CRITICAL MAV_CMD; camera/gimbal/servo verbs ride NORMAL. */
          await connection.send(
            {
              name: built.name,
              vehicleProfile: node.profile.id,
              localIdentity: payload.localIdentity,
              fields: built.fields
            },
            { msg, priority: commandPriorityFor(bundle ? bundle.enums : null, built.fields.command) }
          );
          node.status({ fill: 'green', shape: 'dot', text: `sent ${action}` });
          return done();
        } catch (err) {
          const e = toMavlinkError(err, 'SEND_FAILED');
          node.status({ fill: 'red', shape: 'ring', text: e.code });
          return finishError(node, msg, send, done, errorPayload({
            node: 'mavlink-ai-payload',
            connection: connection.name,
            code: e.code,
            message: e.message,
            context: e.context
          }));
        }
      }

      msg.topic = 'mavlink/send';
      msg.payload = {
        name: built.name,
        vehicleProfile: node.profile.id,
        vehicleProfileName: node.profile.name,
        fields: built.fields,
        target_system: targetSystem,
        target_component: targetComponent
      };
      if (payload.localIdentity !== undefined && payload.localIdentity !== null && payload.localIdentity !== '') {
        msg.payload.localIdentity = payload.localIdentity;
      }
      node.status({ fill: 'green', shape: 'dot', text: action });
      send(msg);
      done();
    });

    /**
     * Abort any in-flight await-ack workflows on redeploy/close so their
     * subscriptions and timers don't leak past the node's lifetime. `_closed`
     * gates their catch/resolve so the abort rejection can't emit an obsolete
     * COMMAND_ABORTED error after this handler has returned. abort() is
     * settle-once and never throws, so no per-workflow guard is needed.
     */
    node.on('close', function closePayload(cb) {
      node._closed = true;
      for (const workflow of node._active) {
        workflow.abort('mavlink-ai-payload node closed');
      }
      node._active.clear();
      cb();
    });
  }

  RED.nodes.registerType('mavlink-ai-payload', MavlinkAiPayloadNode);
};

/**
 * Send a COMMAND_LONG payload verb and wait for its COMMAND_ACK, reusing the
 * command node's CommandSend workflow (#129). Resolves the ack onto the output,
 * or emits a structured error on rejection/timeout.
 *
 * @param {object} node
 * @param {object} msg
 * @param {function} send
 * @param {function} done
 * @param {object} ctx  { built, action, targetSystem, targetComponent, enums, defaults, payload }
 * @returns {Promise<void>}
 */
async function runWithAck(node, msg, send, done, ctx) {
  /**
   * The connection captured by the input handler before any await (#238): the
   * live flows:started refresh can null/replace node.connection while this
   * workflow is pending, and every use below must be the object the command
   * was actually sent on.
   */
  const connection = ctx.connection;
  /**
   * Construct the workflow inside the try: `new CommandSend` throws for an
   * unresolvable command (a MAV_CMD_* name the selected/custom dialect doesn't
   * know), and that must surface as a structured `mavlink/error` with a
   * `done()` rather than an unhandled rejection from this async handler.
   */
  let workflow;
  try {
    // The Local Identity this workflow transmits as (#228): the explicit
    // payload request when present (validated as attached/permitted by the
    // connection), else the connection default. Its source ids gate ACK
    // matching (#99).
    const identity = connection.resolveOutboundIdentity(ctx.payload.localIdentity);
    const source = identity.getIdentity();
    workflow = new CommandSend({
      connection,
      vehicleProfile: node.profile.id,
      localIdentity: ctx.payload.localIdentity,
      targetSystem: ctx.targetSystem,
      targetComponent: ctx.targetComponent,
      sourceSystem: source.sysid,
      sourceComponent: source.compid,
      command: ctx.built.fields.command,
      fields: ctx.built.fields,
      enums: ctx.enums,
      timeoutMs: toNum(firstDefined(ctx.payload.timeout_ms, node.timeoutMs), undefined),
      maxRetries: toNum(firstDefined(ctx.payload.max_retries, node.maxRetries), undefined)
    });
  } catch (err) {
    const e = toMavlinkError(err, 'COMMAND_FAILED');
    node.status({ fill: 'red', shape: 'ring', text: e.code });
    return finishError(node, msg, send, done, errorPayload({
      node: 'mavlink-ai-payload',
      connection: connection.name,
      code: e.code,
      message: e.message,
      context: e.context
    }));
  }

  node._active.add(workflow);
  try {
    const result = await workflow.run();
    /** Node closed mid-flight: the abort rejection/late resolve is obsolete. */
    if (node._closed) {
      return done();
    }
    node.status({ fill: 'green', shape: 'dot', text: `ack ${ctx.action}` });
    msg.topic = result.topic;
    msg.payload = result.payload;
    send(msg);
    done();
  } catch (err) {
    if (node._closed) {
      return done();
    }
    const e = toMavlinkError(err, 'COMMAND_FAILED');
    node.status({ fill: 'red', shape: 'ring', text: e.code });
    finishError(node, msg, send, done, errorPayload({
      node: 'mavlink-ai-payload',
      connection: connection.name,
      code: e.code,
      message: e.message,
      context: e.context
    }));
  } finally {
    node._active.delete(workflow);
  }
}

/**
 * Emit a structured error on the single output and finish. Like the build node,
 * operational failures ride the output as a `mavlink/error` message.
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
  send(msg);
  done();
}
