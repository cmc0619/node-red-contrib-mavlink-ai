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

function coreEnumValues(context = {}) {
  return bindEnumValues(CORE_ENUMS, { dialect: 'common', ...context });
}

module.exports = { bindEnumValues, coreEnumValues };
