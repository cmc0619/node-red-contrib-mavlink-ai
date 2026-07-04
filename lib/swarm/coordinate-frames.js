'use strict';

const { MavlinkError } = require('../util/errors');

/**
 * Coordinate-frame helpers for swarm fan-out (issue #46).
 *
 * These exist to prevent the classic MAVLink mistakes:
 *
 * - adding meters directly to lat/lon degrees
 * - adding meters directly to degE7 integers
 * - confusing local NED `z` (down-positive) with altitude (up-positive)
 * - forgetting the degE7 wire scaling of COMMAND_INT / MISSION_ITEM_INT
 *
 * All conversions use the standard flat-earth (equirectangular) approximation
 * around the origin latitude, which is accurate to well under 1% for the
 * offsets swarm formations use (meters to a few kilometers). Positions are
 * float degrees unless a function name says degE7.
 */

// WGS84 mean earth radius in meters (the value ArduPilot/PX4 use for the same
// small-offset math).
const EARTH_RADIUS_M = 6378137;

/**
 * Require a finite number, with a structured error naming the offending field.
 *
 * @param {*} value
 * @param {string} name  field name for the error message
 * @returns {number}
 * @throws {MavlinkError} BAD_COORDINATES
 */
function finite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new MavlinkError('BAD_COORDINATES', `Coordinate '${name}' must be a finite number (got ${value}).`, {
      field: name,
      value
    });
  }
  return n;
}

/**
 * Convert a meters offset (north/east) at a given latitude to a lat/lon delta
 * in float degrees.
 *
 * @param {number} north  meters north (negative = south)
 * @param {number} east   meters east (negative = west)
 * @param {number} lat    latitude of the origin, float degrees
 * @returns {{dLat: number, dLon: number}} degrees
 */
function metersToLatLonDelta(north, east, lat) {
  const n = finite(north, 'north');
  const e = finite(east, 'east');
  const latDeg = finite(lat, 'lat');
  if (Math.abs(latDeg) > 89.9) {
    // cos(lat) -> 0: meters east has no meaningful longitude representation.
    throw new MavlinkError('BAD_COORDINATES', `Cannot convert meter offsets near the poles (lat ${latDeg}).`, {
      lat: latDeg
    });
  }
  const dLat = (n / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = (e / (EARTH_RADIUS_M * Math.cos((latDeg * Math.PI) / 180))) * (180 / Math.PI);
  return { dLat, dLon };
}

/**
 * Apply a meters north/east offset to a global position.
 *
 * @param {{lat: number, lon: number}} origin  float degrees
 * @param {{north?: number, east?: number}} offset  meters (defaults 0)
 * @returns {{lat: number, lon: number}} float degrees
 */
function offsetLatLon(origin, offset = {}) {
  const lat = finite(origin && origin.lat, 'origin.lat');
  const lon = finite(origin && origin.lon, 'origin.lon');
  const { dLat, dLon } = metersToLatLonDelta(offset.north || 0, offset.east || 0, lat);
  return { lat: lat + dLat, lon: lon + dLon };
}

/**
 * Convert a local NED offset from a global origin into a global target.
 * NED is north/east/down; MAVLink altitude is up — `down` is subtracted from
 * the origin altitude. `up` is accepted as the friendlier spelling (down = -up);
 * passing both is an error rather than a silent pick.
 *
 * @param {{lat: number, lon: number, alt?: number}} origin  float degrees, alt meters
 * @param {{north?: number, east?: number, down?: number, up?: number}} offset  meters
 * @returns {{lat: number, lon: number, alt: number}}
 */
function nedOffsetToGlobal(origin, offset = {}) {
  if (offset.down !== undefined && offset.up !== undefined) {
    throw new MavlinkError('BAD_COORDINATES', "Offset cannot set both 'down' and 'up' — pick one convention.", {
      down: offset.down,
      up: offset.up
    });
  }
  const down = offset.down !== undefined ? finite(offset.down, 'down') : offset.up !== undefined ? -finite(offset.up, 'up') : 0;
  const { lat, lon } = offsetLatLon(origin, offset);
  const alt = (origin.alt !== undefined ? finite(origin.alt, 'origin.alt') : 0) - down;
  return { lat, lon, alt };
}

/**
 * Express a global target as a local NED offset from a global origin
 * (inverse of {@link nedOffsetToGlobal}, same flat-earth approximation).
 *
 * @param {{lat: number, lon: number, alt?: number}} origin
 * @param {{lat: number, lon: number, alt?: number}} target
 * @returns {{north: number, east: number, down: number}} meters
 */
function globalToNedOffset(origin, target) {
  const oLat = finite(origin && origin.lat, 'origin.lat');
  const oLon = finite(origin && origin.lon, 'origin.lon');
  const tLat = finite(target && target.lat, 'target.lat');
  const tLon = finite(target && target.lon, 'target.lon');
  if (Math.abs(oLat) > 89.9) {
    throw new MavlinkError('BAD_COORDINATES', `Cannot convert offsets near the poles (lat ${oLat}).`, { lat: oLat });
  }
  const north = ((tLat - oLat) * Math.PI / 180) * EARTH_RADIUS_M;
  const east = ((tLon - oLon) * Math.PI / 180) * EARTH_RADIUS_M * Math.cos((oLat * Math.PI) / 180);
  const oAlt = origin.alt !== undefined ? finite(origin.alt, 'origin.alt') : 0;
  const tAlt = target.alt !== undefined ? finite(target.alt, 'target.alt') : 0;
  return { north, east, down: oAlt - tAlt };
}

/**
 * Float degrees -> MAVLink degE7 int32 (COMMAND_INT / MISSION_ITEM_INT wire
 * scaling).
 *
 * @param {number} deg
 * @returns {number} integer degE7
 */
function degToDegE7(deg) {
  return Math.round(finite(deg, 'deg') * 1e7);
}

/**
 * MAVLink degE7 int32 -> float degrees.
 *
 * @param {number} degE7
 * @returns {number}
 */
function degE7ToDeg(degE7) {
  return finite(degE7, 'degE7') / 1e7;
}

module.exports = {
  EARTH_RADIUS_M,
  metersToLatLonDelta,
  offsetLatLon,
  nedOffsetToGlobal,
  globalToNedOffset,
  degToDegE7,
  degE7ToDeg
};
