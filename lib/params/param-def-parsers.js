'use strict';

/**
 * Parsers that normalize firmware-specific parameter-metadata files into one
 * common index (issue #125). MAVLink dialect XML describes messages/commands/
 * enums but NOT parameter value tables (a param's range, `Values:`, `Bitmask:`),
 * so those come from separate firmware sources:
 *
 *   ArduPilot  apm.pdef.json  (generated per firmware + vehicle)
 *   PX4        parameters.json
 *
 * Both are reduced to a `ParamDef[]`, so the picker/resolver and the editor
 * controls stay firmware-agnostic — only these parsers know the source shapes.
 *
 * @typedef {object} ParamDef
 * @property {string} paramId  canonical upper-case parameter name
 * @property {?string} type    MAV_PARAM_TYPE_* when derivable, else null
 * @property {?string} units
 * @property {?{min:?number, max:?number}} range
 * @property {Array<{value:number, label:string}>} values  enumerated choices
 * @property {Array<{bit:number, label:string}>} bitmask   bit-flag choices
 * @property {?string} description
 */

const { MavlinkError } = require('../util/errors');

/**
 * Map a PX4 metadata `type` token to a MAV_PARAM_TYPE_* name. ArduPilot's
 * pdef carries no wire type, so its params resolve to null (the editor's
 * "Auto (detect from vehicle)" path handles them).
 */
const PX4_TYPE_TO_MAV = {
  FLOAT: 'MAV_PARAM_TYPE_REAL32',
  INT32: 'MAV_PARAM_TYPE_INT32'
};

/**
 * Coerce a value to a finite number, or return null. Accepts numeric strings
 * (firmware metadata frequently keys tables by stringified integers).
 *
 * @param {*} raw
 * @returns {?number}
 */
function toFiniteNumber(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a `"k:label,k2:label2"` table string (an older ArduPilot pdef shape)
 * into `[key, label]` pairs. Tolerates whitespace and a trailing separator.
 *
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
function parsePairString(text) {
  return String(text)
    .split(',')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const idx = chunk.indexOf(':');
      if (idx === -1) {
        return null;
      }
      return [chunk.slice(0, idx).trim(), chunk.slice(idx + 1).trim()];
    })
    .filter(Boolean);
}

/**
 * Normalize an enumerated-values table from any of the shapes firmware sources
 * use: an object map (`{"0":"Disabled"}`), an array of entry objects
 * (`[{value,description}]`), or a `"0:Disabled,1:Enabled"` string. Entries with
 * a non-numeric key are dropped. Sorted ascending by value.
 *
 * @param {*} raw
 * @returns {Array<{value:number, label:string}>}
 */
function normalizeValues(raw) {
  if (!raw) {
    return [];
  }
  let pairs = [];
  if (typeof raw === 'string') {
    pairs = parsePairString(raw);
  } else if (Array.isArray(raw)) {
    pairs = raw
      .filter((e) => e && typeof e === 'object')
      .map((e) => [e.value !== undefined ? e.value : e.val, e.description || e.label || e.name || '']);
  } else if (typeof raw === 'object') {
    pairs = Object.keys(raw).map((k) => [k, raw[k]]);
  }
  const out = [];
  for (const [key, label] of pairs) {
    const value = toFiniteNumber(key);
    if (value === null) {
      continue;
    }
    out.push({ value, label: String(label === undefined || label === null ? '' : label).trim() });
  }
  out.sort((a, b) => a.value - b.value);
  return out;
}

/**
 * Normalize a bitmask table from the same set of shapes as {@link normalizeValues},
 * except the numeric key is a bit index (`{index,description}` for array
 * entries). Sorted ascending by bit.
 *
 * @param {*} raw
 * @returns {Array<{bit:number, label:string}>}
 */
function normalizeBitmask(raw) {
  if (!raw) {
    return [];
  }
  let pairs = [];
  if (typeof raw === 'string') {
    pairs = parsePairString(raw);
  } else if (Array.isArray(raw)) {
    pairs = raw
      .filter((e) => e && typeof e === 'object')
      .map((e) => [e.index !== undefined ? e.index : e.bit, e.description || e.label || e.name || '']);
  } else if (typeof raw === 'object') {
    pairs = Object.keys(raw).map((k) => [k, raw[k]]);
  }
  const out = [];
  for (const [key, label] of pairs) {
    const bit = toFiniteNumber(key);
    if (bit === null || bit < 0 || !Number.isInteger(bit)) {
      continue;
    }
    out.push({ bit, label: String(label === undefined || label === null ? '' : label).trim() });
  }
  out.sort((a, b) => a.bit - b.bit);
  return out;
}

/**
 * Build a range from a low/high pair, or null when neither bound is present.
 *
 * @param {?number} min
 * @param {?number} max
 * @returns {?{min:?number, max:?number}}
 */
function makeRange(min, max) {
  if (min === null && max === null) {
    return null;
  }
  return { min, max };
}

