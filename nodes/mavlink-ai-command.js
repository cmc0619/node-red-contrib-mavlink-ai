'use strict';

const { MavlinkError, toMavlinkError } = require('../lib/util/errors');
const { makeFail } = require('../lib/util/node-errors');
const { truncateStatus } = require('../lib/util/status');
const { DELIVERY, resolveDeliveryMode } = require('../lib/util/delivery');
const { firstDefined, toInt, toNum, toBool, parseJsonObjectConfig } = require('../lib/util/validation');
const { registerEditorApi } = require('../lib/editor-api');
const { resolveInEnum } = require('../lib/protocol/enum-resolver');
const { bindEnumValues } = require('../lib/protocol/protocol-values');
const { resolveFlightMode, splitPx4CustomMode } = require('../lib/command/flight-modes');
const { CommandSend } = require('../lib/command/command-workflow');
const { degToDegE7 } = require('../lib/util/geo');
const { PRIORITY, commandPriorityFor } = require('../lib/runtime/send-priority');
const { watchConfigBadge } = require('../lib/util/node-lifecycle');
const {
  validateTargetSystem,
  validateTargetComponent,
  validateLatitude,
  validateLongitude
} = require('../lib/util/field-validation');

/**
 * True if `value` looks like a raw MAV_CMD reference (enum name or number)
 * rather than one of the friendly presets.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isRawCommand(value) {
  return /^MAV_CMD_[A-Z0-9_]+$/.test(String(value)) || /^\d+$/.test(String(value));
}

// Presets whose friendly action selects a specific message: sending message id
// 0 (HEARTBEAT) because the selector was omitted is a mistake, not a default.
const MESSAGE_SELECTOR_PRESETS = new Set(['request_message', 'set_message_interval', 'stop_message_interval']);

/**
 * Require a preset input to be present and a finite number (#87). Explicit
 * zeros are legitimate values and pass; blank/absent or non-numeric input
 * throws a structured error naming the field.
 *
 * @param {string} selected  preset name (for the error)
 * @param {string} field     input name (for the error)
 * @param {*} value
 * @returns {number}
 * @throws {MavlinkError} MISSING_REQUIRED_FIELD
 */
