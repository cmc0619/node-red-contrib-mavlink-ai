'use strict';

const { errorPayload } = require('../lib/util/errors');
const { firstDefined } = require('../lib/util/validation');
const { registerEditorApi } = require('../lib/editor-api');

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
    node.command = config.command || 'arm';

    // Static param values for a raw MAV_CMD selection (written by the editor).
    let configParams = {};
    if (config.fields) {
      try {
        configParams = JSON.parse(config.fields);
      } catch (e) {
        node.warn(`mavlink-ai-command: invalid fields JSON, ignoring (${e.message})`);
      }
    }

    node.on('input', (msg, send, done) => {
      const incoming = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const selected = msg.command || incoming.command || node.command;
      const builder = COMMANDS[selected];

      // Presets use their builder; anything shaped like a MAV_CMD (enum name or
      // number) is sent as a raw COMMAND_LONG with the given params.
      let built;
      if (builder) {
        built = builder(incoming);
      } else if (isRawCommand(selected)) {
        built = { command: selected };
      } else {
        node.status({ fill: 'red', shape: 'ring', text: 'unknown command' });
        msg.topic = 'mavlink/error';
        msg.payload = errorPayload({
          node: 'mavlink-ai-command',
          code: 'UNKNOWN_COMMAND',
          message: `Unknown command '${selected}'. Use a preset (${Object.keys(COMMANDS).join(', ')}) or a MAV_CMD_* name.`
        });
        send(msg);
        return done();
      }

      if (!node.profile) {
        node.status({ fill: 'red', shape: 'ring', text: 'missing profile' });
        msg.topic = 'mavlink/error';
        msg.payload = errorPayload({
          node: 'mavlink-ai-command',
          code: 'MISSING_PROFILE',
          message: 'Command node has no profile configured (deleted or disabled config node?).'
        });
        send(msg);
        return done();
      }

      const defaults = node.profile.getDefaults ? node.profile.getDefaults() : {};

      // Base zeros, then static config params (raw MAV_CMD mode), then the
      // builder output (preset semantics win over config params).
      const fields = Object.assign(
        { confirmation: 0, param1: 0, param2: 0, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 },
        configParams,
        built
      );
      // Allow explicit param overrides from the incoming payload, but never
      // clobber a param the builder set on purpose (e.g. arm/disarm param1),
      // so an incoming override can't silently flip command semantics.
      for (let i = 1; i <= 7; i += 1) {
        const key = `param${i}`;
        if (incoming[key] !== undefined && built[key] === undefined) {
          fields[key] = incoming[key];
        }
      }

      msg.topic = 'mavlink/send';
      msg.payload = {
        name: 'COMMAND_LONG',
        profile: node.profile && node.profile.name,
        target_system: firstDefined(incoming.target_system, defaults.defaultTargetSystem, 1),
        target_component: firstDefined(incoming.target_component, defaults.defaultTargetComponent, 1),
        fields
      };

      node.status({ fill: 'green', shape: 'dot', text: selected });
      send(msg);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-command', MavlinkAiCommandNode);
};
