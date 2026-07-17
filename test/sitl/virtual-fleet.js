'use strict';

const dgram = require('dgram');
const { EventEmitter } = require('events');

const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { LinkState } = require('../../lib/protocol/link-state');
const { globalToNedOffset, nedOffsetToGlobal, offsetLatLon } = require('../../lib/swarm/coordinate-frames');

/**
 * A lightweight, dependency-free multi-drone MAVLink SITL.
 *
 * This is NOT a flight-dynamics simulator. It is a fleet of virtual vehicles
 * that speak the real MAVLink wire format (encoded through the same codec the
 * driver ships) over a real UDP socket, each with a distinct system id. Every
 * drone answers ARM / TAKEOFF / DO_REPOSITION with a COMMAND_ACK and then flies
 * a straight, constant-speed line toward its commanded position, streaming
 * HEARTBEAT and GLOBAL_POSITION_INT the whole time.
 *
 * Why it exists: a full PX4/ArduPilot Docker SITL is heavy, slow to boot, and
 * flaky under CI (GPS lock, EKF convergence, image pulls). This gives a
 * deterministic fleet that exercises discovery, routing, command/ack
 * correlation, and — crucially — inter-drone spatial separation, so a
 * coordinated-maneuver example can be regression-tested in seconds without a
 * container. The same engine drives the CI test, the `run-fleet.js` CLI, and
 * the Docker image, so the three never drift.
 *
 * Coordinates are WGS84 float degrees for lat/lon and meters AMSL for altitude,
 * converted to/from the MAVLink degE7 / millimeter wire scalings at the edges.
 * Separation is measured with the same flat-earth helper the fan-out node uses,
 * so "10 m apart" means the same thing here and in a real formation.
 */

// MAV_CMD ids this fleet acts on. Everything else is ACK'd as UNSUPPORTED so a
// flow never hangs waiting on an ack that will not come.
const MAV_CMD_NAV_TAKEOFF = 22;
const MAV_CMD_DO_REPOSITION = 192;
const MAV_CMD_COMPONENT_ARM_DISARM = 400;

// MAV_RESULT
const MAV_RESULT_ACCEPTED = 0;
const MAV_RESULT_UNSUPPORTED = 3;
const MAV_RESULT_DENIED = 2;

// MAV_MODE_FLAG_SAFETY_ARMED — the one base_mode bit a GCS reads to know a
// vehicle is armed.
const MODE_FLAG_ARMED = 128;

// COMMAND_INT "keep current x/y" sentinel; COMMAND_LONG uses NaN in param5/6.
const INT32_MAX = 2147483647;

/**
 * A decoded scalar is JSON-safe: non-finite floats arrive as the strings
 * "NaN"/"Infinity". Treat those, and the COMMAND_INT INT32_MAX sentinel, as
 * "field not supplied" so "hold current lat/lon/alt" works.
 *
 * @param {*} raw          decoded field value
 * @param {number} scale   divide the numeric value by this (1e7 for degE7, 1 for meters)
 * @param {boolean} [intSentinel=false]  also treat INT32_MAX as unset (COMMAND_INT x/y)
 * @returns {?number} the scaled number, or null when the field means "keep current"
 */
function coord(raw, scale, intSentinel = false) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === 'string') {
    // "NaN"/"Infinity" sentinels, or a numeric string.
    if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) {
      return null;
    }
    raw = Number(raw);
  }
  if (!Number.isFinite(raw)) {
    return null;
  }
  if (intSentinel && raw === INT32_MAX) {
    return null;
  }
  return raw / scale;
}

/**
 * Require an integer within [min, max], throwing a clear config error otherwise.
 * Fleet sizing and identifiers are validated up front so a bad value fails at
 * construction rather than surfacing later as a busy-loop timer or an opaque
 * encode failure.
 *
 * @param {*} value
 * @param {string} name
 * @param {number} min  inclusive
 * @param {number} max  inclusive
 * @returns {number}
 */
