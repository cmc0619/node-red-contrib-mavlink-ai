const path = require('path');
const packageJson = require('../package.json');

const registered = new Map();

const RED = {
  nodes: {
    createNode(node) {
      node.on = function noopOn() {};
      node.status = function noopStatus() {};
      node.send = function noopSend() {};
    },
    registerType(type, constructor) {
      registered.set(type, constructor);
    },
    getNode() {
      return null;
    }
  },
  validators: {
    number() {
      return () => true;
    }
  }
};

for (const [type, nodePath] of Object.entries(packageJson['node-red'].nodes)) {
  const register = require(path.join('..', nodePath));

  if (typeof register !== 'function') {
    throw new Error(`${nodePath} does not export a registration function`);
  }

  register(RED);

  if (!registered.has(type)) {
    throw new Error(`${nodePath} did not register expected type ${type}`);
  }
}

console.log(`Loaded ${registered.size} Node-RED node types successfully.`);
