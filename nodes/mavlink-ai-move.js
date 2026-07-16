'use strict';

const { buildSetpoint, setpointWarnings } = require('../lib/move/setpoint');
const { toNum, toBool, firstDefined } = require('../lib/util/validation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { validateTargetSystem, validateTargetComponent } = require('../lib/util/field-validation');
const { watchProfileBadge } = require('../lib/util/node-lifecycle');
const { PRIORITY } = require('../lib/runtime/send-priority');

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
    /** Optional continuous streaming (#128): resend the setpoint at a fixed rate. */
    node.stream = toBool(config.stream, false);
    node.streamRateHz = clampStreamRate(Number(config.streamRateHz));
    node._streamTimer = null;
    node._streamState = null;
    node._streamErrored = false;
    /** True while a streamed setpoint send is in flight, so ticks don't pile up. */
    node._streamSending = false;
    /**
     * Bumped by stopStream. A send captures the current generation and, on
     * settle, ignores its result if the generation moved on — so a stop
     * (stream:false / dep redeploy / close) that lands while a send is pending
     * can't later flip the status to error or emit a stale `mavlink/error`
     * (possibly from an already-closed node).
     */
    node._streamGen = 0;

    /**
     * Stop-on-redeploy guard for the config-only case (#128): when the referenced
     * Profile/Connection config node is edited or deleted, Node-RED leaves this
     * node in place and fires `flows:started` (which watchProfileBadge uses to
     * re-resolve refs) — but never `close`. A running setpoint stream would
     * otherwise keep commanding the vehicle with the old `_streamState` and a
     * possibly-destroyed connection.
     *
     * The stop is gated on one of *this* node's referenced config nodes actually
     * changing identity — an unrelated deploy (another tab/node, no change to
     * this node's Profile/Connection) must NOT stop an active stream, or the
     * vehicle could drop out of OFFBOARD. The connection ref is refreshed here so
     * a redeployed connection is picked up. The listener is removed on close.
     */
    if (RED.events && typeof RED.events.on === 'function') {
      let lastProfile = node.profile;
      let lastConnection = node.connection;
      const stopStreamIfDepsChanged = function stopStreamIfDepsChanged() {
        const curProfile = RED.nodes.getNode(config.profile);
        const curConnection = config.connection ? RED.nodes.getNode(config.connection) : null;
        const changed = curProfile !== lastProfile || curConnection !== lastConnection;
        lastProfile = curProfile;
        lastConnection = curConnection;
        node.connection = curConnection;
        if (changed) {
          stopStream(node);
        }
      };
      RED.events.on('flows:started', stopStreamIfDepsChanged);
      node.on('close', function removeRedeployGuard() {
        RED.events.removeListener('flows:started', stopStreamIfDepsChanged);
      });
    }

    node.on('input', async (msg, send, done) => {
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      /**
       * Tri-state stream override carried on the message: true / false when the
       * flag is present, undefined when the message omits it. The value is
       * coerced through toBool so a string `'false'`/`'0'` (from a Change / HTTP
       * / MQTT path) still counts — a strict `=== false` check would let those
       * fall through and silently leave a running stream commanding the vehicle.
       */
      const hasStreamFlag = payload.stream !== undefined && payload.stream !== null && payload.stream !== '';
      const streamOverride = hasStreamFlag ? toBool(payload.stream, false) : undefined;

      /** An explicit `stream: false` stops a running stream and sends nothing. */
      if (streamOverride === false) {
        const wasStreaming = !!node._streamTimer;
        stopStream(node);
        node.status(wasStreaming ? { fill: 'grey', shape: 'ring', text: 'stream stopped' } : {});
        return done();
      }

      if (!node.profile || !node.profile.isValid || !node.profile.isValid()) {
        return finishError(node, msg, send, done, errorPayload({
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
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-move',
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      const frameName = firstDefined(payload.frame, node.frame);
      let built;
      try {
        built = buildSetpoint({
          coordinate: firstDefined(payload.coordinate, node.coordinate),
          preset: firstDefined(payload.preset, node.preset),
          typeMask: firstDefined(payload.type_mask, node.typeMask),
          frame: frameName,
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
        return finishError(node, msg, send, done, errorPayload({
          node: 'mavlink-ai-move',
          code: e.code,
          message: e.message,
          context: e.context
        }));
      }

      /**
       * Advisory per-firmware checks (#128): a mask/frame combination the
       * profile's firmware won't honor fails silently on the vehicle, so surface
       * it via node.warn. Deduplicated per warning-set so a fast refresh loop
       * feeding a stream can't spam the log at its input rate.
       */
      const warnings = setpointWarnings({
        firmware: defaults.firmware,
        typeMask: built.fields.type_mask,
        frameName
      });
      const warnKey = warnings.join('|');
      if (warnKey && warnKey !== node._lastWarnKey) {
        for (const warning of warnings) {
          node.warn(warning);
        }
      }
      node._lastWarnKey = warnKey;

      /**
       * Streaming mode (#128): resend this setpoint continuously at the node
       * rate until stopped. Each input refreshes the streamed setpoint. Requires
       * a Connection (there is nowhere to stream a build-only message to), and
       * the stream is torn down on redeploy/close so a partial deploy can never
       * leave a setpoint stream flying the vehicle.
       */
      const streaming =
        streamOverride === true || (streamOverride === undefined && (node.stream || !!node._streamTimer));
      if (streaming) {
        if (!node.connection) {
          return finishError(node, msg, send, done, errorPayload({
            node: 'mavlink-ai-move',
            code: 'STREAM_NEEDS_CONNECTION',
            message: 'Streaming requires a Connection to send setpoints continuously.'
          }));
        }
        /**
         * PX4 drops out of OFFBOARD after ~0.5 s without a fresh setpoint, so a
         * sub-2 Hz stream keeps the mode only nominally alive. Advisory (other
         * stacks have no such floor), surfaced once per deploy like the
         * per-firmware setpoint advisories above.
         */
        if (defaults.firmware === 'px4' && node.streamRateHz < 2 && !node._warnedPx4StreamRate) {
          node._warnedPx4StreamRate = true;
          node.warn(
            `Stream rate ${node.streamRateHz} Hz is below PX4's ~2 Hz OFFBOARD keep-alive; PX4 will drop OFFBOARD between setpoints.`
          );
        }
        node._streamState = {
          name: built.name,
          vehicleProfile: node.profile.id,
          localIdentity: payload.localIdentity,
          fields: built.fields
        };
        startStream(node);
        node.status({ fill: 'green', shape: 'dot', text: `streaming ${labelFor(built.name)} @ ${node.streamRateHz} Hz` });
        return done();
      }

      /**
       * One-shot: with a connection the node is the sender (setpoints are
       * fire-and-forget, so there is no ack to await); without one it hands the
       * built message to a downstream mavlink-ai-out node. The connection is
       * captured before the await — the flows:started redeploy guard can null or
       * replace `node.connection` while the send is in flight, and the catch
       * path must still name the connection it actually sent on rather than
       * throw a TypeError that leaves done() uncalled.
       */
      const connection = node.connection;
      if (connection) {
        try {
          /** Setpoints ride the ELEVATED band (#241): their cadence keeps
           * OFFBOARD/GUIDED alive, so they must not sit behind bulk traffic. */
          await connection.send(
            {
              name: built.name,
              vehicleProfile: node.profile.id,
              localIdentity: payload.localIdentity,
              fields: built.fields
            },
            { msg, priority: PRIORITY.ELEVATED }
          );
          node.status({ fill: 'green', shape: 'dot', text: `sent ${labelFor(built.name)}` });
          return done();
        } catch (err) {
          const e = toMavlinkError(err, 'SEND_FAILED');
          node.status({ fill: 'red', shape: 'ring', text: e.code });
          return finishError(node, msg, send, done, errorPayload({
            node: 'mavlink-ai-move',
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
      /** All Move setpoints ride the ELEVATED band (#241) — stamp the
       * build-only output too, so Move -> mavlink-ai-out keeps the same band
       * as a direct-Connection send. */
      msg.priority = PRIORITY.ELEVATED;
      node.status({ fill: 'green', shape: 'dot', text: labelFor(built.name) });
      send(msg);
      done();
    });

    /**
     * Stop-on-deploy/close guard (#128): a redeploy or flow stop must never
     * leave a setpoint stream running — that would keep commanding the vehicle
     * with no node in control. Tear the timer down synchronously on close.
     */
    node.on('close', function closeMove(done) {
      stopStream(node);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-move', MavlinkAiMoveNode);
};

/** Streaming rate bounds. PX4 OFFBOARD needs >= ~2 Hz; cap the top end so a bad
 * rate can't spin a tight send loop. */
const DEFAULT_STREAM_RATE_HZ = 5;
const MIN_STREAM_RATE_HZ = 0.2;
const MAX_STREAM_RATE_HZ = 50;

/**
 * Clamp a configured stream rate into the supported band, defaulting a
 * missing/invalid value.
 *
 * @param {number} hz
 * @returns {number}
 */
function clampStreamRate(hz) {
  if (!Number.isFinite(hz) || hz <= 0) {
    return DEFAULT_STREAM_RATE_HZ;
  }
  return Math.min(MAX_STREAM_RATE_HZ, Math.max(MIN_STREAM_RATE_HZ, hz));
}

/**
 * Send the currently streamed setpoint once. Best-effort: a transient send
 * failure (e.g. no learned UDP peer yet) surfaces once per failure streak and
 * keeps the stream running so it recovers on its own, rather than flooding the
 * error output at the stream rate or tearing the stream down.
 *
 * @param {object} node
 * @returns {void}
 */
function streamTick(node) {
  const s = node._streamState;
  /**
   * Skip this tick while a previous send is still in flight. On a transport
   * slower than the stream rate (serial/TCP backpressure) unconditional sends
   * would pile stale setpoints into the shared outbound queue, and the close
   * guard — which only stops future ticks — could then drain that backlog after
   * the node is gone. One in-flight send at a time keeps stopStream authoritative.
   */
  if (!s || !node.connection || node._streamSending) {
    return;
  }
  node._streamSending = true;
  /**
   * Capture the connection and stream generation at send time. If the stream is
   * stopped (stream:false / dep redeploy / close all bump `_streamGen` via
   * stopStream) while this send is pending, its settle is stale — skip the
   * status/error update so a stop can't surface a false failure or emit from an
   * already-torn-down node.
   */
  const connection = node.connection;
  const gen = node._streamGen;
  connection
    .send({ name: s.name, vehicleProfile: s.vehicleProfile, localIdentity: s.localIdentity, fields: s.fields }, { priority: PRIORITY.ELEVATED })
    .then(() => {
      if (node._streamGen !== gen) {
        return;
      }
      if (node._streamErrored) {
        node._streamErrored = false;
        node.status({ fill: 'green', shape: 'dot', text: `streaming @ ${node.streamRateHz} Hz` });
      }
    })
    .catch((err) => {
      if (node._streamGen !== gen) {
        return;
      }
      const e = toMavlinkError(err, 'SEND_FAILED');
      node.status({ fill: 'yellow', shape: 'ring', text: `stream: ${e.code}` });
      if (!node._streamErrored) {
        node._streamErrored = true;
        node.send({
          topic: 'mavlink/error',
          payload: errorPayload({
            node: 'mavlink-ai-move',
            connection: connection.name,
            code: e.code,
            message: e.message,
            context: e.context
          })
        });
      }
    })
    .finally(() => {
      /** Only the current generation owns `_streamSending`; a stale send that
       * outlived a stop must not clear a fresh stream's in-flight flag. */
      if (node._streamGen === gen) {
        node._streamSending = false;
      }
    });
}

/**
 * Ensure the repeat timer is running for the streamed setpoint. Only the initial
 * start forces an immediate send; a refresh on an already-running stream just
 * updates `_streamState` (done by the caller) and lets the next scheduled tick
 * pick it up, so a burst of inputs can't outrun the configured rate. The timer
 * is unref'd so it never holds the process open.
 *
 * @param {object} node
 * @returns {void}
 */
function startStream(node) {
  if (node._streamTimer) {
    return;
  }
  streamTick(node);
  node._streamTimer = setInterval(() => streamTick(node), Math.round(1000 / node.streamRateHz));
  if (typeof node._streamTimer.unref === 'function') {
    node._streamTimer.unref();
  }
}

/**
 * Stop any running setpoint stream and clear its state.
 *
 * @param {object} node
 * @returns {void}
 */
function stopStream(node) {
  if (node._streamTimer) {
    clearInterval(node._streamTimer);
    node._streamTimer = null;
  }
  node._streamState = null;
  node._streamErrored = false;
  node._streamSending = false;
  /** Invalidate any in-flight send's settle so it can't report after the stop. */
  node._streamGen = (node._streamGen || 0) + 1;
}

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
