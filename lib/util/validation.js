'use strict';

/**
 * Small coercion/parsing helpers shared by nodes and lib modules.
 * Node-RED config values arrive as strings, so be defensive.
 */

/**
 * Coerce a value to an integer, returning `fallback` for blank/non-numeric input.
 *
 * @param {*} value
 * @param {number} [fallback]
 * @returns {number}
 */
function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Coerce a value to a boolean, understanding Node-RED string booleans
 * ("true"/"1"/"on"/"yes"). Blank input returns `fallback`.
 *
 * @param {*} value
 * @param {boolean} [fallback=false]
 * @returns {boolean}
 */
function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value === 'true' || value === '1' || value === 'on' || value === 'yes';
  }
  return Boolean(value);
}

/**
 * Parse a comma/space separated list into a trimmed array, dropping blanks.
 */
function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (value === undefined || value === null) {
    return [];
  }
  return String(value)
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Parse a list of numeric ids. The literal "*" / "any" / "all" is treated as
 * "no constraint" and yields an empty array (meaning: accept everything).
 */
function parseIdList(value) {
  const items = parseList(value);
  if (items.some((v) => isWildcard(v))) {
    return [];
  }
  return items.map((v) => Number(v)).filter((n) => Number.isFinite(n));
}

/**
 * True if a value means "no constraint": blank, `*`, `any`, or `all`.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isWildcard(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  const s = String(value).trim().toLowerCase();
  return s === '*' || s === 'any' || s === 'all';
}

/**
 * Returns true if `id` is accepted given a list of allowed ids. An empty list
 * means "accept everything".
 */
function idAccepted(id, allowed) {
  if (!allowed || allowed.length === 0) {
    return true;
  }
  return allowed.includes(Number(id));
}

/**
 * Return the first argument that is neither undefined nor null. Shared by the
 * flow nodes so target/param default resolution stays consistent.
 *
 * @param {...*} values
 * @returns {*}
 */
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) {
      return v;
    }
  }
  return undefined;
}

module.exports = {
  toInt,
  toBool,
  parseList,
  parseIdList,
  isWildcard,
  idAccepted,
  firstDefined
};
