'use strict';

const enumResolver = require('../protocol/enum-resolver');
const { modeNameForCustomMode } = require('../command/flight-modes');
const { degE7ToDeg } = require('../util/geo');

/** The autopilot component owns flight state; other components are presence-only. */
const MAV_COMP_ID_AUTOPILOT1 = 1;
/** HEARTBEAT base_mode flag: motors armed. */
const MAV_MODE_FLAG_SAFETY_ARMED = 128;
/** EXTENDED_SYS_STATE landed_state enum. */
const LANDED_STATE = { 0: 'unknown', 1: 'on_ground', 2: 'in_air', 3: 'takeoff', 4: 'landing' };

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
 * Map a wire sentinel (a value meaning "unavailable") to null, else return the
 * value. GPS eph/epv use 65535; satellites_visible uses 255. BATTERY_STATUS
 * voltages use 65535; current_battery and battery_remaining use -1.
 *
 * @param {number} value
 * @param {number} sentinel
 * @returns {?number}
 */
function nullIfSentinel(value, sentinel) {
  return value === sentinel || value === undefined ? null : value;
}

/**
 * Total pack voltage (mV) from a BATTERY_STATUS `voltages` cell array. MAVLink
 * defines the array as per-cell voltages with UINT16_MAX padding above the
 * valid cell count; when individual cells are unknown the whole-pack voltage is
 * reported in cell 0 alone. Summing every non-sentinel cell yields the pack
 * total in both encodings — a 3S smart battery reporting [4200, 4200, 4200,
 * 65535, …] gives 12600, and a total-only [12600, 65535, …] also gives 12600.
 * Cells reading 0 (some firmware pads unused cells with 0 rather than the
 * sentinel) contribute nothing. Returns null when no real cell is present.
 *
 * @param {number[]|undefined} voltages
 * @returns {?number} total millivolts, or null if unavailable
 */
