'use strict';

const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { firstDefined, toInt, toBool } = require('../lib/util/validation');
const { registerEditorApi } = require('../lib/editor-api');
const { resolveFlightMode } = require('../lib/command/flight-modes');
const { CommandSend } = require('../lib/command/command-workflow');

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

/**
 * mavlink-ai-command (DESIGN.md §13.5).
 *
 * Builds common command messages as normalized outbound objects for
 * mavlink-ai-out. Building and sending are separate concerns, so by default
 * this node only builds — wire it into a mavlink-ai-out node to send.
 *
 * With "await ack" enabled (and a connection selected) the node instead runs
 * the full command protocol itself: send, retransmit with an incrementing
 * confirmation on timeout, and output the COMMAND_ACK result (issue #16).
 */
module.exports = function registerMavlinkAiCommand(RED) {
  // Serve message/enum metadata to the editor's MAV_CMD picker.
  registerEditorApi(RED);

  // Each builder returns a flat object: { command, param1..param7 } (only the
  // params it sets). These are merged into the COMMAND_LONG fields.
  const COMMANDS = {
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
    reboot: () => ({ command: 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN', param1: 1 }),
    request_message: (p) => ({
      command: 'MAV_CMD_REQUEST_MESSAGE',
      param1: firstDefined(p.message_id, p.param1, 0)
    }),
    set_message_interval: (p) => ({
      command: 'MAV_CMD_SET_MESSAGE_INTERVAL',
      param1: firstDefined(p.message_id, p.param1, 0),
      param2: firstDefined(p.interval_us, p.param2, 1000000)
    }),
    // Disable a stream: SET_MESSAGE_INTERVAL with interval -1 stops the message
    // (0 would request the default rate, so we force -1 for a real stop).
    stop_message_interval: (p) => ({
      command: 'MAV_CMD_SET_MESSAGE_INTERVAL',
      param1: firstDefined(p.message_id, p.param1, 0),
      param2: -1
    })
  };

  function MavlinkAiCommandNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.profile = RED.nodes.getNode(config.profile);
    node.connection = config.connection ? RED.nodes.getNode(config.connection) : null;
    node.command = config.command || 'arm';
    node.sendAs = config.sendAs || 'long'; // 'long' | 'int' (COMMAND_INT, issue #17)
    node.awaitAck = toBool(config.awaitAck, false);
    node.timeoutMs = toInt(config.timeoutMs, 3000);
    node.maxRetries = toInt(config.maxRetries, 3);

    // Static param values for a raw MAV_CMD selection (written by the editor).
    let configParams = {};
    if (config.fields) {
      try {
        configParams = JSON.parse(config.fields);
      } catch (e) {
        node.warn(`mavlink-ai-command: invalid fields JSON, ignoring (${e.message})`);
      }
    }

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
    function sendError(msg, send, done, code, message, context) {
      node.status({ fill: 'red', shape: 'ring', text: code });
      msg.topic = 'mavlink/error';
      msg.payload = errorPayload({ node: 'mavlink-ai-command', code, message, context });
      send(msg);
      done();
    }

    node.on('input', (msg, send, done) => {
      const incoming = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const selected = msg.command || incoming.command || node.command;
      const builder = COMMANDS[selected];

      if (!node.profile) {
        return sendError(msg, send, done, 'MISSING_PROFILE',
          'Command node has no profile configured (deleted or disabled config node?).');
      }

      const defaults = node.profile.getDefaults ? node.profile.getDefaults() : {};

      // Firmware-aware mode names (issue #20): set_mode accepts `mode` (e.g.
      // "GUIDED", "POSITION") resolved against the profile firmware + vehicle
      // type. Numeric base_mode/custom_mode input keeps working unchanged.
      const params = Object.assign({}, incoming);
      if (selected === 'set_mode' && incoming.mode !== undefined) {
        try {
          const resolved = resolveFlightMode(
            defaults.firmware,
            firstDefined(incoming.vehicle_type, defaults.profileType),
            incoming.mode
          );
          params.base_mode = firstDefined(incoming.base_mode, resolved.base_mode);
          params.custom_mode = firstDefined(incoming.custom_mode, resolved.custom_mode);
        } catch (err) {
          const e = toMavlinkError(err, 'UNKNOWN_MODE');
          return sendError(msg, send, done, e.code, e.message, e.context);
        }
      }

      // Presets use their builder; anything shaped like a MAV_CMD (enum name or
      // number) is sent as a raw COMMAND_LONG/COMMAND_INT with the given params.
      let built;
      if (builder) {
        built = builder(params);
      } else if (isRawCommand(selected)) {
        built = { command: selected };
      } else {
        return sendError(msg, send, done, 'UNKNOWN_COMMAND',
          `Unknown command '${selected}'. Use a preset (${Object.keys(COMMANDS).join(', ')}) or a MAV_CMD_* name.`);
      }

      // COMMAND_INT (issue #17): some commands are only valid via COMMAND_INT,
      // whose x/y carry lat/lon as degE7 int32 for global frames. Accept the
      // usual Node-RED boolean spellings ("true"/1/"yes") at runtime.
      const useInt = toBool(firstDefined(msg.command_int, incoming.command_int, node.sendAs === 'int'), false);

      let fields;
      let messageName;
      if (useInt) {
        messageName = 'COMMAND_INT';
        // Positional input priority: raw x/y (wire values) > lat/lon degrees >
        // editor-saved param5/6 (degrees, COMMAND_LONG convention) > 0. A value
        // that fails numeric conversion must error, not silently become 0,0.
        const latDeg = firstDefined(incoming.lat, configParams.param5);
        const lonDeg = firstDefined(incoming.lon, configParams.param6);
        const x = firstDefined(incoming.x, latDeg !== undefined ? Math.round(Number(latDeg) * 1e7) : undefined, 0);
        const y = firstDefined(incoming.y, lonDeg !== undefined ? Math.round(Number(lonDeg) * 1e7) : undefined, 0);
        const z = firstDefined(incoming.z, incoming.alt, incoming.param7, configParams.param7, 0);
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || !Number.isFinite(Number(z))) {
          return sendError(msg, send, done, 'BAD_COORDINATES',
            `COMMAND_INT coordinates must be numeric (got x=${x}, y=${y}, z=${z}).`);
        }
        fields = Object.assign(
          {
            frame: firstDefined(incoming.frame, 'MAV_FRAME_GLOBAL'),
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
          fields.x = Math.round(Number(built.param5) * 1e7);
        }
        if (built.param6 !== undefined) {
          fields.y = Math.round(Number(built.param6) * 1e7);
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
        if (incoming[key] !== undefined && built[key] === undefined) {
          fields[key] = incoming[key];
        }
      }

      const targetSystem = firstDefined(incoming.target_system, defaults.defaultTargetSystem, 1);
      const targetComponent = firstDefined(incoming.target_component, defaults.defaultTargetComponent, 1);

      // --- await-ack mode (issue #16): run the command protocol ourselves ----
      if (node.awaitAck) {
        if (!node.connection) {
          return sendError(msg, send, done, 'NO_CONNECTION',
            'Await ack requires a connection to send on (select one in the node config).');
        }
        const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
        let workflow;
        try {
          workflow = new CommandSend({
            connection: node.connection,
            targetSystem,
            targetComponent,
            command: fields.command,
            fields,
            useInt,
            enums: bundle ? bundle.enums : null,
            timeoutMs: node.timeoutMs,
            maxRetries: node.maxRetries,
            onProgress: (p) => node.status({ fill: 'blue', shape: 'dot', text: progressText(p.payload) })
          });
        } catch (err) {
          const e = toMavlinkError(err, 'BAD_COMMAND');
          return sendError(msg, send, done, e.code, e.message, e.context);
        }
        workflow
          .run()
          .then((result) => {
            node.status({ fill: 'green', shape: 'dot', text: `${selected} accepted` });
            msg.topic = result.topic;
            msg.payload = result.payload;
            send(msg);
            done();
          })
          .catch((err) => {
            const e = toMavlinkError(err, 'COMMAND_FAILED');
            node.status({ fill: 'red', shape: 'ring', text: e.code });
            msg.topic = 'mavlink/error';
            msg.payload = errorPayload({
              node: 'mavlink-ai-command',
              connection: node.connection.name,
              code: e.code,
              message: e.message,
              context: e.context
            });
            send(msg);
            done(err);
          });
        return;
      }

      // --- build-only mode (default): hand off to mavlink-ai-out -------------
      msg.topic = 'mavlink/send';
      msg.payload = {
        name: messageName,
        profile: node.profile && node.profile.name,
        target_system: targetSystem,
        target_component: targetComponent,
        fields
      };

      node.status({ fill: 'green', shape: 'dot', text: selected });
      send(msg);
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
