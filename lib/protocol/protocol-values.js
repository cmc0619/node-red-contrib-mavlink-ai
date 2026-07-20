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
  return new MavlinkError(
    'ENUM_VALUE_UNAVAILABLE',
    `Cannot resolve ${enumName}.${String(memberKey)} for ${errorContext.consumer} in dialect '${errorContext.dialect}'.`,
    errorContext
  );
}

function requireEnumMember(index, enumName, memberKey, context = {}) {
  const table = index && index.enumsByName && index.enumsByName[enumName];
  if (!table || typeof memberKey !== 'string' || typeof table[memberKey] !== 'number') {
    throw unavailable(enumName, memberKey, context);
  }
  return table[memberKey];
}

function enumMembers(index, enumName, context = {}) {
  const table = index && index.enumsByName && index.enumsByName[enumName];
  if (!table) {
    throw unavailable(enumName, null, context);
  }
  return Object.entries(table)
    .filter(([key, value]) => !/^\d+$/.test(key) && typeof value === 'number')
    .map(([name, value]) => ({ name, value }));
}

function coreEnumMember(enumName, memberKey, context = {}) {
  return requireEnumMember(CORE_ENUMS, enumName, memberKey, {
    dialect: 'common',
    ...context
  });
}

function bindEnumValues(index, context = {}) {
  const value = (enumName, memberKey) => requireEnumMember(index, enumName, memberKey, context);
  value.members = (enumName) => enumMembers(index, enumName, context);
  return value;
}

function coreEnumValues(context = {}) {
  return bindEnumValues(CORE_ENUMS, { dialect: 'common', ...context });
}

module.exports = {
  requireEnumMember,
  enumMembers,
  coreEnumMember,
  bindEnumValues,
  coreEnumValues
};
