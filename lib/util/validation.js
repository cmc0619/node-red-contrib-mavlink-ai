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
 * Coerce a value to a number (fractions preserved), returning `fallback` for
 * blank/non-numeric input. Use this instead of {@link toInt} for values like
 * rate limits where 0.5 is meaningful and truncation would silently disable
 * the feature.
 *
 * @param {*} value
 * @param {number} [fallback]
 * @returns {number}
 */
function toNum(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
 * Strict variant of {@link parseIdList}: a non-empty token that is neither a
 * wildcard nor an integer in [0, 255] is REPORTED as invalid instead of being
 * silently dropped (#193). `parseIdList` fails open — `"1O"` becomes `[]`
 * (accept everything) and `"1,2x"` becomes `[1]` (silently narrowed) — which
 * turns a typo in a safety/routing filter into wider access, the same
 * fail-open class the RouteTable closed in #71. Callers surface `invalid` as a
 * structured configuration error and fail closed.
 *
 * @param {*} value
 * @param {number} [max=255]  inclusive upper bound: 255 for sysid/compid uint8
 *   identities, 16777215 for 24-bit v2 message ids.
 * @returns {{ ids: number[], wildcard: boolean, invalid: string[] }}
 *   `wildcard` true when the list means "accept everything"; `ids` the accepted
 *   ids otherwise; `invalid` the offending tokens (empty when all are valid).
 */
function parseIdListStrict(value, max = 255) {
  const items = parseList(value);
  if (items.some((v) => isWildcard(v))) {
    return { ids: [], wildcard: true, invalid: [] };
  }
  const ids = [];
  const invalid = [];
  for (const item of items) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 0 && n <= max) {
      ids.push(n);
    } else {
      invalid.push(item);
    }
  }
  return { ids, wildcard: false, invalid };
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
 * Parse a static JSON-object config string. Blank is the documented empty
 * default (`{}`). A non-empty value that fails to parse, or parses to a
 * non-object (array/scalar), is a configuration error the caller must surface
 * — it is NEVER silently substituted with `{}`, which would let a malformed or
 * imported flow keep running and send a valid-but-unintended message (#204).
 *
 * @param {*} raw    the stored config value (string, or an already-parsed value)
 * @param {string} label  field name, for the error message
 * @returns {{ value: object, error: ?string }} `error` non-null when invalid
 */
function parseJsonObjectConfig(raw, label) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: {}, error: null };
  }
  if (typeof raw === 'object') {
    /** Already-parsed (programmatic config): an object is fine; array/other is not. */
    if (Array.isArray(raw)) {
      return { value: {}, error: `${label} must be a JSON object, not an array.` };
    }
    return { value: raw, error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e) {
    return { value: {}, error: `${label} is not valid JSON (${e.message}).` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, error: `${label} must be a JSON object.` };
  }
  return { value: parsed, error: null };
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
  toNum,
  toBool,
  parseList,
  parseIdList,
  parseIdListStrict,
  isWildcard,
  idAccepted,
  parseJsonObjectConfig,
  firstDefined
};
