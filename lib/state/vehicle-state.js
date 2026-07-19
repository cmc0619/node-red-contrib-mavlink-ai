'use strict';

const enumResolver = require('../protocol/enum-resolver');
const { modeNameForCustomMode } = require('../command/flight-modes');

/** The autopilot component owns flight state; other components are presence-only. */
const MAV_COMP_ID_AUTOPILOT1 = 1;
/** HEARTBEAT base_mode flag: motors armed. */
const MAV_MODE_FLAG_SAFETY_ARMED = 128;

// MAV_AUTOPILOT -> profile firmware key, for HEARTBEAT-driven mode naming.
const AUTOPILOT_FIRMWARE = { 3: 'ardupilot', 12: 'px4' };
// MAV_TYPE -> ArduPilot mode-table key (see flight-modes.js).
const TYPE_VEHICLE = {
  1: 'plane', 2: 'copter', 3: 'copter', 4: 'copter', 5: 'antenna-tracker',
  10: 'rover', 11: 'boat', 12: 'sub', 13: 'copter', 14: 'copter', 15: 'copter',
  19: 'plane', 20: 'plane', 21: 'plane', 22: 'plane', 23: 'plane', 24: 'plane',
  25: 'plane', 29: 'copter', 35: 'copter'
};

/**
 * Pure per-vehicle MAVLink state (issue #208). The node feeds decoded §14.1
 * payloads into {@link VehicleStateEngine#ingest} and reads snapshots; the
 * engine has no Node-RED, transport, or connection dependency.
 */
class VehicleStateEngine {
  /**
   * @param {object} [opts]
   * @param {number} [opts.staleMs=5000]        per-section freshness window
   * @param {number} [opts.statustextBuffer=20] STATUSTEXT ring size
   * @param {?object} [opts.enums]              dialect enum index (readable names)
   * @param {function(): number} [opts.now]     injectable clock
   */
  constructor(opts = {}) {
    this.staleMs = opts.staleMs || 5000;
    this.statustextBuffer = opts.statustextBuffer || 20;
    this.enums = opts.enums || null;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    /** sysid -> internal vehicle record. */
    this._vehicles = new Map();
  }

  /**
   * @param {object} payload  decoded §14.1 payload ({ name, sysid, compid, fields })
   * @returns {?{sysid: number}}
   */
  ingest(payload) {
    const sysid = Number(payload && payload.sysid);
    if (!Number.isFinite(sysid)) {
      return null;
    }
    const v = this._vehicleFor(sysid);
    if (payload.name === 'HEARTBEAT') {
      this._ingestHeartbeat(v, payload);
    }
    return { sysid };
  }

  /** @param {number} sysid @returns {object} internal record (created on demand) */
  _vehicleFor(sysid) {
    let v = this._vehicles.get(sysid);
    if (!v) {
      v = { sysid, components: new Map(), autopilot: null, statustext: [] };
      this._vehicles.set(sysid, v);
    }
    return v;
  }

  /** @param {object} v @param {object} payload */
  _ingestHeartbeat(v, payload) {
    const f = payload.fields || {};
    const compid = Number(payload.compid);
    v.components.set(compid, {
      compid,
      type: f.type,
      autopilot: f.autopilot,
      system_status: f.system_status,
      last_seen: this._now()
    });
    if (compid === MAV_COMP_ID_AUTOPILOT1) {
      v.autopilot = {
        type: f.type,
        autopilot: f.autopilot,
        base_mode: f.base_mode,
        custom_mode: f.custom_mode,
        system_status: f.system_status,
        last_heartbeat: this._now()
      };
    }
  }

  /** @param {number} sysid @returns {?object} */
  snapshot(sysid) {
    const v = this._vehicles.get(sysid);
    return v ? this._snapshot(v) : null;
  }

  /** @returns {object[]} */
  snapshots() {
    return [...this._vehicles.values()].map((v) => this._snapshot(v));
  }

  /** @returns {number[]} */
  sysids() {
    return [...this._vehicles.keys()];
  }

  /** @param {object} v @returns {object} the vehicle-state/1 snapshot */
  _snapshot(v) {
    const now = this._now();
    const ap = v.autopilot;
    const connected = !!ap && now - ap.last_heartbeat <= this.staleMs;
    const firmware = ap ? AUTOPILOT_FIRMWARE[ap.autopilot] : undefined;
    const vehicleType = ap ? TYPE_VEHICLE[ap.type] : undefined;
    return {
      sysid: v.sysid,
      contract: 'vehicle-state/1',
      connected,
      autopilot_seen: !!ap,
      identity: ap
        ? {
            type: ap.type,
            type_name: this._enumName('MavType', ap.type),
            autopilot: ap.autopilot,
            autopilot_name: this._enumName('MavAutopilot', ap.autopilot)
          }
        : null,
      armed: ap ? (ap.base_mode & MAV_MODE_FLAG_SAFETY_ARMED) === MAV_MODE_FLAG_SAFETY_ARMED : null,
      mode: ap
        ? {
            name:
              firmware !== undefined && ap.custom_mode !== undefined
                ? modeNameForCustomMode(firmware, vehicleType, ap.custom_mode)
                : null,
            base_mode: ap.base_mode,
            custom_mode: ap.custom_mode
          }
        : null,
      landed: { state: 'unknown', state_name: null },
      position: null,
      home: null,
      gps: null,
      battery: null,
      health: null,
      components: [...v.components.values()].map((c) => ({ ...c })),
      statustext: v.statustext.map((e) => ({ ...e }))
    };
  }

  /** @param {string} enumName @param {number} value @returns {?string} */
  _enumName(enumName, value) {
    if (!this.enums || value === undefined) {
      return null;
    }
    return enumResolver.nameFor(this.enums, enumName, value) || null;
  }
}

/** Replaced with the real diff in Task 5. */
function diffVehicleState() {
  return [];
}

module.exports = { VehicleStateEngine, diffVehicleState };
