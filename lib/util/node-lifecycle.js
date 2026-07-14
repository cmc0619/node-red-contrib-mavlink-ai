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

/**
 * Keep a profile-referencing flow node's `node.profile` and its "invalid
 * profile" badge in sync across deploys. Node-RED leaves a flow node in place
 * when only its referenced profile *config* node changed, so the node's
 * constructor never re-runs — a profile fixed after deploy would otherwise
 * leave a stale red badge, and `node.profile` would keep pointing at the
 * destroyed old profile object (so sends would still fail). Re-resolve the
 * profile and refresh the badge here at setup and on every `flows:started`,
 * mirroring what the connection node does for its own profile dependencies.
 *
 * @param {object} RED     the Node-RED runtime
 * @param {object} node    the flow node (sets `node.profile`, `node.status`)
 * @param {object} config  the node config (`config.profile` = profile node id)
 * @returns {void}
 */
function watchProfileBadge(RED, node, config) {
  const refresh = () => {
    node.profile = RED.nodes.getNode(config.profile);
    if (!node.profile || typeof node.profile.isValid !== 'function' || !node.profile.isValid()) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid profile' });
    } else {
      node.status({});
    }
  };
  refresh();
  if (RED.events && typeof RED.events.on === 'function') {
    RED.events.on('flows:started', refresh);
    node.on('close', () => RED.events.removeListener('flows:started', refresh));
  }
}

module.exports = { safeDetach, watchProfileBadge };
