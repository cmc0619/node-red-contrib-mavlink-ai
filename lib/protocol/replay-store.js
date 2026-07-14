'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Durable backing for {@link ReplayTracker} (issue #101): one JSON file holding
 * the highest accepted signing timestamp per stream, namespaced by key identity.
 *
 * Shape: `{ "_meta": { version }, "<scopeKey>": { "sysid:compid:linkId": ts } }`.
 *
 * Writes are throttled (leading-edge write, then coalesce for `throttleMs`) so a
 * high signed-message rate does not hammer the disk, and are atomic (temp file +
 * rename) so a crash mid-write cannot corrupt the state. If the location is not
 * writable (read-only or ephemeral userDir) the store degrades to in-memory: the
 * tracker still enforces replay protection for the running process, durability is
 * simply best-effort. It never fails closed on a disk problem.
 */
class FileReplayStore {
  /**
   * @param {object} opts
   * @param {string} opts.file             absolute path to the state file
   * @param {number} [opts.throttleMs]     minimum spacing between writes (2000)
   * @param {function(Error): void} [opts.onUnwritable]  called once if writes fail
   */
  constructor(opts = {}) {
    this._file = opts.file;
    this._throttleMs = opts.throttleMs != null ? opts.throttleMs : 2000;
    this._onUnwritable = typeof opts.onUnwritable === 'function' ? opts.onUnwritable : null;
    this._writable = true;
    this._dirty = false;
    this._cooldown = null;
    this._data = this._read();
  }

  /**
   * Read the state file, tolerating a missing or corrupt file.
   *
   * @returns {object}
   */
  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (err) {
      /** Missing or unreadable/corrupt file: start fresh rather than throw. */
      void err;
    }
    return { _meta: { version: 1 } };
  }

  /**
   * @param {string} scopeKey
   * @returns {object} the stream->timestamp map for this key identity (possibly empty)
   */
  load(scopeKey) {
    const scope = this._data[scopeKey];
    return scope && typeof scope === 'object' ? scope : {};
  }

  /**
   * Record a scope's stream map and schedule a throttled flush.
   *
   * @param {string} scopeKey
   * @param {object} streamMap
   * @returns {void}
   */
  save(scopeKey, streamMap) {
    this._data[scopeKey] = streamMap;
    this._dirty = true;
    if (this._cooldown) {
      /** Within cooldown: the trailing flush picks this up. */
      return;
    }
    this._writeNow();
    this._cooldown = setTimeout(() => {
      this._cooldown = null;
      if (this._dirty) {
        this._writeNow();
      }
    }, this._throttleMs);
    if (typeof this._cooldown.unref === 'function') {
      this._cooldown.unref();
    }
  }

  /**
   * Write pending state immediately and cancel any pending throttle timer. Call
   * on connection close so the last accepted timestamps are not lost.
   *
   * @returns {void}
   */
  flush() {
    if (this._cooldown) {
      clearTimeout(this._cooldown);
      this._cooldown = null;
    }
    if (this._dirty) {
      this._writeNow();
    }
  }

  /**
   * Atomically persist the current state, degrading to in-memory on failure.
   *
   * @returns {void}
   */
  _writeNow() {
    if (!this._writable) {
      return;
    }
    this._dirty = false;
    const tmp = `${this._file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this._data));
      fs.renameSync(tmp, this._file);
    } catch (err) {
      this._writable = false;
      if (this._onUnwritable) {
        this._onUnwritable(err);
      }
    }
  }
}

module.exports = { FileReplayStore };
