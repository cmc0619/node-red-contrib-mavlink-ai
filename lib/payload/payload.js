'use strict';

const { bindEnumValues, coreEnumValues } = require('../protocol/protocol-values');
const { MavlinkError } = require('../util/errors');

/**
 * Payload / peripheral actuation for the mavlink-ai-payload node.
 *
 * Builds the outbound message for a friendly payload verb — camera, gimbal,
 * servo, relay, gripper — so a companion doesn't hand-assemble it in the build
 * node. These verbs are deliberately vehicle-agnostic: servos, relays and
 * grippers matter as much to rovers, boats and submarines (lights, manipulators,
 * sample releases) as cameras and gimbals do to copters and survey planes.
 *
 * Most verbs are a `COMMAND_LONG`, but gimbal aiming can also use the modern
 * gimbal-manager protocol, which is a dedicated **message**
 * (`GIMBAL_MANAGER_SET_PITCHYAW`) rather than a command — a builder therefore
 * returns its own `{ name, fields }`, and buildPayload only resolves the
 * `command` enum / stamps targets, not the message shape.
 */

/** Modes that place a mount under MAVLink angle targeting (DO_MOUNT_CONTROL). */
const MAV_MOUNT_MODE_MAVLINK_TARGETING = 'MAVLINK_TARGETING';

/** Gripper actions (GRIPPER_ACTIONS enum) as raw param values. */
const GRIPPER_ACTIONS = { release: 'RELEASE', grab: 'GRAB' };

/** GIMBAL_MANAGER_FLAGS_YAW_LOCK: yaw is earth-frame (locked) rather than follow. */
const GIMBAL_MANAGER_FLAGS_YAW_LOCK = 'YAW_LOCK';

/** Friendly camera-mode names → CAMERA_MODE enum values (SET_CAMERA_MODE param2). */
const CAMERA_MODES = { image: 'IMAGE', video: 'VIDEO', survey: 'IMAGE_SURVEY' };

/** CAMERA_ZOOM_TYPE values (SET_CAMERA_ZOOM param1). Default RANGE = a 0..100 level. */
const CAMERA_ZOOM_TYPES = { step: 'STEP', continuous: 'CONTINUOUS', range: 'RANGE', focal: 'FOCAL_LENGTH' };

/** SET_FOCUS_TYPE values (SET_CAMERA_FOCUS param1). */
const CAMERA_FOCUS_TYPES = {
  step: 'STEP',
  continuous: 'CONTINUOUS',
  range: 'RANGE',
  meters: 'METERS',
  auto: 'AUTO',
  'auto-single': 'AUTO_SINGLE',
  'auto-continuous': 'AUTO_CONTINUOUS'
};

/** WINCH_ACTIONS values (DO_WINCH param2). */
const WINCH_ACTIONS = { relax: 'RELAXED', length: 'RELATIVE_LENGTH_CONTROL', rate: 'RATE_CONTROL' };

/** PARACHUTE_ACTION values (DO_PARACHUTE param1). */
const PARACHUTE_ACTIONS = { disable: 'DISABLE', enable: 'ENABLE', release: 'RELEASE' };

/**
 * Resolve a friendly action name to its numeric enum value from a name→value
 * table, throwing a structured error when it isn't a known action.
 *
 * Returns a resolver bound to the generated enum and friendly-name table.
 */
function enumAction(enumName, members, code, label) {
  return (opts, name) => {
    const member = members[String(name || '').toLowerCase()];
    if (member === undefined) {
      throw new MavlinkError(code, `${label} must be one of ${Object.keys(members).join('/')} (got '${name}').`);
    }
    return opts.value(enumName, member);
  };
}

const cameraMode = enumAction('CameraMode', CAMERA_MODES, 'BAD_CAMERA_MODE', 'Camera mode');
const gripperAction = enumAction('GripperActions', GRIPPER_ACTIONS, 'BAD_GRIPPER_ACTION', 'Gripper action');
const zoomType = enumAction('CameraZoomType', CAMERA_ZOOM_TYPES, 'BAD_ZOOM_TYPE', 'Zoom type');
const focusType = enumAction('SetFocusType', CAMERA_FOCUS_TYPES, 'BAD_FOCUS_TYPE', 'Focus type');
const winchAction = enumAction('WinchActions', WINCH_ACTIONS, 'BAD_WINCH_ACTION', 'Winch action');
const parachuteAction = enumAction('ParachuteAction', PARACHUTE_ACTIONS, 'BAD_PARACHUTE_ACTION', 'Parachute action');

/**
 * Convert friendly roll/pitch/yaw degrees to a MAVLink quaternion `[w, x, y, z]`
 * (ZYX / aerospace order), for GIMBAL_MANAGER_SET_ATTITUDE's `q` field.
 *
 * @param {*} rollDeg @param {*} pitchDeg @param {*} yawDeg
 * @returns {number[]} [w, x, y, z]
 */
