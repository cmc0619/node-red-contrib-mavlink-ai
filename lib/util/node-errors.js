'use strict';

const { errorPayload, toMavlinkError } = require('./errors');

/**
 * Arity-proof error delivery for nodes that report failures on an output
 * (#285). The former positional helpers — three incompatible signatures
 * across eight nodes — required every call site to thread node/msg/send/done
 * in the right order, and one dropped argument produced the #276 arity-shift
 * bug: properties assigned onto the send function, done() invoked with a
 * truthy value (firing Catch with garbage), then a payload object called as a
 * function. Binding those once per input means a call site can only get the
 * failure itself wrong, and the failure is the one argument it actually owns.
 */

/**
 * Build the per-input `fail` closure. Package rule (#89): a node with an
 * error-carrying output delivers an operational failure exactly once — as a
 * structured §14.5 message on that output — and finishes with done(), so the
 * same failure does not also fire Catch nodes. (Nodes without outputs, e.g.
 * mavlink-ai-out, use done(err) instead and do not use this helper.)
 *
 * @param {object} opts
 * @param {object} opts.node       the Node-RED node (red status badge)
 * @param {string} opts.nodeName   §14.5 `node` label (e.g. 'mavlink-ai-move')
 * @param {object} opts.msg        the inbound message, reused for the error
 *   output (Node-RED convention: a fresh object would drop `_msgid`
 *   correlation, `msg.parts`, and user-attached properties on exactly the
 *   error branch)
 * @param {function} opts.send
 * @param {function} opts.done
 * @param {number} [opts.outputs=1]     the node's output count
 * @param {number} [opts.errorIndex=0]  which output carries errors
 * @param {function(): ?string} [opts.connectionName]  lazy connection label
 *   for the payload; called at failure time so one closure serves both the
 *   no-connection guard and every later exit
 * @returns {function(*, string=, string=): void} `fail(err, fallbackCode,
 *   badgeText)` — err may be any thrown value (a MavlinkError for explicit
 *   failures); fallbackCode applies when it carries no code; badgeText
 *   overrides the status text (defaults to the code)
 */
function makeFail({ node, nodeName, msg, send, done, outputs = 1, errorIndex = 0, connectionName }) {
  return function fail(err, fallbackCode, badgeText) {
    const e = toMavlinkError(err, fallbackCode);
    node.status({ fill: 'red', shape: 'ring', text: badgeText || e.code });
    const connection = typeof connectionName === 'function' ? connectionName() : undefined;
    msg.topic = 'mavlink/error';
    msg.payload = errorPayload({
      node: nodeName,
      /** errorPayload omits an undefined connection from the payload. */
      connection: connection || undefined,
      code: e.code,
      message: e.message,
      context: e.context
    });
    if (outputs > 1) {
      const outs = new Array(outputs).fill(null);
      outs[errorIndex] = msg;
      send(outs);
    } else {
      send(msg);
    }
    done();
  };
}

module.exports = { makeFail };
