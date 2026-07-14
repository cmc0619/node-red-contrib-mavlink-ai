'use strict';

const enumResolver = require('../protocol/enum-resolver');
const { MavlinkError } = require('../util/errors');

/**
 * Payload / peripheral actuation for the mavlink-ai-payload node.
 *
 * Builds the `COMMAND_LONG` for a friendly payload verb — camera, gimbal,
 * servo, relay, gripper — so a companion doesn't hand-assemble `MAV_CMD_*`
 * params in the build node. These verbs are deliberately vehicle-agnostic:
 * servos, relays and grippers matter as much to rovers, boats and submarines
 * (lights, manipulators, sample releases) as cameras and gimbals do to copters
 * and survey planes.
 *
 * The message-based gimbal-manager protocol (GIMBAL_MANAGER_SET_PITCHYAW) is a
 * separate follow-up; v1 aims the gimbal with the widely supported
 * `MAV_CMD_DO_MOUNT_CONTROL` command.
 */

/** Modes that place a mount under MAVLink angle targeting. */
const MAV_MOUNT_MODE_MAVLINK_TARGETING = 2;

/** Gripper actions (GRIPPER_ACTIONS enum) as raw param values. */
const GRIPPER_RELEASE = 0;
const GRIPPER_GRAB = 1;

/**
 * A finite number, or the fallback. Used so blank/omitted inputs collapse to a
 * safe default rather than NaN reaching the wire.
 *
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve a `MAV_CMD_*` name to its numeric value, preferring the dialect enum
 * index and falling back to the name string (the send path resolves it too).
 *
 * @param {string} name
 * @param {object} [enums]
 * @returns {number|string}
 */
function resolveCommand(name, enums) {
  if (enums) {
    const resolved = enumResolver.lookup(enums, name);
    if (typeof resolved === 'number') {
      return resolved;
    }
  }
  return name;
}

/**
 * Per-action builders. Each returns the `COMMAND_LONG` params it sets (command
 * plus the relevant param1..param7); target ids are merged in by buildPayload.
 * Values come from the merged editor/runtime options.
 */
const BUILDERS = {
  /** Take one or more photos (MAV_CMD_IMAGE_START_CAPTURE). */
  camera_photo(opts) {
    return {
      command: 'MAV_CMD_IMAGE_START_CAPTURE',
      param2: num(opts.interval, 0),
      param3: num(opts.count, 1),
      param4: num(opts.sequence, 0)
    };
  },
  /** Start video recording (MAV_CMD_VIDEO_START_CAPTURE). */
  camera_video_start(opts) {
    return {
      command: 'MAV_CMD_VIDEO_START_CAPTURE',
      param1: num(opts.streamId, 0),
      param2: num(opts.statusFrequency, 0)
    };
  },
  /** Stop video recording (MAV_CMD_VIDEO_STOP_CAPTURE). */
  camera_video_stop(opts) {
    return {
      command: 'MAV_CMD_VIDEO_STOP_CAPTURE',
      param1: num(opts.streamId, 0)
    };
  },
  /** Aim a gimbal/mount in degrees (MAV_CMD_DO_MOUNT_CONTROL). */
  gimbal_aim(opts) {
    return {
      command: 'MAV_CMD_DO_MOUNT_CONTROL',
      param1: num(opts.pitch, 0),
      param2: num(opts.roll, 0),
      param3: num(opts.yaw, 0),
      param7: MAV_MOUNT_MODE_MAVLINK_TARGETING
    };
  },
  /** Drive a servo output to a PWM value (MAV_CMD_DO_SET_SERVO). */
  servo(opts) {
    const pwm = num(opts.pwm, NaN);
    if (!Number.isFinite(pwm)) {
      throw new MavlinkError('BAD_SERVO', 'Servo action requires a numeric PWM value.');
    }
    return {
      command: 'MAV_CMD_DO_SET_SERVO',
      param1: num(opts.instance, 1),
      param2: pwm
    };
  },
  /** Switch a relay on or off (MAV_CMD_DO_SET_RELAY). */
  relay(opts) {
    return {
      command: 'MAV_CMD_DO_SET_RELAY',
      param1: num(opts.instance, 0),
      param2: opts.on ? 1 : 0
    };
  },
  /** Grab or release a gripper (MAV_CMD_DO_GRIPPER). */
  gripper(opts) {
    return {
      command: 'MAV_CMD_DO_GRIPPER',
      param1: num(opts.instance, 1),
      param2: opts.action === 'grab' ? GRIPPER_GRAB : GRIPPER_RELEASE
    };
  }
};

/**
 * Build a payload-control `COMMAND_LONG` for a named action.
 *
 * @param {string} action  one of the keys in BUILDERS
 * @param {object} [opts]  action params plus { enums, targetSystem, targetComponent }
 * @returns {{ name: string, fields: object }}
 */
function buildPayload(action, opts = {}) {
  const builder = BUILDERS[action];
  if (!builder) {
    throw new MavlinkError('BAD_PAYLOAD_ACTION', `Unknown payload action '${action}'.`);
  }
  const parts = builder(opts);
  parts.command = resolveCommand(parts.command, opts.enums);
  parts.target_system = opts.targetSystem;
  parts.target_component = opts.targetComponent;
  return { name: 'COMMAND_LONG', fields: parts };
}

module.exports = { BUILDERS, buildPayload };
