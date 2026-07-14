'use strict';

/**
 * Detach a flow node from its connection during close (issue #140). Guards the
 * dereference — on a full undeploy the connection config node may already be
 * torn down — and never lets a teardown error escape into Node-RED's close
 * loop, where a synchronous throw aborts the deploy. Shared by the in/out/swarm
 * nodes so the guard + try/catch + error-report pattern stays identical.
 *
 * @param {object} node  the Node-RED node (for `node.connection` and `node.error`)
 * @param {function(): void} detach  the listener/subscription removal to run
 * @returns {void}
 */
function safeDetach(node, detach) {
  try {
    if (node.connection) {
      detach();
    }
  } catch (err) {
    node.error(`Error detaching from connection on close: ${err && err.message ? err.message : err}`);
  }
}

module.exports = { safeDetach };
