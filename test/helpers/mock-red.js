'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const packageJson = require('../../package.json');

/**
 * A minimal Node-RED runtime stand-in for tests. It supports config nodes
 * (getNode by id), the createNode/registerType lifecycle, the (msg, send, done)
 * input convention, and node.status/error/send capture.
 *
 * It is intentionally small: just enough to construct real node instances and
 * drive them, without pulling in the full Node-RED runtime.
 */
class MockRED {
  /** Create an empty mock runtime with node/type registries. */
  constructor() {
    this._types = new Map();
    this._nodes = new Map();
    this.nodes = {
      createNode: (node, config) => this._createNode(node, config),
      registerType: (type, ctor) => this._types.set(type, ctor),
      getNode: (id) => this._nodes.get(id) || null,
      /**
       * Iterate all registered nodes. Real Node-RED iterates node
       * *definitions*; iterating the created instances gives the same
       * id/type/name surface the nodes rely on.
       *
       * @param {function(object): void} cb  called with each node
       */
      eachNode: (cb) => {
        for (const n of this._nodes.values()) {
          cb(n);
        }
      }
    };
    this.validators = { number: () => () => true };
    this.util = { cloneMessage: (m) => JSON.parse(JSON.stringify(m)) };
    // Runtime event bus stand-in (e.g. 'flows:started'); tests emit on it.
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  /** Load all package nodes' registration functions. */
  loadNodes() {
    for (const [, nodePath] of Object.entries(packageJson['node-red'].nodes)) {
      const register = require(path.join('../../', nodePath));
      register(this);
    }
    return this;
  }

  /**
   * Node-RED `createNode` stand-in: wires EventEmitter behavior plus
   * status/error/send capture onto a node instance and registers it by id.
   *
   * @param {object} node
   * @param {object} config
   * @returns {void}
   */
  _createNode(node, config) {
    node.id = config.id;
    node.type = config.type;
    // Real Node-RED populates node.credentials from its encrypted store; the
    // mock lets a test pass them inline via config.credentials (used for the
    // signing passphrase, which is a credential rather than plain config).
    node.credentials = config.credentials || {};
    const ee = new EventEmitter();
    ee.setMaxListeners(0);
    node._ee = ee;
    node.on = ee.on.bind(ee);
    node.once = ee.once.bind(ee);
    node.emit = ee.emit.bind(ee);
    node.removeListener = ee.removeListener.bind(ee);
    node.removeAllListeners = ee.removeAllListeners.bind(ee);
    node.listenerCount = ee.listenerCount.bind(ee);
    node.statusHistory = [];
    node.errors = [];
    node.warnings = [];
    node.sent = [];
    node.status = (s) => node.statusHistory.push(s);
    node.error = (e) => node.errors.push(e);
    node.warn = (w) => node.warnings.push(w);
    node.log = () => {};
    node.debug = () => {};
    node.trace = () => {};
    node.send = (m) => {
      node.sent.push(m);
      if (node._onSend) {
        node._onSend(m);
      }
    };
    this._nodes.set(node.id, node);
  }

  /**
   * Remove a node from the registry, standing in for a config node deleted on
   * a Node-RED redeploy. After this, `getNode(id)` returns null and name scans
   * no longer see it.
   *
   * @param {string} id  the node id to remove
   * @returns {boolean} whether a node was removed
   */
  remove(id) {
    return this._nodes.delete(id);
  }

  /** Instantiate a node of `type` with `config` (config.id is required). */
  create(type, config) {
    const Ctor = this._types.get(type);
    if (!Ctor) {
      throw new Error(`Unknown node type '${type}'`);
    }
    config.type = type;
    return new Ctor(config);
  }

  /** Deliver an input message to a node, resolving when done() is called. */
  inject(node, msg) {
    return new Promise((resolve) => {
      const collected = [];
      const send = (m) => collected.push(m);
      let settled = false;
      const done = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ collected, err });
      };
      node._ee.emit('input', msg, send, done);
    });
  }

  /** Close a node, resolving when its close handler calls done(). */
  close(node) {
    return new Promise((resolve) => {
      if (node._ee.listenerCount('close') === 0) {
        resolve();
        return;
      }
      node._ee.emit('close', () => resolve());
    });
  }
}

module.exports = { MockRED };