function eulerToQuaternion(rollDeg, pitchDeg, yawDeg) {
  const cr = Math.cos(deg2rad(rollDeg) / 2);
  const sr = Math.sin(deg2rad(rollDeg) / 2);
  const cp = Math.cos(deg2rad(pitchDeg) / 2);
  const sp = Math.sin(deg2rad(pitchDeg) / 2);
  const cy = Math.cos(deg2rad(yawDeg) / 2);
  const sy = Math.sin(deg2rad(yawDeg) / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy
  ];
}

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
 * Degrees to radians. Gimbal angles are entered in the friendly ° and ride the
 * wire in radians.
 *
 * @param {*} deg
 * @returns {number}
 */
function deg2rad(deg) {
  return (num(deg, 0) * Math.PI) / 180;
}

/**
 * Per-action builders. Each returns the full `{ name, fields }` for its outbound
 * message: a `COMMAND_LONG` with `{ command, param1..param7 }`, or a dedicated
 * message with its own fields. buildPayload resolves the `command` enum and
 * stamps target ids; the message shape is the builder's own.
 */
const BUILDERS = {
  /** Take one or more photos (MAV_CMD_IMAGE_START_CAPTURE). */
  camera_photo(opts) {
    const count = num(opts.count, 1);
    return command('IMAGE_START_CAPTURE', {
      param2: num(opts.interval, 0),
      param3: count,
      /**
       * Spec: the capture sequence number starts at 1 and is only valid for
       * single-capture commands (param3 == 1); multi-shot/continuous captures
       * must send 0 — enforced even against an explicit `sequence` override,
       * which is only meaningful for a single capture.
       */
      param4: count === 1 ? num(opts.sequence, 1) : 0
    });
  },
  /** Start video recording (MAV_CMD_VIDEO_START_CAPTURE). */
  camera_video_start(opts) {
    return command('VIDEO_START_CAPTURE', {
      param1: num(opts.streamId, 0),
      param2: num(opts.statusFrequency, 0)
    });
  },
  /** Stop video recording (MAV_CMD_VIDEO_STOP_CAPTURE). */
  camera_video_stop(opts) {
    return command('VIDEO_STOP_CAPTURE', { param1: num(opts.streamId, 0) });
  },
  /** Set the camera mode: image / video / survey (MAV_CMD_SET_CAMERA_MODE). */
  camera_mode(opts) {
    return command('SET_CAMERA_MODE', { param2: cameraMode(opts, opts.cameraMode || 'image') });
  },
  /** Trigger the camera every N metres of travel (MAV_CMD_DO_SET_CAM_TRIGG_DIST). */
  cam_trigger_distance(opts) {
    const distance = num(opts.distance, NaN);
    if (!Number.isFinite(distance) || distance < 0) {
      throw new MavlinkError('BAD_TRIGGER_DISTANCE', 'Trigger-by-distance requires a non-negative distance in metres.');
    }
    return command('DO_SET_CAM_TRIGG_DIST', {
      param1: distance,
      param3: opts.triggerNow ? 1 : 0
    });
  },
  /** Aim a gimbal/mount in degrees via the legacy command (MAV_CMD_DO_MOUNT_CONTROL). */
  gimbal_aim(opts) {
    return command('DO_MOUNT_CONTROL', {
      param1: num(opts.pitch, 0),
      param2: num(opts.roll, 0),
      param3: num(opts.yaw, 0),
      param7: opts.value('MavMountMode', MAV_MOUNT_MODE_MAVLINK_TARGETING)
    });
  },
  /**
   * Aim a gimbal via the gimbal-manager protocol (GIMBAL_MANAGER_SET_PITCHYAW).
   * This is a message, not a command — pitch/yaw are sent in radians. The rates
   * are sent as NaN, the message's documented "ignore" sentinel, so a static
   * angle setpoint is not misread as "reach the angle at 0 rad/s" (i.e. don't
   * move) by a gimbal that honours the rate constraint. Yaw-lock makes yaw
   * earth-frame.
   */
  gimbal_manager_aim(opts) {
    return {
      name: 'GIMBAL_MANAGER_SET_PITCHYAW',
      fields: {
        flags: opts.yawLock ? opts.value('GimbalManagerFlags', GIMBAL_MANAGER_FLAGS_YAW_LOCK) : 0,
        gimbal_device_id: num(opts.gimbalDeviceId, 0),
        pitch: deg2rad(opts.pitch),
        yaw: deg2rad(opts.yaw),
        pitch_rate: NaN,
        yaw_rate: NaN
      }
    };
  },
  /** Drive a servo output to a PWM value (MAV_CMD_DO_SET_SERVO). */
  servo(opts) {
    const pwm = num(opts.pwm, NaN);
    if (!Number.isFinite(pwm)) {
      throw new MavlinkError('BAD_SERVO', 'Servo action requires a numeric PWM value.');
    }
    return command('DO_SET_SERVO', { param1: num(opts.instance, 1), param2: pwm });
  },
  /** Switch a relay on or off (MAV_CMD_DO_SET_RELAY). */
  relay(opts) {
    return command('DO_SET_RELAY', { param1: num(opts.instance, 0), param2: opts.on ? 1 : 0 });
  },
  /**
   * Grab or release a gripper (MAV_CMD_DO_GRIPPER). An unknown/missing action
   * fails loudly instead of falling through to the destructive release: "not
   * recognized" must never mean "drop the payload" (#218), consistent with the
   * winch/parachute/camera builders that already resolve strictly.
   */
  gripper(opts) {
    return command('DO_GRIPPER', {
      param1: num(opts.instance, 1),
      param2: gripperAction(opts, opts.action)
    });
  },
  /**
   * Aim a gimbal via the gimbal-manager attitude message
   * (GIMBAL_MANAGER_SET_ATTITUDE). Roll/pitch/yaw degrees become a quaternion;
   * angular velocities are NaN (the "ignore" sentinel) so a static attitude
   * isn't read as "hold zero rate". Yaw-lock makes yaw earth-frame.
   */
  gimbal_manager_attitude(opts) {
    return {
      name: 'GIMBAL_MANAGER_SET_ATTITUDE',
      fields: {
        flags: opts.yawLock ? opts.value('GimbalManagerFlags', GIMBAL_MANAGER_FLAGS_YAW_LOCK) : 0,
        gimbal_device_id: num(opts.gimbalDeviceId, 0),
        q: eulerToQuaternion(opts.roll, opts.pitch, opts.yaw),
        angular_velocity_x: NaN,
        angular_velocity_y: NaN,
        angular_velocity_z: NaN
      }
    };
  },
  /** Set the camera zoom (MAV_CMD_SET_CAMERA_ZOOM); default a 0..100 range level. */
  camera_zoom(opts) {
    return command('SET_CAMERA_ZOOM', {
      param1: zoomType(opts, opts.zoomType || 'range'),
      param2: num(opts.zoomValue, 0)
    });
  },
  /** Set the camera focus (MAV_CMD_SET_CAMERA_FOCUS). */
  camera_focus(opts) {
    return command('SET_CAMERA_FOCUS', {
      param1: focusType(opts, opts.focusType || 'range'),
      param2: num(opts.focusValue, 0)
    });
  },
  /** Control a winch: relax, pay out a relative length, or hold a rate (MAV_CMD_DO_WINCH). */
  winch(opts) {
    return command('DO_WINCH', {
      param1: num(opts.instance, 1),
      param2: winchAction(opts, opts.winchAction || 'relax'),
      param3: num(opts.length, 0),
      param4: num(opts.rate, 0)
    });
  },
  /**
   * Enable, disable, or release a parachute (MAV_CMD_DO_PARACHUTE). The action
   * is required with no default: PARACHUTE_RELEASE both deploys the chute and
   * kills the motors, so a missing/blank action (an imported node without the
   * field, or a runtime `action: 'parachute'` switch that omits it) must fail
   * loudly rather than silently trigger the destructive release.
   */
  parachute(opts) {
    return command('DO_PARACHUTE', {
      param1: parachuteAction(opts, opts.parachuteAction)
    });
  },
  /** Pulse a servo `count` times at `period` seconds (MAV_CMD_DO_REPEAT_SERVO). */
  repeat_servo(opts) {
    const pwm = num(opts.pwm, NaN);
    if (!Number.isFinite(pwm)) {
      throw new MavlinkError('BAD_SERVO', 'Repeat-servo requires a numeric PWM value.');
    }
    return command('DO_REPEAT_SERVO', {
      param1: num(opts.instance, 1),
      param2: pwm,
      param3: num(opts.count, 1),
      param4: num(opts.period, 1)
    });
  },
  /** Pulse a relay `count` times at `period` seconds (MAV_CMD_DO_REPEAT_RELAY). */
  repeat_relay(opts) {
    return command('DO_REPEAT_RELAY', {
      param1: num(opts.instance, 0),
      param2: num(opts.count, 1),
      param3: num(opts.period, 1)
    });
  }
};

