'use strict';

const enumResolver = require('../protocol/enum-resolver');
const { coreEnumValues } = require('../protocol/protocol-values');
const { MavlinkError } = require('../util/errors');
const { degE7ToDeg } = require('../util/geo');
const { modeNameForCustomMode } = require('../command/flight-modes');

/**
 * Swarm vehicle registry (issue #46): tracks the active MAVLink systems seen on
 * a connection from their HEARTBEAT (plus position/status messages), with stale
 * marking, expiry, filtering, and named groups. Pure state — the
 * mavlink-ai-swarm node owns the connection subscription and feeds decoded
 * §14.1 payloads into {@link VehicleRegistry#ingest}.
 *
 * Vehicles are keyed per (sysid, compid) pair: a swarm is not only aircraft —
 * cameras, gimbals, rovers, and boats all heartbeat too, and one system can
 * carry several heartbeating components.
 */

// Named classifications remain package policy; their MAVLink numbers are
// resolved from the active dialect when a registry is constructed.
const TYPE_FAMILY_MEMBERS = {
  FIXED_WING: 'plane',
  QUADROTOR: 'copter',
  COAXIAL: 'copter',
  HELICOPTER: 'copter',
  ANTENNA_TRACKER: 'antenna-tracker',
  GROUND_ROVER: 'rover',
  SURFACE_BOAT: 'boat',
  SUBMARINE: 'sub',
  HEXAROTOR: 'copter',
  OCTOROTOR: 'copter',
  TRICOPTER: 'copter',
  /**
   * VTOL variants fly ArduPlane (QuadPlane), so they name modes from the plane
   * table; PX4 ignores the vehicle type for mode naming either way.
   */
  VTOL_TAILSITTER_DUOROTOR: 'plane',
  VTOL_TAILSITTER_QUADROTOR: 'plane',
  VTOL_TILTROTOR: 'plane',
  VTOL_FIXEDROTOR: 'plane',
  VTOL_TAILSITTER: 'plane',
  VTOL_TILTWING: 'plane',
  VTOL_RESERVED5: 'plane',
  DODECAROTOR: 'copter',
  DECAROTOR: 'copter'
};

/**
 * Normalize a sysids filter into a numeric array: an array of ids, a single
 * id, or a comma-separated string ("1,2,3"). Anything else throws — silently
 * ignoring a malformed sysids filter would widen the selection to *every*
 * vehicle, which is far worse than failing for a node that feeds fan-out.
 *
 * @param {*} value
 * @returns {number[]}
 * @throws {MavlinkError} BAD_FILTER
 */
function normalizeSysids(value) {
  const bad = () =>
    new MavlinkError('BAD_FILTER', `Filter 'sysids' must be an array of ids, a single id, or a comma-separated string (got ${JSON.stringify(value)}).`, {
      sysids: value
    });
  let list;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'number') {
    list = [value];
  } else if (typeof value === 'string') {
    list = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  } else {
    throw bad();
  }
  const out = list.map(Number);
  if (!out.length || out.some((n) => !Number.isFinite(n))) {
    throw bad();
  }
  return out;
}

class VehicleRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.staleMs=5000]    no heartbeat for this long -> stale
   * @param {number} [opts.expireMs=30000]  no message for this long -> removed
   *   (0 disables removal; stale vehicles then stay listed until redeploy)
   * @param {object} [opts.enums]           dialect enum index, for readable
   *   MAV_TYPE / MAV_AUTOPILOT / MAV_STATE names
   * @param {string} [opts.dialect]         active dialect name for errors
   * @param {boolean} [opts.includeGcs=false]  track MAV_TYPE_GCS heartbeats too
   * @param {function(): number} [opts.now]  clock override for tests
   */
  constructor(opts = {}) {
    const staleMs = Number(opts.staleMs);
    const expireMs = Number(opts.expireMs);
    this.staleMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : 5000;
    this.expireMs = Number.isFinite(expireMs) && expireMs >= 0 ? expireMs : 30000;
    this.enums = opts.enums || null;
    this.dialect = opts.dialect || 'unknown';
    // Classification values (MavType/MavModeFlag/MavAutopilot) are all common
    // core enums — resolve them from the always-available core bundle so the
    // registry constructs even when the profile has no loaded dialect (#309
    // review). `this.enums` (the profile dialect) is retained only for the
    // dialect-specific flight-mode name lookup in _snapshot.
    const value = coreEnumValues({ consumer: 'vehicle-registry' });
    this.gcsType = value('MavType', 'GCS');
    this.armedFlag = value('MavModeFlag', 'SAFETY_ARMED');
    this.autopilotFirmware = new Map([
      [value('MavAutopilot', 'ARDUPILOTMEGA'), 'ardupilot'],
      [value('MavAutopilot', 'PX4'), 'px4']
    ]);
    this.typeVehicle = new Map(
      Object.entries(TYPE_FAMILY_MEMBERS).map(([member, family]) => [
        value('MavType', member),
        family
      ])
    );
    this.includeGcs = opts.includeGcs === true;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._vehicles = new Map(); // "sysid/compid" -> mutable state
    this._groups = {}; // name -> filter spec
  }

  /**
   * Feed one decoded message payload (§14.1: name/sysid/compid/fields) into
   * the registry.
   *
   * @param {object} payload
   * @returns {{ vehicle: ?object, added: boolean }} the updated vehicle state
   *   (null when the message was ignored) and whether it was first discovery
   */
  ingest(payload) {
    if (!payload || payload.sysid === undefined || payload.compid === undefined) {
      return { vehicle: null, added: false };
    }
    if (payload.name === 'HEARTBEAT' && !this.includeGcs && Number((payload.fields || {}).type) === this.gcsType) {
      return { vehicle: null, added: false };
    }
    const key = `${payload.sysid}/${payload.compid}`;
    let vehicle = this._vehicles.get(key);
    const added = !vehicle;
    if (added) {
      // Only a HEARTBEAT discovers a vehicle: position/status traffic for an
      // unknown source is ignored rather than creating typeless ghosts.
      if (payload.name !== 'HEARTBEAT') {
        return { vehicle: null, added: false };
      }
      vehicle = { sysid: Number(payload.sysid), compid: Number(payload.compid) };
      this._vehicles.set(key, vehicle);
    }

    const f = payload.fields || {};
    switch (payload.name) {
      case 'HEARTBEAT':
        vehicle.type = Number(f.type);
        vehicle.autopilot = Number(f.autopilot);
        vehicle.base_mode = Number(f.base_mode);
        vehicle.custom_mode = Number(f.custom_mode);
        vehicle.system_status = Number(f.system_status);
        vehicle.armed = (Number(f.base_mode) & this.armedFlag) !== 0;
        vehicle.lastHeartbeat = this._now();
        break;
      case 'GLOBAL_POSITION_INT':
        vehicle.position = {
          lat: degE7ToDeg(Number(f.lat)),
          lon: degE7ToDeg(Number(f.lon)),
          alt: Number(f.alt) / 1000,
          relative_alt: Number(f.relative_alt) / 1000,
          heading: Number(f.hdg) === 65535 ? null : Number(f.hdg) / 100
        };
        /**
         * Stamp when the position last updated, so a consumer can tell a fresh
         * fix from a stale one held over while only HEARTBEATs keep arriving.
         */
        vehicle.positionUpdatedAt = this._now();
        break;
      case 'LOCAL_POSITION_NED':
        vehicle.localPosition = { x: Number(f.x), y: Number(f.y), z: Number(f.z) };
        break;
      case 'SYS_STATUS':
        vehicle.battery = {
          voltage: Number(f.voltage_battery) === 65535 ? null : Number(f.voltage_battery) / 1000,
          remaining: Number(f.battery_remaining) === -1 ? null : Number(f.battery_remaining)
        };
        break;
      default:
        break;
    }
    vehicle.lastSeen = this._now();
    return { vehicle: this._snapshot(vehicle), added };
  }

  /**
   * Define the named groups (issue #46 group labels). Each spec is either a
   * sysid array (`[1, 2, 3]`) or a filter object accepted by
   * {@link VehicleRegistry#vehicles} (`{ type: 'MAV_TYPE_QUADROTOR' }`,
   * `{ sysids: [...], armed: true }`, …).
   *
   * @param {Object<string, (number[]|object)>} groups
   * @returns {void}
   */
  setGroups(groups) {
    this._groups = groups && typeof groups === 'object' ? groups : {};
  }

  /** @returns {string[]} defined group names */
  groupNames() {
    return Object.keys(this._groups);
  }

  /**
   * Snapshot the tracked vehicles, expiring/marking stale ones first.
   *
   * @param {object} [filter]
   * @param {string} [filter.group]      named group to apply (its spec merges
   *   with the rest of the filter)
   * @param {number[]} [filter.sysids]   only these system ids
   * @param {string|number|Array} [filter.type]  MAV_TYPE name/number (or list)
   * @param {boolean} [filter.armed]     only armed (true) / disarmed (false)
   * @param {boolean} [filter.includeStale=true]  false drops stale vehicles
   * @returns {object[]} vehicle snapshots (see {@link VehicleRegistry#_snapshot})
   */
  vehicles(filter = {}) {
    this._expire();
    let spec = filter;
    if (filter.group !== undefined) {
      const group = this._groups[filter.group];
      if (group === undefined) {
        return []; // unknown group targets nobody, loudly visible in output
      }
      const groupSpec = Array.isArray(group) ? { sysids: group } : group;
      spec = Object.assign({}, groupSpec, filter);
    }
    const sysids = spec.sysids !== undefined ? normalizeSysids(spec.sysids) : null;
    const out = [];
    for (const vehicle of this._vehicles.values()) {
      const snap = this._snapshot(vehicle);
      if (spec.includeStale === false && snap.stale) {
        continue;
      }
      if (sysids && !sysids.includes(snap.sysid)) {
        continue;
      }
      if (spec.armed !== undefined && snap.armed !== spec.armed) {
        continue;
      }
      if (spec.type !== undefined && !this._matchesType(snap, spec.type)) {
        continue;
      }
      out.push(snap);
    }
    return out.sort((a, b) => a.sysid - b.sysid || a.compid - b.compid);
  }

  /**
   * Unique sysids matching a filter — the fan-out target list.
   *
   * @param {object} [filter]  see {@link VehicleRegistry#vehicles}
   * @returns {number[]} sorted unique sysids
   */
  sysids(filter = {}) {
    return [...new Set(this.vehicles(filter).map((v) => v.sysid))];
  }

  /** @returns {number} tracked vehicle count (after expiry) */
  get size() {
    this._expire();
    return this._vehicles.size;
  }

  /**
   * @param {object} snap  vehicle snapshot
   * @param {string|number|Array} type  MAV_TYPE name, number, or list of either
   * @returns {boolean}
   */
  _matchesType(snap, type) {
    const list = Array.isArray(type) ? type : [type];
    return list.some((t) => {
      if (typeof t === 'number' || /^\d+$/.test(String(t))) {
        return snap.type === Number(t);
      }
      return snap.type_name === String(t).toUpperCase();
    });
  }

  /** Remove vehicles not seen within expireMs. @returns {void} */
  _expire() {
    if (!this.expireMs) {
      return;
    }
    const now = this._now();
    for (const [key, vehicle] of this._vehicles) {
      if (now - vehicle.lastSeen > this.expireMs) {
        this._vehicles.delete(key);
      }
    }
  }

  /**
   * Public, JSON-friendly view of one vehicle's state, with readable enum/mode
   * names resolved and the stale flag computed from the heartbeat age.
   *
   * @param {object} vehicle  internal mutable state
   * @returns {object}
   */
  _snapshot(vehicle) {
    const now = this._now();
    const ageMs = now - (vehicle.lastHeartbeat || vehicle.lastSeen);
    /**
     * Position freshness is tracked independently of heartbeat age: a vehicle
     * can keep heartbeating while its position feed goes silent, and commanding
     * around an arbitrarily old fix is unsafe (#244 follow-leader).
     */
    const positionAgeMs = vehicle.position ? now - (vehicle.positionUpdatedAt || vehicle.lastSeen) : null;
    const firmware = this.autopilotFirmware.get(vehicle.autopilot);
    const vehicleType = this.typeVehicle.get(vehicle.type);
    return {
      sysid: vehicle.sysid,
      compid: vehicle.compid,
      type: vehicle.type,
      type_name: this._enumName('MavType', vehicle.type),
      autopilot: vehicle.autopilot,
      autopilot_name: this._enumName('MavAutopilot', vehicle.autopilot),
      armed: vehicle.armed === true,
      base_mode: vehicle.base_mode,
      custom_mode: vehicle.custom_mode,
      mode: firmware !== undefined && vehicle.custom_mode !== undefined && this.enums
        ? modeNameForCustomMode({ firmware, vehicleType, enums: this.enums, dialect: this.dialect }, vehicle.custom_mode)
        : null,
      status: this._enumName('MavState', vehicle.system_status),
      system_status: vehicle.system_status,
      position: vehicle.position || null,
      localPosition: vehicle.localPosition || null,
      battery: vehicle.battery || null,
      lastSeen: vehicle.lastSeen,
      ageMs,
      stale: ageMs > this.staleMs,
      positionAgeMs,
      positionStale: vehicle.position ? positionAgeMs > this.staleMs : false
    };
  }

  /**
   * @param {string} enumName  e.g. 'MavType'
   * @param {number} value
   * @returns {?string}
   */
  _enumName(enumName, value) {
    if (!this.enums || value === undefined) {
      return null;
    }
    return enumResolver.nameFor(this.enums, enumName, value) || null;
  }
}

module.exports = { VehicleRegistry };
