'use strict';

const { minimal, standard, common } = require('node-mavlink');
const { buildEnumIndex } = require('./enum-resolver');
const { MavlinkError } = require('../util/errors');

const CORE_ENUMS = buildEnumIndex([minimal, standard, common]);

function unavailable(enumName, memberKey, context = {}) {
  const errorContext = {
    enum: enumName,
    member: memberKey,
    dialect: context.dialect || 'unknown',
    consumer: context.consumer || 'unknown'
  };
  throw new MavlinkError(
    'ENUM_VALUE_UNAVAILABLE',
    `Cannot resolve ${enumName}.${String(memberKey)} for ${errorContext.consumer} in dialect '${errorContext.dialect}'.`,
    errorContext
  );
}

/**
 * Bind an enum resolver to one dialect enum index. The returned `value`
 * function maps an exact `(enumName, memberKey)` to its number and throws
 * ENUM_VALUE_UNAVAILABLE when the enum or member is absent — the strict
 * protocol-value boundary. `value.members(enumName)` lists an enum's
 * `{ name, value }` members (numeric-key aliases filtered out).
 *
 * @param {?object} index  a generated dialect enum index ({ enumsByName }), or
 *   null/absent (every lookup then throws ENUM_VALUE_UNAVAILABLE)
 * @param {object} [context]  { dialect, consumer } — labels for the error
 * @returns {function(string, string=): number} the bound resolver, with a
 *   `.members(enumName)` helper
 */
function bindEnumValues(index, context = {}) {
  const table = (enumName, memberKey = null) => {
    const members = index && index.enumsByName && index.enumsByName[enumName];
    if (!members || (memberKey !== null && (typeof memberKey !== 'string' || typeof members[memberKey] !== 'number'))) {
      unavailable(enumName, memberKey, context);
    }
    return members;
  };
  const value = (enumName, memberKey) => table(enumName, memberKey)[memberKey];
  value.members = (enumName) => Object.entries(table(enumName))
    .filter(([key, member]) => !/^\d+$/.test(key) && typeof member === 'number')
    .map(([name, member]) => ({ name, value: member }));
  return value;
}

/**
 * Bind an enum resolver to the always-available core dialects (minimal +
 * standard + common). Use this for dialect-independent protocol values that
 * must resolve regardless of the profile's configured dialect.
 *
 * @param {object} [context]  { consumer } — label for the error (dialect defaults to 'common')
 * @returns {function(string, string=): number} the bound core resolver
 */
function coreEnumValues(context = {}) {
  return bindEnumValues(CORE_ENUMS, { dialect: 'common', ...context });
}

module.exports = { bindEnumValues, coreEnumValues };
