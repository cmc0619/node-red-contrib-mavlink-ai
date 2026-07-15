'use strict';

const { buildPayload } = require('../lib/payload/payload');
const { CommandSend } = require('../lib/command/command-workflow');
const { toNum, toBool, firstDefined } = require('../lib/util/validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { watchProfileBadge } = require('../lib/util/node-lifecycle');

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
     * Resolves node.profile and keeps the "invalid profile" badge live across
     * deploys, so a profile fixed after this node was deployed clears the badge.
     */
    watchProfileBadge(RED, node, config);
    node.connection = config.connection ? RED.nodes.getNode(config.connection) : null;
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
        return finishError(node, send, done, errorPayload({
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
       * wins over the profile's autopilot component when set.
       */
      const targetComponent = firstDefined(
        payload.target_component,
        toNum(node.targetComponent, undefined),
        defaults.defaultTargetComponent,
        1
      );

      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
      } catch (err) {
        const e = toMavlinkError(err, 'INVALID_FIELD');
        return finishError(node, send, done, errorPayload({
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
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-payload',
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      /**
       * With a connection the node sends the command directly; without one it
       * hands the built COMMAND_LONG to a downstream mavlink-ai-out node.
       */
      if (node.connection) {
        /**
         * Optional await-ack (#129): confirm the device accepted a command
         * instead of fire-and-forget. Only COMMAND_LONG verbs get a COMMAND_ACK
         * — the gimbal-manager messages don't — so message verbs stay
         * fire-and-forget even when await-ack is on.
         */
        if (node.awaitAck && built.name === 'COMMAND_LONG') {
          return runWithAck(node, msg, send, done, {
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
          await node.connection.send({ name: built.name, profile: node.profile.id, fields: built.fields }, { msg });
          node.status({ fill: 'green', shape: 'dot', text: `sent ${action}` });
          return done();
        } catch (err) {
          const e = toMavlinkError(err, 'SEND_FAILED');
          node.status({ fill: 'red', shape: 'ring', text: e.code });
          return finishError(node, send, done, errorPayload({
            node: 'mavlink-ai-payload',
            connection: node.connection.name,
            code: e.code,
            message: e.message,
            context: e.context
          }));
        }
      }

      msg.topic = 'mavlink/send';
      msg.payload = {
        name: built.name,
        profile: node.profile.id,
        profile_name: node.profile.name,
        fields: built.fields,
        target_system: targetSystem,
        target_component: targetComponent
      };
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
   * Construct the workflow inside the try: `new CommandSend` throws for an
   * unresolvable command (a MAV_CMD_* name the selected/custom dialect doesn't
   * know), and that must surface as a structured `mavlink/error` with a
   * `done()` rather than an unhandled rejection from this async handler.
   */
  let workflow;
  try {
    workflow = new CommandSend({
      connection: node.connection,
      profile: node.profile.id,
      targetSystem: ctx.targetSystem,
      targetComponent: ctx.targetComponent,
      sourceSystem: ctx.defaults.sourceSystemId,
      sourceComponent: ctx.defaults.sourceComponentId,
      command: ctx.built.fields.command,
      fields: ctx.built.fields,
      enums: ctx.enums,
      timeoutMs: toNum(firstDefined(ctx.payload.timeout_ms, node.timeoutMs), undefined),
      maxRetries: toNum(firstDefined(ctx.payload.max_retries, node.maxRetries), undefined)
    });
  } catch (err) {
    const e = toMavlinkError(err, 'COMMAND_FAILED');
    node.status({ fill: 'red', shape: 'ring', text: e.code });
    return finishError(node, send, done, errorPayload({
      node: 'mavlink-ai-payload',
      connection: node.connection.name,
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
    finishError(node, send, done, errorPayload({
      node: 'mavlink-ai-payload',
      connection: node.connection.name,
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
function finishError(node, send, done, payload) {
  send({ topic: 'mavlink/error', payload });
  done();
}