/** Metadata keys that mark an object as one ArduPilot parameter's definition. */
const APM_META_KEYS = ['Description', 'DisplayName', 'Values', 'Range', 'Bitmask', 'Units', 'User', 'Increment'];

/**
 * Whether an object is an ArduPilot parameter definition (vs. a grouping node).
 *
 * @param {*} obj
 * @returns {boolean}
 */
function looksLikeApmParamMeta(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  return Object.keys(obj).some((k) => APM_META_KEYS.includes(k));
}

/**
 * Convert one ArduPilot parameter-metadata object to a ParamDef.
 *
 * @param {string} paramId
 * @param {object} meta
 * @returns {ParamDef}
 */
function apmParamDef(paramId, meta) {
  const range = meta.Range && typeof meta.Range === 'object' ? meta.Range : null;
  return {
    paramId,
    type: null,
    units: meta.Units ? String(meta.Units) : null,
    range: range
      ? makeRange(
          toFiniteNumber(range.low !== undefined ? range.low : range.min),
          toFiniteNumber(range.high !== undefined ? range.high : range.max)
        )
      : null,
    values: normalizeValues(meta.Values),
    bitmask: normalizeBitmask(meta.Bitmask),
    description: meta.Description ? String(meta.Description).trim() : meta.DisplayName ? String(meta.DisplayName).trim() : null
  };
}

/**
 * Parse an ArduPilot `apm.pdef.json`. The file nests parameters under
 * vehicle/library group objects, but the exact depth varies by generator
 * version (top-level vehicle labels like `"ArduCopter 4.5.0"`, group names, and
 * sometimes a `json`/`version` metadata block). Rather than assume a fixed
 * depth, walk the tree and treat any object carrying parameter-metadata keys
 * (`Description`, `Values`, `Range`, `Bitmask`, ...) as a parameter, keyed by
 * its property name. Non-parameter branches are descended into; scalars ignored.
 *
 * @param {string} text  the raw file text
 * @returns {ParamDef[]} deduped by paramId, first definition wins
 */
function parseApmPdefJson(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new MavlinkError('PARAM_DEF_PARSE_FAILED', `apm.pdef.json is not valid JSON: ${err.message}`);
  }
  if (!root || typeof root !== 'object') {
    throw new MavlinkError('PARAM_DEF_PARSE_FAILED', 'apm.pdef.json has no parameter object at its root.');
  }
  const byId = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (looksLikeApmParamMeta(child)) {
        const paramId = String(key).trim().toUpperCase();
        if (paramId !== '' && !byId.has(paramId)) {
          byId.set(paramId, apmParamDef(paramId, child));
        }
      } else if (child && typeof child === 'object') {
        walk(child);
      }
    }
  };
  walk(root);
  return [...byId.values()];
}

/**
 * Parse a PX4 `parameters.json`. The generated file is `{ parameters: [ ... ] }`
 * where each entry carries `name`, `type` (`FLOAT`/`INT32`), `min`, `max`,
 * `units`, `shortDesc`/`longDesc`, and optional `values`/`bitmask` tables. Some
 * generations nest params under group objects instead of a flat array; both are
 * handled.
 *
 * @param {string} text  the raw file text
 * @returns {ParamDef[]} deduped by paramId, first definition wins
 */
function parsePx4ParamsJson(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new MavlinkError('PARAM_DEF_PARSE_FAILED', `PX4 parameters.json is not valid JSON: ${err.message}`);
  }
  if (!root || typeof root !== 'object') {
    throw new MavlinkError('PARAM_DEF_PARSE_FAILED', 'PX4 parameters.json has no object at its root.');
  }
  let entries = [];
  if (Array.isArray(root.parameters)) {
    entries = root.parameters;
  } else if (root.parameters && typeof root.parameters === 'object') {
    entries = Object.values(root.parameters);
  } else if (Array.isArray(root)) {
    entries = root;
  }
  const byId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.name === undefined) {
      continue;
    }
    const paramId = String(entry.name).trim().toUpperCase();
    if (paramId === '' || byId.has(paramId)) {
      continue;
    }
    const typeToken = entry.type ? String(entry.type).toUpperCase() : '';
    byId.set(paramId, {
      paramId,
      type: PX4_TYPE_TO_MAV[typeToken] || null,
      units: entry.units ? String(entry.units) : null,
      range: makeRange(toFiniteNumber(entry.min), toFiniteNumber(entry.max)),
      values: normalizeValues(entry.values),
      bitmask: normalizeBitmask(entry.bitmask),
      description: entry.shortDesc ? String(entry.shortDesc).trim() : entry.longDesc ? String(entry.longDesc).trim() : null
    });
  }
  return [...byId.values()];
}

module.exports = {
  parseApmPdefJson,
  parsePx4ParamsJson,
  normalizeValues,
  normalizeBitmask
};