function sumCellVoltages(voltages) {
  if (!Array.isArray(voltages)) {
    return null;
  }
  let total = 0;
  let seen = false;
  for (const mv of voltages) {
    // UINT16_MAX pads cells above the valid count; 0 is unused-cell padding in
    // firmware that doesn't use the sentinel. Neither is a live reading, so an
    // all-zero/all-sentinel array reports null rather than a phantom 0 V.
    if (mv === 65535 || mv === 0 || mv === undefined || mv === null) {
      continue;
    }
    total += mv;
    seen = true;
  }
  return seen ? total : null;
}

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
    const raw = payload ? payload.sysid : undefined;
    if (raw === null || raw === undefined || raw === '') {
      return null;
    }
    const sysid = Number(raw);
    // sysid 0 is the MAVLink broadcast/unknown address, never a real vehicle
    // source — a packet claiming to originate from it is malformed and must not
    // spawn a phantom vehicle 0.
    if (!Number.isInteger(sysid) || sysid < 1 || sysid > 255) {
      return null;
    }
    const v = this._vehicleFor(sysid);
    if (payload.name === 'HEARTBEAT') {
      this._ingestHeartbeat(v, payload);
    } else if (payload.name === 'GLOBAL_POSITION_INT' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.position = {
        lat: degE7ToDeg(f.lat),
        lon: degE7ToDeg(f.lon),
        alt_amsl_m: f.alt / 1000,
        alt_rel_m: f.relative_alt / 1000,
        updated_at: this._now()
      };
    } else if (payload.name === 'HOME_POSITION' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.home = {
        lat: degE7ToDeg(f.latitude),
        lon: degE7ToDeg(f.longitude),
        alt_amsl_m: f.altitude / 1000,
        updated_at: this._now()
      };
    } else if (payload.name === 'GPS_RAW_INT' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      const eph = nullIfSentinel(f.eph, 65535);
      const epv = nullIfSentinel(f.epv, 65535);
      v.gps = {
        fix_type: f.fix_type,
        satellites: nullIfSentinel(f.satellites_visible, 255),
        eph_m: eph === null ? null : eph / 100,
        epv_m: epv === null ? null : epv / 100,
        updated_at: this._now()
      };
    } else if (payload.name === 'BATTERY_STATUS' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      const totalMv = sumCellVoltages(f.voltages);
      const entry = {
        id: f.id,
        voltage_v: totalMv === null ? null : totalMv / 1000,
        current_a: nullIfSentinel(f.current_battery, -1) === null ? null : f.current_battery / 100,
        remaining_pct: nullIfSentinel(f.battery_remaining, -1)
      };
      v.battery = v.battery || { batteries: [], updated_at: this._now() };
      const idx = v.battery.batteries.findIndex((b) => b.id === entry.id);
      if (idx >= 0) {
        v.battery.batteries[idx] = entry;
      } else {
        v.battery.batteries.push(entry);
      }
      v.battery.updated_at = this._now();
      v.batterySource = 'battery_status';
    } else if (payload.name === 'SYS_STATUS' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.health = {
        present: f.onboard_control_sensors_present >>> 0,
        enabled: f.onboard_control_sensors_enabled >>> 0,
        healthy: f.onboard_control_sensors_health >>> 0,
        updated_at: this._now()
      };
      /**
       * SYS_STATUS voltage is a fallback when BATTERY_STATUS is absent (spec
       * battery row). Once a real BATTERY_STATUS has been seen, it always
       * wins — SYS_STATUS must never overwrite the richer reading.
       */
      if (v.batterySource !== 'battery_status') {
        const voltage = nullIfSentinel(f.voltage_battery, 65535);
        const current = nullIfSentinel(f.current_battery, -1);
        v.battery = {
          batteries: [
            {
              id: 0,
              voltage_v: voltage === null ? null : voltage / 1000,
              current_a: current === null ? null : current / 100,
              remaining_pct: nullIfSentinel(f.battery_remaining, -1)
            }
          ],
          updated_at: this._now()
        };
        v.batterySource = 'sys_status';
      }
    } else if (payload.name === 'EXTENDED_SYS_STATE' && Number(payload.compid) === MAV_COMP_ID_AUTOPILOT1) {
      const f = payload.fields || {};
      v.landed = f.landed_state;
    } else if (payload.name === 'STATUSTEXT') {
      const f = payload.fields || {};
      v.statustext.push({
        severity: f.severity,
        severity_name: this._enumName('MavSeverity', f.severity),
        text: typeof f.text === 'string' ? f.text : String(f.text == null ? '' : f.text),
        at: this._now()
      });
      if (v.statustext.length > this.statustextBuffer) {
        v.statustext.splice(0, v.statustext.length - this.statustextBuffer);
      }
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
      landed: {
        state: v.landed !== undefined ? LANDED_STATE[v.landed] || 'unknown' : 'unknown',
        state_name: v.landed !== undefined ? this._enumName('MavLandedState', v.landed) : null
      },
      position: v.position
        ? { ...v.position, stale: now - v.position.updated_at > this.staleMs }
        : null,
      // home carries updated_at but deliberately no `stale` flag: HOME_POSITION
      // is set-once/rarely-sent (not streamed like position/gps/battery/health),
      // so a staleness marker would flip true within the window and stay true
      // forever, wrongly implying an old-but-still-valid home may be wrong.
      home: v.home ? { ...v.home } : null,
      gps: v.gps
        ? {
            fix_type: v.gps.fix_type,
            fix_type_name: this._enumName('GpsFixType', v.gps.fix_type),
            satellites: v.gps.satellites,
            eph_m: v.gps.eph_m,
            epv_m: v.gps.epv_m,
            updated_at: v.gps.updated_at,
            stale: now - v.gps.updated_at > this.staleMs
          }
        : null,
      battery: v.battery
        ? {
            batteries: v.battery.batteries.map((b) => ({ ...b })),
            updated_at: v.battery.updated_at,
            stale: now - v.battery.updated_at > this.staleMs
          }
        : null,
      health: v.health ? this._healthSection(v.health, now) : null,
      components: [...v.components.values()].map((c) => ({
        ...c,
        stale: now - c.last_seen > this.staleMs
      })),
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

  /**
   * Decode the SYS_STATUS sensor bitmasks into per-sensor flags. Every bit set
   * in present/enabled/health is surfaced, named via the MavSysStatusSensor
   * enum when known, else by bit index.
   *
   * @param {object} h  { present, enabled, healthy, updated_at }
   * @param {number} now  wall clock used for the per-section staleness marker
   * @returns {object}
   */
  _healthSection(h, now) {
    const bits = new Set();
    for (const mask of [h.present, h.enabled, h.healthy]) {
      for (let bit = 0; bit < 32; bit += 1) {
        if (mask & (1 << bit)) {
          bits.add(bit);
        }
      }
    }
    const sensors = [...bits].sort((a, b) => a - b).map((bit) => ({
      bit,
      name: this._enumName('MavSysStatusSensor', (1 << bit) >>> 0),
      present: (h.present & (1 << bit)) !== 0,
      enabled: (h.enabled & (1 << bit)) !== 0,
      healthy: (h.healthy & (1 << bit)) !== 0
    }));
    return { sensors, updated_at: h.updated_at, stale: now - h.updated_at > this.staleMs };
  }
}

