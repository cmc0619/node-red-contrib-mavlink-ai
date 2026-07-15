'use strict';

const { buildSetpoint } = require('../lib/move/setpoint');
const { toNum, firstDefined } = require('../lib/util/validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { watchProfileBadge } = require('../lib/util/node-lifecycle');

/**
 * mavlink-ai-move.
 *
 * Friendly offboard/guided control node: emits (or sends) a
 * `SET_POSITION_TARGET_LOCAL_NED` / `SET_POSITION_TARGET_GLOBAL_INT` setpoint
 * without the build node, hiding the inverted `type_mask` behind named presets
 * and the NED down-positive axis behind up-positive altitude/climb inputs.
 *
 * Like the command node, sending is optional: with a Connection the node sends
 * the setpoint directly (fire-and-forget — setpoints carry no ack); without
 * one it emits a `mavlink/send` message to wire into a mavlink-ai-out node.
 */
module.exports = function registerMavlinkAiMove(RED) {
  function MavlinkAiMoveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    /**
     * Resolves node.profile and keeps the "invalid profile" badge live across
     * deploys, so a profile fixed after this node was deployed clears the badge.
     */
    watchProfileBadge(RED, node, config);
    node.connection = config.connection ? RED.nodes.getNode(config.connection) : null;
    node.coordinate = config.coordinate || 'local';
    node.preset = config.preset || 'position';
    node.frame = config.frame || defaultFrame(node.coordinate);
    node.typeMask = config.typeMask;
    node.north = config.north;
    node.east = config.east;
    node.altitude = config.altitude;
    node.lat = config.lat;
    node.lon = config.lon;
    node.velNorth = config.velNorth;
    node.velEast = config.velEast;
    node.climb = config.climb;
    node.accelNorth = config.accelNorth;
    node.accelEast = config.accelEast;
    node.accelUp = config.accelUp;
    node.yaw = config.yaw;
    node.yawRate = config.yawRate;

    node.on('input', async (msg, send, done) => {
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      if (!node.profile || !node.profile.isValid || !node.profile.isValid()) {
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-move',
          code: 'MISSING_PROFILE',
          message: 'Move node has no valid profile/dialect.'
        }));
      }

      const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
      const defaults = node.profile.getDefaults ? node.profile.getDefaults() : {};
      const targetSystem = firstDefined(payload.target_system, defaults.defaultTargetSystem, 1);
      const targetComponent = firstDefined(payload.target_component, defaults.defaultTargetComponent, 1);

      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
      } catch (err) {
        const e = toMavlinkError(err, 'INVALID_FIELD');
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-move',
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      let built;
      try {
        built = buildSetpoint({
          coordinate: firstDefined(payload.coordinate, node.coordinate),
          preset: firstDefined(payload.preset, node.preset),
          typeMask: firstDefined(payload.type_mask, node.typeMask),
          frame: firstDefined(payload.frame, node.frame),
          enums: bundle ? bundle.enums : null,
          north: toNum(firstDefined(payload.north, node.north), undefined),
          east: toNum(firstDefined(payload.east, node.east), undefined),
          altitude: toNum(firstDefined(payload.altitude, node.altitude), undefined),
          lat: toNum(firstDefined(payload.lat, node.lat), undefined),
          lon: toNum(firstDefined(payload.lon, node.lon), undefined),
          velNorth: toNum(firstDefined(payload.velNorth, node.velNorth), undefined),
          velEast: toNum(firstDefined(payload.velEast, node.velEast), undefined),
          climb: toNum(firstDefined(payload.climb, node.climb), undefined),
          accelNorth: toNum(firstDefined(payload.accelNorth, node.accelNorth), undefined),
          accelEast: toNum(firstDefined(payload.accelEast, node.accelEast), undefined),
          accelUp: toNum(firstDefined(payload.accelUp, node.accelUp), undefined),
          yaw: toNum(firstDefined(payload.yaw, node.yaw), undefined),
          yawRate: toNum(firstDefined(payload.yawRate, node.yawRate), undefined),
          timeBootMs: toNum(firstDefined(payload.time_boot_ms, 0), 0),
          targetSystem,
          targetComponent
        });
      } catch (err) {
        const e = toMavlinkError(err, 'BAD_SETPOINT');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        return finishError(node, send, done, errorPayload({
          node: 'mavlink-ai-move',
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      /**
       * With a connection the node is the sender (setpoints are fire-and-forget,
       * so there is no ack to await); without one it hands the built message to
       * a downstream mavlink-ai-out node.
       */
      if (node.connection) {
        try {
          await node.connection.send({ name: built.name, profile: node.profile.id, fields: built.fields }, { msg });
          node.status({ fill: 'green', shape: 'dot', text: `sent ${labelFor(built.name)}` });
          return done();
        } catch (err) {
          const e = toMavlinkError(err, 'SEND_FAILED');
          node.status({ fill: 'red', shape: 'ring', text: e.code });
          return finishError(node, send, done, errorPayload({
            node: 'mavlink-ai-move',
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
      node.status({ fill: 'green', shape: 'dot', text: labelFor(built.name) });
      send(msg);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-move', MavlinkAiMoveNode);
};

/**
 * Default coordinate frame for a coordinate kind.
 *
 * @param {string} coordinate  'local' | 'global'
 * @returns {string} MAV_FRAME name
 */
function defaultFrame(coordinate) {
  return coordinate === 'global' ? 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT' : 'MAV_FRAME_LOCAL_NED';
}

/**
 * Short status-badge label for a setpoint message name.
 *
 * @param {string} name
 * @returns {string}
 */
function labelFor(name) {
  return name === 'SET_POSITION_TARGET_GLOBAL_INT' ? 'global' : 'local';
}

/**
 * Emit a structured error on the single output and finish. The move node has no
 * dedicated error output, so — like the build node — operational failures ride
 * the output as a `mavlink/error` message.
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
