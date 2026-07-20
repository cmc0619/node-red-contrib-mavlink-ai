'use strict';

/**
 * Delivery-mode contract for the action nodes (#207). A node stores one
 * `delivery` value and resolves it here; an absent or unsupported value fails
 * closed (no migration) so a pre-upgrade node cannot silently pick a behavior.
 */

/** The delivery modes an action node may declare. */
const DELIVERY = { BUILD: 'build', SEND: 'send', AWAIT: 'await', STREAM: 'stream' };

/**
 * Resolve and validate a node's delivery mode.
 *
 * @param {{delivery?: string}} config  the node config
 * @param {{allow: string[]}} opts  the modes this node supports
 * @returns {string} the resolved mode (one of `allow`)
 * @throws {Error} `.code === 'DELIVERY_UNSET'` when `config.delivery` is missing
 *   or not one of `allow`.
 */
function resolveDeliveryMode(config, { allow }) {
  const mode = config && config.delivery;
  if (!allow.includes(mode)) {
    const err = new Error('Delivery mode not set — open the node and choose a Delivery mode.');
    err.code = 'DELIVERY_UNSET';
    throw err;
  }
  return mode;
}

module.exports = { DELIVERY, resolveDeliveryMode };
