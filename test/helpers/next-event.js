'use strict';

/**
 * Resolve on the first matching event, or reject after a timeout. Feeding one
 * datagram directly at a transport is enough — the splitter buffers it and the
 * parser emits on a later tick, so tests wait on the event rather than assert
 * synchronously. The listener is always removed on both settle paths.
 *
 * @param {EventEmitter} emitter  the emitter to listen on
 * @param {string} event  the event name to await
 * @param {number} [timeoutMs=2000]  reject after this many milliseconds
 * @returns {Promise<*>} the event payload
 */
function nextEvent(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`timeout waiting for '${event}'`));
    }, timeoutMs);
    /**
     * @param {*} payload  the emitted event payload
     * @returns {void}
     */
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    emitter.once(event, onEvent);
  });
}

module.exports = { nextEvent };
