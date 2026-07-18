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
 * Keep a flow node's resolved config-node references (`node.profile`,
 * `node.connection`) and its idle status badge in sync across deploys.
 *
 * Node-RED leaves a flow node in place when only a *referenced config node*
 * changed, so the flow node's constructor never re-runs. Without this, a
 * profile or connection fixed after deploy would leave a stale red badge, and
 * `node.profile`/`node.connection` would keep pointing at the destroyed old
 * config object (so sends would still fail). Re-resolving on setup and on every
 * `flows:started` mirrors what the connection node does for its own profile
 * dependencies, and gives every flow node the same "invalid profile" / "missing
 * connection" badge behaviour.
 *
 * The badge is only the *idle* state — the input handler overrides it with its
 * own send/progress/error badges at runtime; the next `flows:started` restores
 * the idle badge. "invalid profile" takes precedence over "missing connection".
 *
 * @param {object} RED     the Node-RED runtime
 * @param {object} node    the flow node (`node.status`, and the refs set below)
 * @param {object} config  the node config (`config.profile`, `config.connection`)
 * @param {object} [opts]  which references to manage
 * @param {'required'} [opts.profile]  resolve `node.profile`; badge "invalid
 *   profile" when absent/invalid. Omit to leave `node.profile` untouched (e.g.
 *   nodes that keep the profile as a raw id override).
 * @param {'required'|'optional'} [opts.connection]  resolve `node.connection`.
 *   'required' badges "missing connection" whenever it is null; 'optional' only
 *   badges when `opts.connectionRequiredWhen` returns true. Omit to leave
 *   `node.connection` untouched.
 * @param {function(): boolean} [opts.connectionRequiredWhen]  for an 'optional'
 *   connection, return true when the current config actually needs it (e.g.
 *   await-acks enabled) so a missing connection is badged.
 * @returns {void}
 */
function watchConfigBadge(RED, node, config, opts = {}) {
  const refresh = () => {
    if (opts.profile) {
      node.profile = RED.nodes.getNode(config.profile);
    }
    if (opts.connection) {
      node.connection = config.connection ? RED.nodes.getNode(config.connection) : null;
    }

    const profileInvalid =
      opts.profile === 'required' &&
      (!node.profile || typeof node.profile.isValid !== 'function' || !node.profile.isValid());
    if (profileInvalid) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid profile' });
      return;
    }

    const connectionNeeded =
      opts.connection === 'required' ||
      (opts.connection === 'optional' &&
        typeof opts.connectionRequiredWhen === 'function' &&
        opts.connectionRequiredWhen());
    if (connectionNeeded && !node.connection) {
      node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
      return;
    }

    node.status({});
  };
  refresh();
  if (RED.events && typeof RED.events.on === 'function') {
    RED.events.on('flows:started', refresh);
    node.on('close', () => RED.events.removeListener('flows:started', refresh));
  }
}

module.exports = { safeDetach, watchConfigBadge };
