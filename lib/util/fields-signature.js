'use strict';

const { nonFiniteFloatToString } = require('./float-sentinels');

/**
 * BigInt-safe signature for a decoded message's fields, used by the changed-only
 * comparison in the subscription registry and the filter node (#73).
 *
 * MAVLink has 64-bit fields (uint64_t/int64_t — e.g. the `time_usec` timestamp
 * on many messages), which node-mavlink decodes as BigInt. A plain
 * `JSON.stringify(fields)` throws `TypeError: Do not know how to serialize a
 * BigInt` on those, which in the subscription registry happens outside the
 * per-subscriber try/catch and would abort dispatch for the whole packet. Coerce
 * BigInt to its decimal string so the signature is stable and comparable.
 *
 * Non-finite floats get the same string representation as the decoded §14.1
 * payload ("NaN"/"Infinity"/"-Infinity"). Decoded fields already carry those as
 * strings, but normalizing here too keeps the signature correct for any caller
 * and — critically — keeps NaN, Infinity and -Infinity distinct: a bare
 * `JSON.stringify` collapses all three (and a genuine null) to `null`, so a
 * NaN→Infinity change would otherwise be invisible to changed-only filtering.
 *
 * @param {object} fields  decoded §14.1 fields object
 * @returns {string}
 */
function fieldsSignature(fields) {
  return JSON.stringify(fields, (_key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return nonFiniteFloatToString(value);
    }
    return value;
  });
}

module.exports = { fieldsSignature };
