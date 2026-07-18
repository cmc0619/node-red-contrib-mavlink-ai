'use strict';

/**
 * Bounded per-key tracking for wire-derived state (#281), extracted from the
 * subscription registry so the filter node shares one policy instead of
 * keeping its own unbounded copies of the same maps.
 *
 * The threat model: keys are built from `connection:name:sysid:compid`, and
 * sysid/compid arrive from the wire — unsigned but CRC-valid frames are
 * trivial to forge, so without a bound a sender sweeping the 65 536
 * sysid×compid space (times message names, times connection ids) grows these
 * maps without limit for the life of a deploy. Oldest-inserted entries are
 * evicted first; evicting a hot key merely lets one extra delivery through
 * (rate limit) or re-delivers one unchanged message (changed-only), so the
 * bound is safe.
 */

/**
 * Cap on a per-subscription/per-node rate-limit or changed-only tracking map.
 *
 * @type {number}
 */
const MAX_TRACKED_KEYS = 4096;

/**
 * Insert into a bounded Map, evicting the oldest-inserted entry when full.
 *
 * @param {Map<string, *>} map
 * @param {string} key
 * @param {*} value
 * @returns {void}
 */
function boundedSet(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRACKED_KEYS) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

module.exports = { boundedSet, MAX_TRACKED_KEYS };
