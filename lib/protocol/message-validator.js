'use strict';

const { getMessageClass } = require('../dialects/dialect-loader');

/**
 * Lightweight message validation (DESIGN.md §16, §13.3).
 *
 * MAVLink has no real "required field" concept at the wire level — every field
 * has a defined size and zero-fills if absent. So validation here is about
 * catching author mistakes early: an unknown message name, or field keys that
 * don't exist on the message. It deliberately does not reject under-specified
 * messages, since zero-filled fields are valid MAVLink.
 */
function validate(bundle, name, fields) {
  const result = { valid: true, errors: [], unknownFields: [] };

  if (!bundle || !bundle.valid) {
    result.valid = false;
    result.errors.push('Dialect is not loaded.');
    return result;
  }

  const clazz = getMessageClass(bundle, name);
  if (!clazz) {
    result.valid = false;
    result.errors.push(`Unknown message '${name}' for dialect '${bundle.name}'.`);
    return result;
  }

  const known = new Set();
  for (const field of clazz.FIELDS) {
    known.add(field.source);
    known.add(field.name);
  }

  const input = fields && typeof fields === 'object' ? fields : {};
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      result.unknownFields.push(key);
    }
  }

  // Unknown fields are a soft warning, not a hard failure — they are ignored
  // when building, but reporting them helps authors catch typos.
  return result;
}

module.exports = { validate };
