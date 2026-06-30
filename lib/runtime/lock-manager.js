'use strict';

const { MavlinkError } = require('../util/errors');

/**
 * Lock manager (DESIGN.md §23). Ensures only one mission workflow runs per
 * connection/profile/mission-type at a time. Failing to acquire is a loud,
 * clear error rather than two workflows quietly fighting over item 0.
 *
 * Lock key shape: mission:<connection-id>:<profile-id>:<mission-type>
 */
class LockManager {
  constructor() {
    this._locks = new Map(); // key -> owner
  }

  /**
   * Acquire a lock. Throws MAVLINK 'LOCK_HELD' if already held.
   * @returns {{ release: function }}
   */
  acquire(key, owner) {
    if (this._locks.has(key)) {
      const holder = this._locks.get(key);
      throw new MavlinkError('LOCK_HELD', `Lock '${key}' is already held by '${holder}'.`, {
        key,
        holder
      });
    }
    this._locks.set(key, owner || 'unknown');
    return {
      key,
      release: () => this.release(key, owner)
    };
  }

  release(key, owner) {
    if (!this._locks.has(key)) {
      return false;
    }
    if (owner !== undefined && this._locks.get(key) !== owner) {
      return false;
    }
    return this._locks.delete(key);
  }

  isHeld(key) {
    return this._locks.has(key);
  }

  clear() {
    this._locks.clear();
  }
}

module.exports = { LockManager };
