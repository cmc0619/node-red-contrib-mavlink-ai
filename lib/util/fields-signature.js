'use strict';

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
 * @param {object} fields  decoded §14.1 fields object
 * @returns {string}
 */
function fieldsSignature(fields) {
  return JSON.stringify(fields, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

module.exports = { fieldsSignature };