/**
 * Build a `COMMAND_LONG` message-part from a command name and its params.
 *
 * @param {string} commandName  MAV_CMD_* name
 * @param {object} params       param1..param7 the command sets
 * @returns {{ name: string, fields: object }}
 */
function command(commandName, params) {
  return { name: 'COMMAND_LONG', fields: Object.assign({ command: commandName }, params) };
}

/**
 * Build a payload-control message for a named action.
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
  /**
   * Fall back to the core bundle when the profile has no loaded dialect (#309
   * review): common actions (camera/gimbal/mount + the MavCmd they carry)
   * resolve from core and keep working, while a genuinely dialect-specific
   * action enum absent from core (e.g. ArduPilot GripperActions) still fails
   * closed with ENUM_VALUE_UNAVAILABLE — which is correct, it needs that dialect.
   * A present dialect still wins.
   */
  const value = opts.enums
    ? bindEnumValues(opts.enums, { dialect: opts.dialect || 'unknown', consumer: 'payload' })
    : coreEnumValues({ consumer: 'payload' });
  const built = builder(Object.assign({}, opts, { value }));
  if (typeof built.fields.command === 'string') {
    built.fields.command = value('MavCmd', built.fields.command);
  }
  built.fields.target_system = opts.targetSystem;
  built.fields.target_component = opts.targetComponent;
  return built;
}

module.exports = { BUILDERS, buildPayload };