/**
 * Edge-triggered transitions between two vehicle snapshots (#208). Emits an
 * event only where a tracked field changed; `prev` null means first sight.
 * Pure — the caller supplies the wall clock `at`.
 *
 * @param {?object} prev
 * @param {object} next
 * @param {number} at
 * @returns {Array<{event: string, sysid: number, from: *, to: *, at: number}>}
 */
function diffVehicleState(prev, next, at) {
  const events = [];
  const sysid = next.sysid;
  const push = (event, from, to) => events.push({ event, sysid, from, to, at });

  const pConn = prev ? prev.connected : false;
  if (pConn !== next.connected) {
    push(next.connected ? 'connected' : 'connection_lost', pConn, next.connected);
  }

  // First sight: there is no prior state to diff against, so emit only the
  // connection edge. Every other edge below requires a real previous snapshot.
  if (!prev) {
    return events;
  }

  const pArmed = prev.armed;
  if (pArmed !== next.armed && next.armed !== null) {
    push(next.armed ? 'armed' : 'disarmed', pArmed, next.armed);
  }

  // Prefer the readable mode name, but fall back to the numeric base/custom
  // pair so a vehicle whose mode name is unresolved (unsupported type/firmware
  // or a custom mode missing from flight-modes.js) still edge-triggers real
  // mode changes. from/to carry the name when known, else the raw custom_mode.
  const modeKey = (m) => {
    if (!m) {
      return null;
    }
    // Numeric fallback keys on custom_mode only — it is the flight-mode
    // discriminator. base_mode carries flags (notably SAFETY_ARMED), so keying
    // on it would emit a false mode_change on every arm/disarm of a vehicle
    // whose mode name is unresolved.
    return m.name != null ? `name:${m.name}` : `num:${m.custom_mode}`;
  };
  const modeLabel = (m) => (m ? (m.name != null ? m.name : m.custom_mode) : null);
  if (next.mode && modeKey(prev.mode) !== modeKey(next.mode)) {
    push('mode_change', modeLabel(prev.mode), modeLabel(next.mode));
  }

  const pLanded = prev.landed ? prev.landed.state : 'unknown';
  const nLanded = next.landed ? next.landed.state : 'unknown';
  if (pLanded !== nLanded) {
    push('landed_change', pLanded, nLanded);
  }

  const pFix = prev.gps ? prev.gps.fix_type : null;
  const nFix = next.gps ? next.gps.fix_type : null;
  if (pFix !== nFix && nFix !== null) {
    push('gps_fix_change', pFix, nFix);
  }

  if (!prev.home && next.home) {
    push('home_set', null, { lat: next.home.lat, lon: next.home.lon });
  }

  const prevComps = new Set(prev.components.filter((c) => !c.stale).map((c) => c.compid));
  const nextComps = new Set(next.components.filter((c) => !c.stale).map((c) => c.compid));
  for (const compid of nextComps) {
    if (!prevComps.has(compid)) {
      push('component_appeared', null, compid);
    }
  }
  for (const compid of prevComps) {
    if (!nextComps.has(compid)) {
      push('component_lost', compid, null);
    }
  }

  const pSensors = new Map((prev.health ? prev.health.sensors : []).map((x) => [x.bit, x]));
  for (const s of next.health ? next.health.sensors : []) {
    const before = pSensors.get(s.bit);
    if (before && before.healthy !== s.healthy) {
      push('sensor_health_change', { bit: s.bit, name: s.name, healthy: before.healthy }, { bit: s.bit, name: s.name, healthy: s.healthy });
    }
  }

  return events;
}

module.exports = { VehicleStateEngine, diffVehicleState };