function requireIntInRange(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RangeError(`virtual-fleet: ${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(value)}).`);
  }
  return n;
}

/**
 * Require a finite number strictly greater than zero.
 *
 * @param {*} value
 * @param {string} name
 * @returns {number}
 */
function requirePositive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`virtual-fleet: ${name} must be a positive finite number (got ${JSON.stringify(value)}).`);
  }
  return n;
}

/**
 * One virtual vehicle. Owns its identity, its motion state, and its own
 * LinkState so its outbound frames carry a monotone per-system sequence.
 */
class VirtualDrone {
  /**
   * @param {object} opts
   * @param {number} opts.sysid           system id (unique across the fleet)
   * @param {number} [opts.compid=1]       autopilot component id
   * @param {MavlinkCodec} opts.codec      shared, dialect-scoped codec
   * @param {{lat:number, lon:number, alt:number}} opts.home  start position
   * @param {number} [opts.speed=5]        horizontal cruise, m/s
   * @param {number} [opts.climbRate=3]    vertical rate, m/s
   */
  constructor(opts) {
    this.sysid = requireIntInRange(opts.sysid, 'sysid', 1, 255);
    this.compid = requireIntInRange(opts.compid || 1, 'compid', 1, 255);
    this.codec = opts.codec;
    this.link = new LinkState();
    this.speed = requirePositive(opts.speed || 5, 'speed');
    this.climbRate = requirePositive(opts.climbRate || 3, 'climbRate');

    this.home = { ...opts.home };
    this.pos = { ...opts.home };
    this.target = null; // {lat, lon, alt} while flying to a setpoint
    this.armed = false;
    this.bootMs = 0;
  }

  /**
   * Serialize a message from this drone. Enum names are fine — the codec
   * resolves them against the active dialect.
   *
   * @param {string} name
   * @param {object} fields
   * @returns {Buffer}
   */
  encode(name, fields) {
    return this.codec.encode(name, fields, {
      sysid: this.sysid,
      compid: this.compid,
      link: this.link
    });
  }

  /** HEARTBEAT reflecting the current armed state. */
  encodeHeartbeat() {
    return this.encode('HEARTBEAT', {
      type: 'MAV_TYPE_QUADROTOR',
      autopilot: 'MAV_AUTOPILOT_ARDUPILOTMEGA',
      base_mode: this.armed ? MODE_FLAG_ARMED : 0,
      custom_mode: 0,
      system_status: 'MAV_STATE_ACTIVE'
    });
  }

  /** GLOBAL_POSITION_INT at the current position (velocity fields left zero). */
  encodePosition() {
    return this.encode('GLOBAL_POSITION_INT', {
      time_boot_ms: this.bootMs,
      lat: Math.round(this.pos.lat * 1e7),
      lon: Math.round(this.pos.lon * 1e7),
      alt: Math.round(this.pos.alt * 1000), // mm AMSL
      relative_alt: Math.round((this.pos.alt - this.home.alt) * 1000),
      vx: 0,
      vy: 0,
      vz: 0,
      hdg: 0
    });
  }

  /**
   * COMMAND_ACK for a command this drone just processed, addressed back at the
   * exact GCS system/component that sent the command — a real autopilot echoes
   * the sender's ids, and a GCS on a non-190 component would otherwise miss its
   * own ack.
   *
   * @param {number} command       the MAV_CMD being acked
   * @param {number} result        MAV_RESULT
   * @param {number} targetSysid   the command sender's system id
   * @param {number} targetCompid  the command sender's component id
   * @returns {Buffer}
   */
  encodeAck(command, result, targetSysid, targetCompid) {
    return this.encode('COMMAND_ACK', {
      command,
      result,
      target_system: targetSysid || 255,
      target_component: targetCompid !== undefined ? targetCompid : 190
    });
  }

