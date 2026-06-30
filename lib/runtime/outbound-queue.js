'use strict';

/**
 * Outbound queue (DESIGN.md §21). The connection owns outbound serialization so
 * multiple flow tabs don't independently scribble onto the same socket.
 *
 * Starts as a simple FIFO. Priority is supported (lower number = higher
 * priority) but defaults to a single band so it behaves as plain FIFO until a
 * caller opts into priorities.
 */
class OutboundQueue {
  /**
   * @param {function(Buffer): Promise} writer  async function that writes bytes
   * @param {object} [opts]
   * @param {boolean} [opts.enabled] when false, writes pass straight through
   */
  constructor(writer, opts = {}) {
    this._writer = writer;
    this.enabled = opts.enabled !== false;
    this._queue = [];
    this._draining = false;
  }

  get length() {
    return this._queue.length;
  }

  /**
   * Enqueue a buffer for sending. Resolves once it has been written.
   * @param {Buffer} buffer
   * @param {number} [priority] 0 (highest) .. 3 (background)
   * @returns {Promise<void>}
   */
  enqueue(buffer, priority = 2) {
    if (!this.enabled) {
      return this._writer(buffer);
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ buffer, priority, resolve, reject });
      // Stable priority sort: keep insertion order within a priority band.
      this._queue.sort((a, b) => a.priority - b.priority);
      this._drain();
    });
  }

  async _drain() {
    if (this._draining) {
      return;
    }
    this._draining = true;
    try {
      while (this._queue.length) {
        const item = this._queue.shift();
        try {
          await this._writer(item.buffer);
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this._draining = false;
    }
  }

  clear() {
    const pending = this._queue.splice(0);
    for (const item of pending) {
      item.reject(new Error('Outbound queue cleared'));
    }
  }
}

module.exports = { OutboundQueue };
