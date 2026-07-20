'use strict';

const { buildPayload } = require('../lib/payload/payload');
const { DEFAULT_TARGET_COMPONENT } = require('../lib/payload/components');
const { CommandSend } = require('../lib/command/command-workflow');
const { toNum, toBool, firstDefined } = require('../lib/util/validation');
const { MavlinkError } = require('../lib/util/errors');
const { makeFail } = require('../lib/util/node-errors');
const { truncateStatus } = require('../lib/util/status');
const { DELIVERY, resolveDeliveryMode } = require('../lib/util/delivery');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { watchConfigBadge } = require('../lib/util/node-lifecycle');
const { PRIORITY, commandPriorityFor } = require('../lib/runtime/send-priority');

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
 * Like the command node, delivery is explicit (#207): "Build only" hands the
 * built message to a downstream mavlink-ai-out node; "Send via connection"
 * sends it directly and fire-and-forgets; "Send & await result" sends it and
 * waits for the COMMAND_ACK (COMMAND_LONG verbs only — a gimbal-manager
 * message carries no ack, so Await degrades to Send semantics for it). Every
 * mode emits on port 0 (product) with errors on port 1.
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
     * connection is only needed for Send/Await delivery (#207) — Build only
     * hands mavlink/send to a downstream Out node — so the "missing connection"
     * badge only shows when the selected delivery mode actually needs one.
     */
    watchConfigBadge(RED, node, config, {
      profile: 'required',
      connection: 'optional',
      connectionRequiredWhen: () => config.delivery === DELIVERY.SEND || config.delivery === DELIVERY.AWAIT
    });

    /**
     * A missing/invalid Delivery selection (#207, #308) is a construct-time
     * config error too, not just an input-time one: a pre-upgrade node (or one
     * created via import/API without a `delivery` value) must show a red badge
     * at deploy time instead of looking healthy until the first message. This
     * node has no other construct-time config-error source (unlike command's/
     * fanout's static `fields` JSON), so `node._configError` is introduced here
     * for delivery alone — the input handler still fails closed on every
     * message via its own `resolveDeliveryMode` call regardless of this flag,
     * so this only adds deploy-time feedback. "invalid profile" is the more
     * fundamental problem and watchConfigBadge already painted that badge
     * above, so this only paints over it when the profile itself resolved
     * fine; watchConfigBadge's own `flows:started` refresh also checks
     * `node._configError` (#308 G1), so the badge is re-asserted — not
     * cleared — on every later redeploy too, for as long as delivery stays
     * unset.
     */
    let deliveryConfigError = null;
    try {
      resolveDeliveryMode(config, { allow: [DELIVERY.BUILD, DELIVERY.SEND, DELIVERY.AWAIT] });
    } catch (err) {
      if (err.code !== 'DELIVERY_UNSET') {
        throw err;
      }
      deliveryConfigError = err.message;
    }
    node._configError = deliveryConfigError;
    const profileOk = !!(node.profile && typeof node.profile.isValid === 'function' && node.profile.isValid());
    if (node._configError && profileOk) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    }

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
    node.timeoutMs = config.timeoutMs;
    node.maxRetries = config.maxRetries;
    /** In-flight await-ack workflows, aborted on close so a redeploy can't leak them. */
    node._active = new Set();
    /** Set once the node is closing, so an aborted await-ack emits no obsolete output. */
    node._closed = false;

    node.on('input', async (msg, send, done) => {
      /**
       * The single error exit (#285): one closure binds node/msg/send/done —
       * call sites (including runWithAck, via ctx.fail) pass only the
       * failure, so the positional threading that produced the #276 arity
       * shift cannot recur. The connection label is read lazily at failure
       * time.
       */
      /**
       * A send/ack failure must name the connection it actually used, even if
       * a live redeploy replaced node.connection mid-flight (#128/#238) — the
       * send and await-ack paths record their captured connection here before
       * awaiting.
       */
      let sentOn = null;
      const fail = makeFail({
        node,
        nodeName: 'mavlink-ai-payload',
        msg,
        send,
        done,
        outputs: 2,
        errorIndex: 1,
        connectionName: () => {
          const c = sentOn || node.connection;
          return c && c.name;
        }
      });
      /**
       * Delivery is explicit (#207): a node saved before this change (or
       * imported/API-created without a delivery value) fails closed instead
       * of silently picking a behavior.
       */
      let mode;
      try {
        mode = resolveDeliveryMode(config, { allow: [DELIVERY.BUILD, DELIVERY.SEND, DELIVERY.AWAIT] });
      } catch (err) {
        return fail(err);
      }
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      if (!node.profile || !node.profile.isValid || !node.profile.isValid()) {
        return fail(new MavlinkError('MISSING_PROFILE', 'Payload node has no valid profile/dialect.'));
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
        return fail(err, 'INVALID_FIELD');
      }

      let built;
      try {
        built = buildPayload(action, {
          enums: bundle ? bundle.enums : null,
          dialect: bundle ? bundle.name : 'unknown',
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
        return fail(err, 'BAD_PAYLOAD');
      }

      /**
       * Send and Await both need a Connection to send on; Build only hands the
       * built message to a downstream mavlink-ai-out node instead (#207).
       */
      if ((mode === DELIVERY.SEND || mode === DELIVERY.AWAIT) && !node.connection) {
        return fail(new MavlinkError('NO_CONNECTION',
          mode === DELIVERY.AWAIT
            ? 'Send & await result requires a Connection to send on (and, for COMMAND_LONG verbs, to receive the COMMAND_ACK).'
            : 'Send via connection requires a Connection to send on.'));
      }

      /**
       * Await can't confirm a broadcast (target_system 0): CommandSend matches
       * the ACK on the target sysid, but responders reply from their own
       * nonzero sysid, so the ack is never observed and the workflow just
       * retries to a timeout. Reject loudly — mirroring the fan-out node —
       * rather than report a false failure. Only the COMMAND_LONG await path
       * runs this protocol; a message verb degrades to a plain send, which is
       * fine on a broadcast.
       */
      if (mode === DELIVERY.AWAIT && built.name === 'COMMAND_LONG' && Number(targetSystem) === 0) {
        return fail(new MavlinkError('BROADCAST_NO_ACK', 'Broadcast (target_system 0) cannot collect a COMMAND_ACK — address a specific system, or switch delivery to Send or Build only.'));
      }

      /**
       * The connection is captured before any await: the live flows:started
       * refresh (#238) can null or replace node.connection while a send/ack
       * workflow is pending, and the catch paths must name the connection
       * actually used — not TypeError on a stale null and leave done() uncalled.
       */
      const connection = node.connection;
      sentOn = connection;
      /**
       * Send & await result (#129, #207): confirm the device accepted a
       * command instead of fire-and-forget. Only COMMAND_LONG verbs get a
       * COMMAND_ACK — the gimbal-manager messages don't — so a message verb
       * DEGRADES to send semantics even under Await: hanging for an ack that
       * will never come would just burn the timeout for nothing.
       */
      if (mode === DELIVERY.AWAIT && built.name === 'COMMAND_LONG') {
        return runWithAck(node, msg, send, done, {
          fail,
          connection,
          built,
          action,
          targetSystem,
          targetComponent,
          enums: bundle ? bundle.enums : null,
          dialect: bundle ? bundle.name : 'unknown',
          defaults,
          payload
        });
      }

      if (mode === DELIVERY.SEND || mode === DELIVERY.AWAIT) {
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
        } catch (err) {
          /**
           * Close/redeploy during the await above (#308 R3): mirrors the
           * success-path close guard below, so a slow or queued in-flight
           * send that REJECTS after this node closed can't emit a
           * `SEND_FAILED` mavlink/error from an obsolete node.
           */
          if (node._closed) {
            return done();
          }
          return fail(err, 'SEND_FAILED');
        }
        /**
         * Close/redeploy during the await above (#308 G2): mirrors
         * runWithAck's own `node._closed` guard, so a slow or queued
         * in-flight send that resolves after this node closed can't drive
         * downstream logic with a `payload/sent` from an obsolete node.
         */
        if (node._closed) {
          return done();
        }
        node.status({ fill: 'green', shape: 'dot', text: truncateStatus(`sent ${action}`) });
        msg.topic = 'payload/sent';
        msg.payload = { name: built.name, target_system: targetSystem, target_component: targetComponent, sent: true };
        send([msg, null]);
        return done();
      }

      // --- build-only mode (default): hand off to mavlink-ai-out -------------
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
      /**
       * Stamp the CRITICAL band on the build-only output when the verb resolves
       * to a critical MAV_CMD (parachute), mirroring the command node (#241) —
       * Payload -> mavlink-ai-out must keep the same band as a direct send.
       * Non-critical verbs carry no stamp so flows keep control of the field.
       */
      {
        const priority = commandPriorityFor(bundle ? bundle.enums : null, built.fields.command);
        if (priority === PRIORITY.CRITICAL) {
          msg.priority = priority;
        }
      }
      node.status({ fill: 'green', shape: 'dot', text: truncateStatus(action) });
      send([msg, null]);
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
 * @param {object} ctx  { fail, connection, built, action, targetSystem, targetComponent, enums, defaults, payload } —
 *   `fail` is the input handler's #285 error exit, so ack failures deliver
 *   through the same single door
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
      dialect: ctx.dialect,
      timeoutMs: toNum(firstDefined(ctx.payload.timeout_ms, node.timeoutMs), undefined),
      maxRetries: toNum(firstDefined(ctx.payload.max_retries, node.maxRetries), undefined)
    });
  } catch (err) {
    return ctx.fail(err, 'COMMAND_FAILED');
  }

  node._active.add(workflow);
  try {
    const result = await workflow.run();
    /** Node closed mid-flight: the abort rejection/late resolve is obsolete. */
    if (node._closed) {
      return done();
    }
    node.status({ fill: 'green', shape: 'dot', text: truncateStatus(`ack ${ctx.action}`) });
    msg.topic = result.topic;
    msg.payload = result.payload;
    send([msg, null]);
    done();
  } catch (err) {
    if (node._closed) {
      return done();
    }
    ctx.fail(err, 'COMMAND_FAILED');
  } finally {
    node._active.delete(workflow);
  }
}

