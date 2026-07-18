'use strict';

/**
 * Transport field metadata (#103, condensed in #243).
 *
 * Three protocols — `udp`, `serial`, `tcp` — whose *role* derives from field
 * presence instead of a mode picker:
 *
 *   udp     always a peer: binds (explicit port, or ephemeral when blank),
 *           learns validated senders, sends to the fixed remote when one is
 *           configured, else to learned peers. Blank bind + blank remote is
 *           rejected — such a socket can neither be reached nor send.
 *   serial  a device path + baud.
 *   tcp     exactly one role: a filled remote host/port dials out (client);
 *           a filled bind port accepts inbound (server). Both or neither is
 *           rejected.
 *
 * A connection's editor form and its runtime constructor both need to agree on
 * which settings a protocol uses and whether a combination is deployable.
 * Keeping that single source of truth here lets the editor show only the
 * relevant rows and flag an undeployable combination before deploy, while the
 * runtime rejects it loudly at deploy time instead of failing on first send.
 *
 * The keys used below are the connection config field names (`bindAddress`,
 * `bindPort`, `remoteHost`, `remotePort`, `serialPath`, `serialBaud`,
 * `reconnect`) so a spec entry maps straight onto the editor inputs and the
 * runtime config. The pre-#243 mode names (`udp-peer`, `udp-in`, `udp-out`,
 * `tcp-client`, `tcp-server`) are not accepted anywhere.
 */

/** Every transport the connection supports, in editor display order. */
const TRANSPORTS = ['udp', 'serial', 'tcp'];

/**
 * Per-protocol visible fields. A field not listed is irrelevant to the
 * protocol and its editor row is hidden (its stored value is preserved
 * untouched, so switching protocols never drops a compatible saved value).
 */
const TRANSPORT_FIELDS = {
  udp: {
    visible: ['bindAddress', 'bindPort', 'remoteHost', 'remotePort']
  },
  serial: {
    visible: ['serialPath', 'serialBaud', 'reconnect']
  },
  tcp: {
    visible: ['bindAddress', 'bindPort', 'remoteHost', 'remotePort', 'reconnect']
  }
};

/** Human-readable label per field, used in validation messages. */
const FIELD_LABELS = {
  bindAddress: 'bind address',
  bindPort: 'bind port',
  remoteHost: 'remote host',
  remotePort: 'remote port',
  serialPath: 'serial path',
  serialBaud: 'baud rate'
};

/**
 * Resolve a protocol's visibility spec, falling back to `udp` for an unknown
 * value so the editor always gets a usable shape (deployability is judged
 * separately by {@link validateConnectionConfig}, which rejects the unknown
 * value itself).
 *
 * @param {string} transport
 * @returns {{visible: string[]}}
 */
function specFor(transport) {
  return TRANSPORT_FIELDS[transport] || TRANSPORT_FIELDS.udp;
}

/**
 * True if a config field's editor row should be visible for `transport`.
 *
 * @param {string} transport
 * @param {string} field  a connection config field name
 * @returns {boolean}
 */
function isFieldVisible(transport, field) {
  return specFor(transport).visible.indexOf(field) !== -1;
}

/**
 * True if `value` is blank (unset, or whitespace-only string). Ports/baud that
 * arrive as numbers are never blank; a cleared editor input arrives as `''`.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Require the remote host/port pair to be all-or-nothing: a host without a
 * port (or vice versa) is unusable for sending, so a partial pair is reported
 * against whichever half is missing.
 *
 * @param {object} config
 * @param {Array<{field: string, message: string}>} problems  appended in place
 * @returns {boolean} true when a complete remote pair is present
 */
function checkRemotePair(config, problems) {
  const hasHost = !isBlank(config.remoteHost);
  const hasPort = !isBlank(config.remotePort);
  if (hasHost && !hasPort) {
    problems.push({ field: 'remotePort', message: 'A remote host needs a remote port.' });
  }
  if (hasPort && !hasHost) {
    problems.push({ field: 'remoteHost', message: 'A remote port needs a remote host.' });
  }
  return hasHost && hasPort;
}

/**
 * Validate a connection config against its protocol's presence rules. Returns
 * a list of problems (empty when deployable); each names the field and why.
 * Deeper checks (port range, address shape) stay with the transport layer,
 * which already reports them structurally.
 *
 * @param {object} config  connection config (at least `transport` plus fields)
 * @returns {Array<{field: string, message: string}>}
 */
function validateConnectionConfig(config = {}) {
  const transport = config.transport || 'udp';
  const problems = [];

  if (transport === 'udp') {
    const hasRemote = checkRemotePair(config, problems);
    if (isBlank(config.bindPort) && !hasRemote && problems.length === 0) {
      problems.push({
        field: 'bindPort',
        message: 'UDP needs a bind port to listen on, a remote host/port to send to, or both.'
      });
    }
    return problems;
  }

  if (transport === 'serial') {
    for (const field of ['serialPath', 'serialBaud']) {
      if (isBlank(config[field])) {
        problems.push({ field, message: `Serial requires a ${FIELD_LABELS[field]}.` });
      }
    }
    return problems;
  }

  if (transport === 'tcp') {
    const hasRemote = checkRemotePair(config, problems);
    const hasBind = !isBlank(config.bindPort);
    if (problems.length) {
      return problems;
    }
    if (hasRemote && hasBind) {
      problems.push({
        field: 'bindPort',
        message: 'TCP takes exactly one role: fill remote host/port to connect out, or bind port to accept — not both.'
      });
    } else if (!hasRemote && !hasBind) {
      problems.push({
        field: 'remoteHost',
        message: 'TCP needs a remote host/port to connect out, or a bind port to accept inbound.'
      });
    }
    return problems;
  }

  return [
    {
      field: 'transport',
      message: `Unknown transport '${transport}'. Use one of: ${TRANSPORTS.join(', ')}.`
    }
  ];
}

module.exports = {
  TRANSPORTS,
  TRANSPORT_FIELDS,
  isFieldVisible,
  isBlank,
  validateConnectionConfig
};