function requirePresetValue(selected, field, value) {
  if (value === undefined || value === null || value === '') {
    throw new MavlinkError(
      'MISSING_REQUIRED_FIELD',
      `Preset '${selected}' requires '${field}' — it does not default. Set it in the editor or in msg.payload.`,
      { command: selected, field }
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new MavlinkError(
      'MISSING_REQUIRED_FIELD',
      `Preset '${selected}' requires a finite numeric '${field}' (got ${JSON.stringify(value)}).`,
      { command: selected, field, value }
    );
  }
  return n;
}

/**
 * Preset-specific required inputs (#87). The raw MAV_CMD path and the generic
 * builder stay permissive (MAVLink zero-fills), but a friendly preset must not
 * silently turn an omitted value into a semantically different command — the
 * clearest case being goto without coordinates becoming a reposition to 0,0.
 *
 * @param {string} selected  preset name
 * @param {object} merged    preset params merged with the runtime payload
 * @param {object} configParams  editor-saved raw param values
 * @returns {void}
 * @throws {MavlinkError} MISSING_REQUIRED_FIELD
 */
function validatePresetInputs(selected, merged, configParams) {
  if (selected === 'goto') {
    // Raw wire x/y (degE7/arbitrary) is the advanced escape hatch; using it
    // requires both. Otherwise lat AND lon (degrees) must both be supplied —
    // one-sided input is always a mistake.
    if (merged.x !== undefined || merged.y !== undefined) {
      requirePresetValue(selected, 'x', merged.x);
      requirePresetValue(selected, 'y', merged.y);
      return;
    }
    requirePresetValue(selected, 'lat', firstDefined(merged.lat, configParams.param5));
    requirePresetValue(selected, 'lon', firstDefined(merged.lon, configParams.param6));
    return;
  }
  if (MESSAGE_SELECTOR_PRESETS.has(selected)) {
    requirePresetValue(selected, 'message_id', firstDefined(merged.message_id, merged.param1));
  }
}

/**
 * mavlink-ai-command (DESIGN.md §13.5).
 *
 * Builds common command messages as normalized outbound objects. Delivery is
 * explicit (#207): "Build only" hands the built message to a downstream
 * mavlink-ai-out node; "Send via connection" sends it directly and fire-and-
 * forgets; "Send & await result" sends it and runs the full command protocol
 * itself — retransmit with an incrementing confirmation on timeout, and
 * output the COMMAND_ACK result (issue #16). Every mode emits on port 0
 * (product) with errors on port 1.
 */
module.exports = function registerMavlinkAiCommand(RED) {
  // Serve message/enum metadata to the editor's MAV_CMD picker.
  registerEditorApi(RED);

  /**
   * MAV_CMD_CONDITION_YAW param3 direction from a friendly value:
   * 'clockwise'/'cw'/1, 'counter-clockwise'/'ccw'/-1, 'shortest'/0.
   *
   * @param {*} value
   * @param {number} fallback
   * @returns {number}
   */
  function yawDirection(value, fallback) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const s = String(value).toLowerCase().replace(/[\s_-]/g, '');
    if (s === 'clockwise' || s === 'cw') {
      return 1;
    }
    if (s === 'counterclockwise' || s === 'ccw') {
      return -1;
    }
    if (s === 'shortest') {
      return 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Shared CONDITION_YAW shape for the condition_yaw and spin presets.
   *
   * @param {object} p        merged preset/runtime params
   * @param {number} angle    degrees to turn / heading to face
   * @param {object} defaults { direction, relative } preset defaults
   * @returns {object}
   */
  function yawCommand(p, angle, defaults) {
    return {
      command: 'MAV_CMD_CONDITION_YAW',
      param1: angle,
      param2: firstDefined(p.rate, p.param2, 0), // 0 = firmware default rate
      param3: yawDirection(p.direction, defaults.direction),
      param4: toBool(firstDefined(p.relative, defaults.relative), false) ? 1 : 0
    };
  }

  // MAV_CMD_DO_CHANGE_SPEED param1 speed types from friendly names.
  const SPEED_TYPES = { airspeed: 0, groundspeed: 1, climb: 2, descent: 3 };

  // Each builder returns a flat object: { command, param1..param7 } (only the
  // params it sets). These are merged into the COMMAND_LONG/COMMAND_INT
  // fields. Grouping mirrors the editor's dropdown (#50).
  const COMMANDS = {
    // --- Basic Flight -------------------------------------------------------
    arm: (p) => ({ command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 1, param2: p.force ? 21196 : 0 }),
    disarm: (p) => ({ command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 0, param2: p.force ? 21196 : 0 }),
    set_mode: (p) => ({
      command: 'MAV_CMD_DO_SET_MODE',
      param1: firstDefined(p.base_mode, p.param1, 1),
      param2: firstDefined(p.custom_mode, p.param2, 0),
      param3: firstDefined(p.custom_submode, p.param3, 0)
    }),
    takeoff: (p) => ({ command: 'MAV_CMD_NAV_TAKEOFF', param7: firstDefined(p.altitude, p.param7, 10) }),
    land: () => ({ command: 'MAV_CMD_NAV_LAND' }),
    rtl: () => ({ command: 'MAV_CMD_NAV_RETURN_TO_LAUNCH' }),

    // --- Guided / Autonomy (#50) --------------------------------------------
    // goto rides COMMAND_INT by default (DO_REPOSITION wants degE7 x/y); the
    // lat/lon/alt inputs are handled by the COMMAND_INT path below.
    goto: (p) => ({
      command: 'MAV_CMD_DO_REPOSITION',
      param1: firstDefined(p.speed, -1), // m/s, -1 = vehicle default
      param2: 1, // MAV_DO_REPOSITION_FLAGS_CHANGE_MODE: switch to guided
      /**
       * DO_REPOSITION param4 is yaw in RADIANS (per the dialect definition),
       * while every friendly yaw input in this suite is degrees — convert here.
       * toNum's blank-aware coercion keeps an absent/blank yaw (dashboard form
       * fields arrive as '') at NaN = "keep the current yaw mode", instead of
       * Number('') === 0 silently commanding a yaw to north; NaN degrees stays
       * NaN radians. A raw `param4` override elsewhere is untouched (radians).
       */
      param4: (toNum(p.yaw, NaN) * Math.PI) / 180
    }),
    change_speed: (p) => ({
      command: 'MAV_CMD_DO_CHANGE_SPEED',
      param1: firstDefined(SPEED_TYPES[String(p.speed_type).toLowerCase()], p.speed_type, p.param1, 1),
      param2: firstDefined(p.speed, p.param2, 0),
      param3: firstDefined(p.throttle, p.param3, -1) // -1 = no throttle change
    }),
    condition_yaw: (p) => yawCommand(p, firstDefined(p.angle, p.param1, 0), { direction: 0, relative: false }),
    // Spin / Rotate (#52): a relative turn, default one full rotation but the
    // angle is configurable (90, 180, 720, ...).
    spin: (p) => yawCommand(p, firstDefined(p.angle, p.param1, 360), { direction: 1, relative: true }),

    // --- Mission (#50) ------------------------------------------------------
    mission_start: (p) => ({
      command: 'MAV_CMD_MISSION_START',
      param1: firstDefined(p.first_item, p.param1, 0),
      param2: firstDefined(p.last_item, p.param2, 0)
    }),
    // param1 is fixed per preset so an incoming override can't silently flip
    // pause into resume (same protection as arm/disarm param1).
    pause_mission: () => ({ command: 'MAV_CMD_DO_PAUSE_CONTINUE', param1: 0 }),
    resume_mission: () => ({ command: 'MAV_CMD_DO_PAUSE_CONTINUE', param1: 1 }),

    // --- Telemetry / System -------------------------------------------------
    reboot: () => ({ command: 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN', param1: 1 }),
    request_message: (p) => ({
      command: 'MAV_CMD_REQUEST_MESSAGE',
      param1: firstDefined(p.message_id, p.param1, 0)
    }),
    set_message_interval: (p) => {
      // Humans think in Hz; the wire wants microseconds. rate_hz wins only
      // when it is a usable positive number.
      const rate = Number(p.rate_hz);
      const rateUs = Number.isFinite(rate) && rate > 0 ? Math.round(1e6 / rate) : undefined;
      return {
        command: 'MAV_CMD_SET_MESSAGE_INTERVAL',
        param1: firstDefined(p.message_id, p.param1, 0),
        param2: firstDefined(p.interval_us, rateUs, p.param2, 1000000)
      };
    },
    // Disable a stream: SET_MESSAGE_INTERVAL with interval -1 stops the message
    // (0 would request the default rate, so we force -1 for a real stop).
    stop_message_interval: (p) => ({
      command: 'MAV_CMD_SET_MESSAGE_INTERVAL',
      param1: firstDefined(p.message_id, p.param1, 0),
      param2: -1
    })
  };

  // Presets that should ride COMMAND_INT unless the user says otherwise
  // (their positional params are degE7-scaled lat/lon).
  const INT_PRESETS = new Set(['goto']);

  function MavlinkAiCommandNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    /**
     * Resolve node.profile + node.connection and keep their idle badges live
     * across deploys. The connection is only *needed* for Send/Await delivery
     * (Build only hands mavlink/send to a downstream Out node), so a missing
     * connection is badged only in those modes (#164, #207).
     */
    watchConfigBadge(RED, node, config, {
      profile: 'required',
      connection: 'optional',
      connectionRequiredWhen: () => config.delivery === DELIVERY.SEND || config.delivery === DELIVERY.AWAIT
    });
    node.command = config.command || 'arm';
    node.sendAs = config.sendAs || 'long'; // 'long' | 'int' (COMMAND_INT, issue #17)
    node.timeoutMs = toInt(config.timeoutMs, 3000);
    node.maxRetries = toInt(config.maxRetries, 3);

    /**
     * Static param values for a raw MAV_CMD selection, plus the friendly preset
     * parameters (#49: mode, altitude, force, message_id, rate_hz, angle, ...),
     * both written by the editor. They are stored separately so switching
     * between preset and raw selections cannot corrupt saved values; runtime
     * msg.payload values override these statics.
     *
     * Malformed static JSON invalidates the node instead of silently becoming
     * `{}` and omitting intended parameters (#204). Blank stays the empty
     * default; imported/API/hand-edited flows bypass the editor validator.
     */
    const parsedParams = parseJsonObjectConfig(config.fields, 'fields');
    const parsedPreset = parseJsonObjectConfig(config.presetFields, 'presetFields');
    const configParams = parsedParams.value;
    const presetParams = parsedPreset.value;

    /**
     * A missing/invalid Delivery selection (#207, #308) is a construct-time
     * config error too, not just an input-time one: a pre-upgrade node (or one
     * created via import/API without a `delivery` value) must show the same red
     * badge at deploy time as malformed static JSON, instead of looking healthy
     * until the first message. Folded into the same `node._configError` the
     * input handler already short-circuits on; `watchConfigBadge`'s own
     * `flows:started` refresh also checks this flag (#308 G1), so the badge
     * is re-asserted — not cleared — on every later redeploy too, for as
     * long as delivery stays unset.
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

    node._configError = parsedParams.error || parsedPreset.error || deliveryConfigError;
    /**
     * Precedence (#308): "invalid profile" is the more fundamental problem and
     * watchConfigBadge already painted that badge above, so only paint over it
     * with "invalid config" when the profile itself resolved fine — a
     * delivery-unset (or malformed-fields) node with a broken profile keeps
     * showing "invalid profile" instead of masking it.
     */
    const profileOk = !!(node.profile && typeof node.profile.isValid === 'function' && node.profile.isValid());
    if (node._configError && profileOk) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    }

    // Active await-ack workflows, so a node close (partial deploy / delete)
    // aborts them instead of leaving subscriptions, retransmit timers, and
    // the command lock alive on an obsolete node (#83).
    const activeWorkflows = new Set();
    let closed = false;

    /**
     * Emit a structured error on the output and finish the input handler.
     *
     * @param {object} msg
     * @param {function} send
     * @param {function} done
     * @param {string} code
     * @param {string} message
     * @param {object} [context]
     * @returns {void}
     */
    node.on('input', async (msg, send, done) => {
      /**
       * The single error exit (#285): one closure binds node/msg/send/done,
       * so call sites pass only the failure — the positional
       * (msg, send, done, code, ...) threading that invited a #276-style
       * arity shift is gone. Two ports (#207): product on 0, error on 1.
       */
      /**
       * A send failure must name the connection it actually used, even if a
       * live redeploy replaced node.connection mid-flight (#128/#238) — the
       * Send and Await delivery paths below each record their captured
       * connection here before their async work starts, mirroring the
       * payload/move nodes' `sentOn` pattern.
       */
      let sentOn = null;
      const fail = makeFail({
        node,
        nodeName: 'mavlink-ai-command',
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
      if (node._configError) {
        return fail(new MavlinkError('INVALID_CONFIG', `mavlink-ai-command: ${node._configError}`));
      }
      const incoming = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const selected = msg.command || incoming.command || node.command;
      const builder = COMMANDS[selected];

      if (!node.profile) {
        return fail(new MavlinkError('MISSING_PROFILE',
          'Command node has no profile configured (deleted or disabled config node?).'));
      }

      const defaults = node.profile.getDefaults ? node.profile.getDefaults() : {};
      const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
      const value = bindEnumValues(bundle ? bundle.enums : null, {
        dialect: bundle ? bundle.name : 'unknown',
        consumer: 'command'
      });

      // Editor preset fields under runtime payload values (#49): a static
      // editor value (e.g. mode "GUIDED", altitude 15) applies unless the
      // incoming message overrides it.
      const merged = Object.assign({}, presetParams, incoming);

      // Firmware-aware mode names (issue #20): set_mode accepts `mode` (e.g.
      // "GUIDED", "POSITION") — now also from the editor's mode dropdown —
      // resolved against the profile firmware + vehicle type. Numeric
      // base_mode/custom_mode input keeps working unchanged.
      const params = Object.assign({}, merged);
      if (selected === 'set_mode' && merged.mode !== undefined) {
        try {
          const resolved = resolveFlightMode({
            firmware: defaults.firmware,
            vehicleType: firstDefined(merged.vehicle_type, defaults.vehicleFamily),
            enums: bundle ? bundle.enums : null,
            dialect: bundle ? bundle.name : 'unknown'
          }, merged.mode);
          params.base_mode = firstDefined(merged.base_mode, resolved.base_mode);
          params.custom_mode = firstDefined(merged.custom_mode, resolved.custom_mode);
          params.custom_submode = firstDefined(merged.custom_submode, resolved.custom_submode);
        } catch (err) {
          const e = toMavlinkError(err, 'UNKNOWN_MODE');
          return fail(e);
        }
      }

      // Presets use their builder; anything shaped like a MAV_CMD (enum name or
      // number) is sent as a raw COMMAND_LONG/COMMAND_INT with the given params.
      let built;
      if (builder) {
        // Reboot is the one preset dangerous enough for a runtime gate: a
        // reboot mid-flight stops the motors, and the editor's confirmation
        // checkbox cannot protect flows deployed via import/API. Require the
        // confirm flag (editor checkbox or msg.payload.confirm) here too.
        if (selected === 'reboot' && !toBool(params.confirm, false)) {
          return fail(new MavlinkError('REBOOT_NOT_CONFIRMED',
            "Reboot requires explicit confirmation: check 'Confirm reboot' in the editor or set msg.payload.confirm = true."));
        }
        // Friendly presets validate their semantically required inputs (#87)
        // instead of inheriting the permissive zero defaults of the raw path.
        try {
          validatePresetInputs(selected, merged, configParams);
        } catch (err) {
          const e = toMavlinkError(err, 'MISSING_REQUIRED_FIELD');
          return fail(e);
        }
        built = builder(params);
      } else if (isRawCommand(selected)) {
        built = { command: selected };
      } else {
        return fail(new MavlinkError('UNKNOWN_COMMAND',
          `Unknown command '${selected}'. Use a preset (${Object.keys(COMMANDS).join(', ')}) or a MAV_CMD_* name.`));
      }

      // COMMAND_INT (issue #17): some commands are only valid via COMMAND_INT,
      // whose x/y carry lat/lon as degE7 int32 for global frames. Accept the
      // usual Node-RED boolean spellings ("true"/1/"yes") at runtime. Position
      // presets like goto default to COMMAND_INT (#50).
      const defaultInt = node.sendAs === 'int' || INT_PRESETS.has(String(selected));
      const useInt = toBool(firstDefined(msg.command_int, merged.command_int, defaultInt), false);

      let fields;
      let messageName;
      if (useInt) {
        messageName = 'COMMAND_INT';
        // Positional input priority: raw x/y (wire values) > lat/lon degrees >
        // editor-saved param5/6 (degrees, COMMAND_LONG convention) > 0. A value
        // that fails numeric conversion must error, not silently become 0,0.
        const latDeg = firstDefined(merged.lat, configParams.param5);
        const lonDeg = firstDefined(merged.lon, configParams.param6);
        // Coerce to numbers here (not just validate): the raw input may be a
        // numeric string, and the emitted payload should carry real numbers
        // for downstream consumers rather than relying on later resolution.
        const x = Number(firstDefined(merged.x, latDeg !== undefined ? degToDegE7(Number(latDeg)) : undefined, 0));
        const y = Number(firstDefined(merged.y, lonDeg !== undefined ? degToDegE7(Number(lonDeg)) : undefined, 0));
        const z = Number(firstDefined(merged.z, merged.alt, merged.param7, configParams.param7, 0));
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          return fail(new MavlinkError('BAD_COORDINATES',
            `COMMAND_INT coordinates must be numeric (got x=${x}, y=${y}, z=${z}).`));
        }
        fields = Object.assign(
          {
            frame: firstDefined(merged.frame, 'MAV_FRAME_GLOBAL'),
            current: 0,
            autocontinue: 0,
            param1: 0,
            param2: 0,
            param3: 0,
            param4: 0,
            x,
            y,
            z
          },
          pickParams(configParams, 4),
          built
        );
        // COMMAND_INT carries positional params in x/y/z: param5/6 are lat/lon
        // scaled to degE7, param7 is z unscaled. Map any a preset builder set.
        if (built.param5 !== undefined) {
          fields.x = degToDegE7(Number(built.param5));
        }
        if (built.param6 !== undefined) {
          fields.y = degToDegE7(Number(built.param6));
        }
        if (built.param7 !== undefined) {
          fields.z = built.param7;
        }
        delete fields.param5;
        delete fields.param6;
        delete fields.param7;
      } else {
        messageName = 'COMMAND_LONG';
        // Base zeros, then static config params (raw MAV_CMD mode), then the
        // builder output (preset semantics win over config params).
        fields = Object.assign(
          { confirmation: 0, param1: 0, param2: 0, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 },
          configParams,
          built
        );
      }
      // Allow explicit param overrides from the incoming payload, but never
      // clobber a param the builder set on purpose (e.g. arm/disarm param1),
      // so an incoming override can't silently flip command semantics.
      const overridable = useInt ? 4 : 7;
      for (let i = 1; i <= overridable; i += 1) {
        const key = `param${i}`;
        if (merged[key] !== undefined && built[key] === undefined) {
          fields[key] = merged[key];
        }
      }

      /**
       * PX4 DO_SET_MODE packing (issue #136): the PX4 commander reads param2
       * as the bare custom *main* mode and param3 as the bare sub mode, so a
       * HEARTBEAT-packed custom_mode ((main << 16) | (sub << 24)) — from a
       * numeric payload override or the raw editor's mode dropdown — must be
       * split before it hits the wire, or it truncates to main mode 0 and the
       * vehicle ignores the mode change. ArduPilot reads param2 as the whole
       * custom_mode, so only px4 profiles are normalized. A packed param2
       * carries the sub mode too, so its split sub overwrites param3 (a stale
       * dropdown value there would otherwise flip AUTO.MISSION to AUTO.RTL); a
       * bare main-mode param2 is left alone and any separate param3 preserved.
       */
      if (defaults.firmware === 'px4') {
        try {
          const setModeCommand = value('MavCmd', 'DO_SET_MODE');
          const command = resolveInEnum(bundle ? bundle.enums : null, 'MavCmd', fields.command);
          if (command === setModeCommand) {
            const split = splitPx4CustomMode(fields.param2);
            if (split) {
              fields.param2 = split.main;
              fields.param3 = split.sub;
            }
          }
        } catch (err) {
          return fail(toMavlinkError(err, 'ENUM_VALUE_UNAVAILABLE'));
        }
      }

      /**
       * PX4 NAV_TAKEOFF semantics (issue #143): param7 is AMSL on PX4 (NaN =
       * use MIS_TAKEOFF_ALT) while ArduPilot treats it as relative-to-home,
       * and a param4 yaw of 0 swings the nose to north (NaN = keep current
       * heading). The takeoff builder only writes param7 (from altitude/param7),
       * so map the altitude and yaw aliases here and fall back to PX4's own NaN
       * defaults rather than the numbers that are only correct for ArduPilot.
       */
      if (defaults.firmware === 'px4' && selected === 'takeoff' && !useInt) {
        fields.param7 = firstDefined(merged.altitude, merged.alt, merged.param7, NaN);
        fields.param4 = firstDefined(merged.yaw, merged.param4, NaN);
      }

      const targetSystem = firstDefined(merged.target_system, defaults.defaultTargetSystem, 1);
      const targetComponent = firstDefined(merged.target_component, defaults.defaultTargetComponent, 1);

      // Workflow-level validation (#55): reject out-of-range targets and, when
      // the user supplied lat/lon degrees, out-of-range coordinates — before a
      // command reaches a vehicle. Raw x/y wire values are left to the finite
      // check above (they're degE7/arbitrary, not degrees). In the COMMAND_INT
      // path lat/lon also fall back to editor-saved param5/param6 (degrees), so
      // validate that source too; in COMMAND_LONG those params are generic and
      // not treated as coordinates.
      try {
        validateTargetSystem(targetSystem);
        validateTargetComponent(targetComponent);
        if (!useInt && (merged.x !== undefined || merged.y !== undefined)) {
          /**
           * Raw wire x/y are COMMAND_INT fields; the COMMAND_LONG path would
           * silently drop them and send param5/6 = 0 — a reposition to 0°N 0°E.
           */
          throw new MavlinkError(
            'INVALID_FIELD',
            "Raw wire 'x'/'y' values require COMMAND_INT (command_int: true); COMMAND_LONG carries position as float degrees in lat/lon (param5/param6).",
            { command: selected }
          );
        }
        const latInput = firstDefined(merged.lat, useInt ? configParams.param5 : undefined);
        const lonInput = firstDefined(merged.lon, useInt ? configParams.param6 : undefined);
        if (latInput !== undefined) {
          validateLatitude(latInput, { command: selected });
        }
        if (lonInput !== undefined) {
          validateLongitude(lonInput, { command: selected });
        }
      } catch (err) {
        const e = toMavlinkError(err, 'INVALID_FIELD');
        return fail(e);
      }

      // --- Send & await result (issue #16): run the command protocol ourselves
      if (mode === DELIVERY.AWAIT) {
        if (!node.connection) {
          return fail(new MavlinkError('NO_CONNECTION',
            'Send & await result requires a connection to send on (select one in the node config).'));
        }
        if (Number(targetSystem) === 0) {
          /**
           * Responders ACK from their real (nonzero) sysid, so a broadcast
           * await-ack can never match and always ends in a misleading
           * COMMAND_TIMEOUT. The payload and fan-out nodes reject this the
           * same way (BROADCAST_NO_ACK).
           */
          return fail(new MavlinkError('BROADCAST_NO_ACK',
            'Broadcast (target_system 0) cannot confirm a COMMAND_ACK — use the fan-out node for per-vehicle acks, or switch delivery to Send or Build only.'));
        }
        /**
         * Captured before the workflow starts (#308 R4): a live flows:started
         * refresh can swap or null node.connection while the await-ack
         * workflow's send/retransmits are in flight, and a COMMAND_FAILED
         * raised from that workflow must name the connection it actually ran
         * on rather than a stale/absent node.connection read after the fact —
         * mirrors the Send path's `sentOn` capture just below.
         */
        sentOn = node.connection;
        const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
        // The Local Identity this workflow transmits as (#228): the explicit
        // payload request when present (which must be attached and permitted on
        // the connection), else the connection's default. Never derived from
        // the Vehicle Profile. Its source ids also gate ACK matching below.
        let identity;
        try {
          identity = node.connection.resolveOutboundIdentity(incoming.localIdentity);
        } catch (err) {
          const e = toMavlinkError(err, 'LOCAL_IDENTITY_UNRESOLVED');
          return fail(e);
        }
        const source = identity.getIdentity();
        let workflow;
        try {
          workflow = new CommandSend({
            connection: node.connection,
            // Canonical config-node id: the connection must encode these sends
            // with this node's Vehicle Profile, not its own default.
            vehicleProfile: node.profile.id,
            // Carried on every send only when the caller explicitly requested
            // an identity; otherwise the connection default applies.
            localIdentity: incoming.localIdentity,
            targetSystem,
            targetComponent,
            // Our own identity, so an ACK addressed to another GCS sharing this
            // link doesn't settle the workflow (#99).
            sourceSystem: source.sysid,
            sourceComponent: source.compid,
            command: fields.command,
            fields,
            useInt,
            enums: bundle ? bundle.enums : null,
            dialect: bundle ? bundle.name : 'unknown',
            timeoutMs: node.timeoutMs,
            maxRetries: node.maxRetries,
            onProgress: (p) => node.status({ fill: 'blue', shape: 'dot', text: progressText(p.payload) })
          });
        } catch (err) {
          const e = toMavlinkError(err, 'BAD_COMMAND');
          return fail(e);
        }
        activeWorkflows.add(workflow);
        workflow
          .run()
          .then((result) => {
            activeWorkflows.delete(workflow);
            if (closed) {
              return done(); // aborted by close: no output from an obsolete node
            }
            node.status({ fill: 'green', shape: 'dot', text: truncateStatus(`${selected} accepted`) });
            msg.topic = result.topic;
            msg.payload = result.payload;
            send([msg, null]);
            done();
          })
          .catch((err) => {
            activeWorkflows.delete(workflow);
            if (closed) {
              return done(); // aborted by close: no output from an obsolete node
            }
            // The structured error on the output is the one delivery of this
            // failure (#89): fail()'s done() — not done(err) — so a Catch node
            // doesn't also fire for it.
            fail(err, 'COMMAND_FAILED');
          });
        return;
      }

      // --- Send via connection (fire-and-forget, #207) ------------------------
      if (mode === DELIVERY.SEND) {
        if (!node.connection) {
          return fail(new MavlinkError('NO_CONNECTION',
            'Send via connection requires a connection to send on (select one in the node config).'));
        }
        /**
         * Captured before the await (#238): a live flows:started refresh can
         * null or replace node.connection while this send is in flight, and
         * the catch path must name the connection actually used rather than a
         * stale/absent node.connection read after the fact.
         */
        const connection = node.connection;
        sentOn = connection;
        const sendBundle = node.profile && node.profile.getDialect ? node.profile.getDialect() : null;
        const priority = commandPriorityFor(sendBundle ? sendBundle.enums : null, fields.command);
        try {
          await connection.send(
            {
              name: messageName,
              vehicleProfile: node.profile.id,
              localIdentity: incoming.localIdentity,
              target_system: targetSystem,
              target_component: targetComponent,
              fields
            },
            { priority }
          );
        } catch (err) {
          /**
           * Close/redeploy during the await above (#308 R3): mirrors the
           * success path's own `if (closed) return done();` guard below and
           * the await-ack path's catch, so a slow or queued in-flight send
           * that REJECTS after this node closed can't emit a `SEND_FAILED`
           * mavlink/error from an obsolete node.
           */
          if (closed) {
            return done();
          }
          return fail(err, 'SEND_FAILED');
        }
        /**
         * Close/redeploy during the await above (#308 G2): mirrors the
         * await-ack path's own `if (closed) return done();` guard, so a slow
         * or queued in-flight send that resolves after this node closed can't
         * drive downstream logic with a `command/sent` from an obsolete node.
         */
        if (closed) {
          return done();
        }
        node.status({ fill: 'green', shape: 'dot', text: truncateStatus(`${selected} sent`) });
        msg.topic = 'command/sent';
        msg.payload = { name: messageName, target_system: targetSystem, target_component: targetComponent, sent: true };
        send([msg, null]);
        return done();
      }

      // --- build-only mode (default): hand off to mavlink-ai-out -------------
      msg.topic = 'mavlink/send';
      // `vehicleProfile` carries the config-node id — the canonical reference
      // the connection resolves a codec by. The name is display-only. The
      // local identity is passed through only when the caller explicitly set
      // one; it is never derived from the Vehicle Profile (#228).
      msg.payload = {
        name: messageName,
        vehicleProfile: node.profile && node.profile.id,
        vehicleProfileName: node.profile && node.profile.name,
        target_system: targetSystem,
        target_component: targetComponent,
        fields
      };
      if (incoming.localIdentity !== undefined && incoming.localIdentity !== null && incoming.localIdentity !== '') {
        msg.payload.localIdentity = incoming.localIdentity;
      }
      /**
       * Stamp the CRITICAL band on the emitted message when the resolved
       * command is in the shared critical set (#241) — arm/disarm, mode change,
       * flight termination, parachute. The Out node forwards msg.priority to
       * the connection queue; non-critical messages carry no stamp so flows
       * keep full control of the field.
       */
      {
        const buildBundle = node.profile && node.profile.getDialect ? node.profile.getDialect() : null;
        const priority = commandPriorityFor(buildBundle ? buildBundle.enums : null, fields.command);
        if (priority === PRIORITY.CRITICAL) {
          msg.priority = priority;
        }
      }

      node.status({ fill: 'green', shape: 'dot', text: truncateStatus(selected) });
      send([msg, null]);
      done();
    });

    // Abort in-flight await-ack workflows on close (#83): a partial deploy or
    // node delete must stop retransmits, drop subscriptions, and release the
    // command lock instead of running to success/timeout on an obsolete node.
    node.on('close', function closeCommand(done) {
      closed = true;
      for (const workflow of activeWorkflows) {
        workflow.abort('mavlink-ai-command node closed');
      }
      activeWorkflows.clear();
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-command', MavlinkAiCommandNode);
};

/**
 * Pick only param1..paramN keys from a params object (COMMAND_INT carries just
 * param1-4; its positional params ride in x/y/z instead).
 *
 * @param {object} params
 * @param {number} n
 * @returns {object}
 */
function pickParams(params, n) {
  const out = {};
  for (let i = 1; i <= n; i += 1) {
    const key = `param${i}`;
    if (params[key] !== undefined) {
      out[key] = params[key];
    }
  }
  return out;
}

/**
 * Short status-bar label for a command progress event.
 *
 * @param {object} p  progress payload
 * @returns {string}
 */
function progressText(p) {
  if (p.state === 'in_progress' && p.progress !== undefined) {
    return `in progress ${p.progress}%`;
  }
  return p.confirmation ? `retry ${p.confirmation}` : 'waiting ack';
}