  /**
   * Apply an inbound command, mutating motion state. Returns the MAV_RESULT to
   * ack with.
   *
   * @param {string} name    message name (COMMAND_INT or COMMAND_LONG)
   * @param {object} f       decoded fields
   * @returns {number} MAV_RESULT
   */
  handleCommand(name, f) {
    const command = Number(f.command);
    if (command === MAV_CMD_COMPONENT_ARM_DISARM) {
      this.armed = Number(f.param1) === 1;
      if (!this.armed) {
        this.target = null;
      }
      return MAV_RESULT_ACCEPTED;
    }

    if (command === MAV_CMD_NAV_TAKEOFF) {
      if (!this.armed) {
        return MAV_RESULT_DENIED; // won't take off disarmed
      }
      // Relative takeoff altitude rides param7 (COMMAND_LONG) or z (COMMAND_INT).
      const relAlt = name === 'COMMAND_INT' ? coord(f.z, 1) : coord(f.param7, 1);
      this.target = {
        lat: this.pos.lat,
        lon: this.pos.lon,
        alt: this.home.alt + (relAlt !== null ? relAlt : 0)
      };
      return MAV_RESULT_ACCEPTED;
    }

    if (command === MAV_CMD_DO_REPOSITION) {
      if (!this.armed) {
        return MAV_RESULT_DENIED;
      }
      let lat;
      let lon;
      let alt;
      if (name === 'COMMAND_INT') {
        lat = coord(f.x, 1e7, true);
        lon = coord(f.y, 1e7, true);
        alt = coord(f.z, 1);
      } else {
        // COMMAND_LONG carries position in param5/6/7 as float degrees/meters.
        lat = coord(f.param5, 1);
        lon = coord(f.param6, 1);
        alt = coord(f.param7, 1);
      }
      this.target = {
        lat: lat !== null ? lat : this.pos.lat,
        lon: lon !== null ? lon : this.pos.lon,
        alt: alt !== null ? alt : this.pos.alt
      };
      return MAV_RESULT_ACCEPTED;
    }

    return MAV_RESULT_UNSUPPORTED;
  }

  /**
   * Advance motion by `dt` seconds toward the active target along a straight
   * line, capped by horizontal speed and climb rate. No target ⇒ station-keep.
   *
   * @param {number} dt  seconds
   */
  step(dt) {
    this.bootMs += Math.round(dt * 1000);
    if (!this.target) {
      return;
    }
    const off = globalToNedOffset(this.pos, this.target); // meters {north,east,down}
    const horiz = Math.hypot(off.north, off.east);
    const maxHoriz = this.speed * dt;
    if (horiz <= maxHoriz) {
      this.pos.lat = this.target.lat;
      this.pos.lon = this.target.lon;
    } else {
      const frac = maxHoriz / horiz;
      // Move a fraction of the way; recompute lat/lon from the partial offset.
      const partial = nedOffsetToGlobal(this.pos, {
        north: off.north * frac,
        east: off.east * frac
      });
      this.pos.lat = partial.lat;
      this.pos.lon = partial.lon;
    }
    // Vertical: down is positive, altitude is up, so climb toward target alt.
    const dAlt = this.target.alt - this.pos.alt;
    const maxClimb = this.climbRate * dt;
    this.pos.alt += Math.abs(dAlt) <= maxClimb ? dAlt : Math.sign(dAlt) * maxClimb;
  }
}

/**
 * A fleet of {@link VirtualDrone}s sharing one UDP socket. The socket sends all
 * traffic to a single GCS endpoint (a `udp-peer` connection, or a router that
 * fans out to one). Inbound commands are dispatched to the addressed drone by
 * `target_system`; a broadcast (0) reaches every drone.
 */
