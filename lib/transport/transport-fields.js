'use strict';

/**
 * Transport field metadata (issue #103).
 *
 * A connection's editor form and its runtime constructor both need to agree on
 * which settings a given transport actually uses and which of those are
 * required. Keeping that single source of truth here lets the editor show only
 * the relevant rows (and validate required values before deploy) while the
 * runtime rejects an impossible combination loudly at deploy time instead of
 * only failing later on the first send.
 *
 * The keys used below are the connection config field names
 * (`bindAddress`, `bindPort`, `remoteHost`, `remotePort`, `serialPath`,
 * `serialBaud`, `reconnect`) so a spec entry maps straight onto the editor
 * inputs and the runtime config.
 */

/** Every transport the connection supports, in editor display order. */
const TRANSPORTS = ['udp-peer', 'udp-in', 'udp-out', 'serial', 'tcp-client', 'tcp-server'];

/**
 * Per-transport field spec.
 *
 * - `visible`: config fields whose editor rows this transport uses. A field not
 *   listed is irrelevant to the transport and its row is hidden (its stored
 *   value is preserved untouched, so switching transports never drops a
 *   compatible saved value — issue #103 migration requirement).
 * - `required`: fields that must carry a non-blank value for the transport to
 *   be usable. These are validated in the editor (before deploy) and again in
 *   the runtime constructor (at deploy).
 * - `receiveOnly`: the transport cannot send; sending is a configuration error.
 * - `remoteOptional`: a remote host/port is accepted but not required, because
 *   the transport can also learn its peer from inbound traffic (udp-peer).
 */
const TRANSPORT_FIELDS = {
  'udp-peer': {
    visible: ['bindAddress', 'bindPort', 'remoteHost', 'remotePort'],
    required: ['bindPort'],
    remoteOptional: true
  },
  'udp-in': {
    visible: ['bindAddress', 'bindPort'],
    required: ['bindPort'],
    receiveOnly: true
  },
  'udp-out': {
    visible: ['remoteHost', 'remotePort'],
    required: ['remoteHost', 'remotePort']
  },
  serial: {
    visible: ['serialPath', 'serialBaud', 'reconnect'],
    required: ['serialPath', 'serialBaud']
  },
  'tcp-client': {
    visible: ['remoteHost', 'remotePort', 'reconnect'],
    required: ['remoteHost', 'remotePort']
  },
  'tcp-server': {
    visible: ['bindAddress', 'bindPort'],
    required: ['bindPort']
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
 * Resolve a transport's spec, falling back to udp-peer for an unknown value so
 * callers always get a usable shape (the runtime separately rejects a genuinely
 * unknown transport when it builds the transport instance).
 *
 * @param {string} transport
 * @returns {{visible: string[], required: string[], receiveOnly?: boolean, remoteOptional?: boolean}}
 */
function specFor(transport) {
  return TRANSPORT_FIELDS[transport] || TRANSPORT_FIELDS['udp-peer'];
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
 * Validate a connection config against its transport's field spec. Returns a
 * list of problems (empty when valid); each names the field and why. Only the
 * required-and-blank case is reported here — deeper checks (port range, address
 * shape) stay with the transport layer, which already reports them structurally.
 *
 * @param {object} config  connection config (at least `transport` plus fields)
 * @returns {Array<{field: string, message: string}>}
 */
function validateConnectionConfig(config = {}) {
  const transport = config.transport || 'udp-peer';
  const spec = specFor(transport);
  const problems = [];
  for (const field of spec.required) {
    if (isBlank(config[field])) {
      problems.push({
        field,
        message: `Transport '${transport}' requires a ${FIELD_LABELS[field] || field}.`
      });
    }
  }
  return problems;
}

module.exports = {
  TRANSPORTS,
  TRANSPORT_FIELDS,
  FIELD_LABELS,
  specFor,
  isFieldVisible,
  validateConnectionConfig
};