class VirtualFleet extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.count=3]        number of drones
   * @param {number} [opts.baseSysid=1]    first system id; drones are base..base+count-1
   * @param {string} [opts.dialect='ardupilotmega']
   * @param {{lat:number, lon:number, alt:number}} [opts.origin]  fleet start point
   * @param {number} [opts.spacingM=0]     initial east spacing between drones, meters
   * @param {number} [opts.telemetryHz=5]  position rate
   * @param {number} [opts.heartbeatHz=1]  heartbeat rate
   * @param {number} [opts.speed]          per-drone cruise m/s
   */
  constructor(opts = {}) {
    super();
    this.dialect = opts.dialect || 'ardupilotmega';
    const bundle = loadDialect(this.dialect);
    this.codec = new MavlinkCodec({ bundle, version: 'v2' });

    const count = requireIntInRange(opts.count !== undefined ? opts.count : 3, 'count', 1, 255);
    const baseSysid = requireIntInRange(opts.baseSysid !== undefined ? opts.baseSysid : 1, 'baseSysid', 1, 255);
    if (baseSysid + count - 1 > 255) {
      throw new RangeError(
        `virtual-fleet: baseSysid ${baseSysid} + count ${count} exceeds the 255 system-id ceiling.`
      );
    }
    const origin = opts.origin || { lat: 39.1, lon: -75.1, alt: 40 };
    const spacingM = opts.spacingM || 0;

    this.telemetryHz = requirePositive(opts.telemetryHz || 5, 'telemetryHz');
    this.heartbeatHz = requirePositive(opts.heartbeatHz || 1, 'heartbeatHz');
    this.minSeparationSeen = Infinity;

    this.drones = [];
    for (let i = 0; i < count; i += 1) {
      const sysid = baseSysid + i;
      // Space drones by their *absolute* system id, not the local loop index, so
      // the one-container-per-drone Docker path (each process count=1) still puts
      // every drone at a distinct start position instead of collocating them.
      const home = spacingM
        ? { ...offsetLatLon(origin, { east: (sysid - 1) * spacingM }), alt: origin.alt }
        : { ...origin };
      this.drones.push(new VirtualDrone({ sysid, codec: this.codec, home, speed: opts.speed }));
    }
    this.byId = new Map(this.drones.map((d) => [d.sysid, d]));

    this.sock = null;
    this.gcs = null; // {host, port} learned or configured
    this._timers = [];
    this._decoder = this.codec.createDecoder(
      (packet) => this._onPacket(packet),
      (err) => this.emit('decodeError', err)
    );
  }

  /**
   * Bind the socket and start telemetry. If `gcsPort` is given the fleet sends
   * there immediately; otherwise it waits to learn the GCS endpoint from the
   * first inbound datagram (useful when the GCS also binds ephemerally).
   *
   * @param {object} [opts]
   * @param {string} [opts.gcsHost='127.0.0.1']
   * @param {number} [opts.gcsPort]   the GCS's udp-peer port to stream to
   * @param {string} [opts.bindAddress='0.0.0.0']
   * @param {number} [opts.bindPort=0] fleet socket port (0 = ephemeral)
   * @returns {Promise<{port:number}>}
   */
  start(opts = {}) {
    if (opts.gcsPort) {
      this.gcs = { host: opts.gcsHost || '127.0.0.1', port: opts.gcsPort };
    }
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (buf, rinfo) => {
      // Learn the GCS endpoint from whoever talks to us first.
      if (!this.gcs) {
        this.gcs = { host: rinfo.address, port: rinfo.port };
      }
      this._decoder.write(buf);
    });

    return new Promise((resolve, reject) => {
      // A bind failure (port in use, permission) must reject start() rather than
      // leave the promise pending or crash on an unheard 'error' event. Swap the
      // temporary bind-error listener for the runtime forwarder only once bound.
      const onBindError = (err) => reject(err);
      this.sock.once('error', onBindError);
      this.sock.bind(opts.bindPort || 0, opts.bindAddress || '0.0.0.0', () => {
        this.sock.removeListener('error', onBindError);
        this.sock.on('error', (err) => this.emit('error', err));
        const port = this.sock.address().port;
        this._startTelemetry();
        this.emit('listening', { port });
        resolve({ port });
      });
    });
  }

  /** Wire up the heartbeat, telemetry, and physics timers. */
  _startTelemetry() {
    const posMs = Math.round(1000 / this.telemetryHz);
    const hbMs = Math.round(1000 / this.heartbeatHz);
    let last = Date.now();

    // Sample the initial (t=0) state so a starting overlap is recorded before
    // any drone moves. Per-tick sampling below then captures each interval's
    // endpoints; at the telemetry rates used here dt·v_rel stays well under the
    // separation floor, so endpoint sampling tracks the closest approach closely
    // enough for the collision assertion (this is a lightweight sim, not a
    // continuous-time swept-volume solver).
    this._sampleSeparation();
    this._timers.push(
      setInterval(() => {
        const now = Date.now();
        const dt = (now - last) / 1000;
        last = now;
        for (const d of this.drones) {
          d.step(dt);
        }
        this._sampleSeparation();
        for (const d of this.drones) {
          this._sendFrom(d, d.encodePosition());
        }
      }, posMs)
    );
    this._timers.push(
      setInterval(() => {
        for (const d of this.drones) {
          this._sendFrom(d, d.encodeHeartbeat());
        }
      }, hbMs)
    );
    // Keep timers from holding the process open when embedded in a test.
    for (const t of this._timers) {
      if (t.unref) {
        t.unref();
      }
    }
  }

  /** Send a drone's frame to the GCS endpoint (no-op until one is known). */
  _sendFrom(drone, buf) {
    if (!this.gcs || !this.sock) {
      return;
    }
    this.sock.send(buf, this.gcs.port, this.gcs.host);
  }

  /** Decode an inbound frame and dispatch any command to the addressed drone. */
  _onPacket(packet) {
    const msg = this.codec.decode(packet, {});
    if (!msg) {
      return;
    }
    if (msg.name !== 'COMMAND_INT' && msg.name !== 'COMMAND_LONG') {
      return; // fleet only reacts to commands; other inbound is ignored
    }
    const targetSys = Number(msg.fields.target_system);
    const senderSys = msg.sysid;
    const senderComp = msg.compid;
    const targets = targetSys === 0 ? this.drones : [this.byId.get(targetSys)].filter(Boolean);
    for (const d of targets) {
      const result = d.handleCommand(msg.name, msg.fields);
      this._sendFrom(d, d.encodeAck(Number(msg.fields.command), result, senderSys, senderComp));
      this.emit('command', { sysid: d.sysid, command: Number(msg.fields.command), result });
    }
  }

  /**
   * Record the closest pair of drones this instant. The running minimum
   * (`minSeparationSeen`) is the collision-avoidance assertion surface: a
   * coordinated maneuver is safe iff this never drops below the fleet's
   * required separation.
   */
  _sampleSeparation() {
    let min = Infinity;
    for (let i = 0; i < this.drones.length; i += 1) {
      for (let j = i + 1; j < this.drones.length; j += 1) {
        min = Math.min(min, this.separationBetween(this.drones[i], this.drones[j]));
      }
    }
    if (min < this.minSeparationSeen) {
      this.minSeparationSeen = min;
    }
    return min;
  }

  /** 3-D distance in meters between two drones. */
  separationBetween(a, b) {
    const off = globalToNedOffset(a.pos, b.pos);
    return Math.hypot(off.north, off.east, off.down);
  }

  /** The closest current pairwise separation, meters (Infinity for <2 drones). */
  currentMinSeparation() {
    return this._sampleSeparation();
  }

  /** Snapshot of every drone's live state (for tests / status displays). */
  snapshot() {
    return this.drones.map((d) => ({
      sysid: d.sysid,
      armed: d.armed,
      pos: { ...d.pos },
      target: d.target ? { ...d.target } : null
    }));
  }

  /** Stop timers and close the socket. */
  async stop() {
    for (const t of this._timers) {
      clearInterval(t);
    }
    this._timers = [];
    if (this._decoder) {
      this._decoder.destroy();
    }
    if (this.sock) {
      await new Promise((resolve) => this.sock.close(resolve));
      this.sock = null;
    }
  }
}

module.exports = { VirtualFleet, VirtualDrone, coord };
