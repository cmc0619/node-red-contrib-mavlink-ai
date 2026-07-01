'use strict';

const mappings = require('mavlink-mappings');
const { MavlinkError } = require('../util/errors');
const { buildEnumIndex } = require('../protocol/enum-resolver');

/**
 * Dialect loading for the profile/protocol layer (DESIGN.md §15).
 *
 * Dialects are loaded from the bundled `mavlink-mappings` package. MAVLink
 * dialects use XML `<include>` inheritance; the generated package keeps each
 * dialect's own messages/enums in a separate module, so we re-create the
 * inheritance chain here by merging modules in include order.
 *
 * Loud-failure rule: an unknown or unloadable dialect throws/marks invalid.
 * Silent fallback to `common` is forbidden because it creates fake success.
 */

// Include order per dialect. The big shared dialect is `common`, which itself
// includes `minimal` and `standard`. Vehicle dialects include `common`.
const DIALECT_CHAINS = {
  minimal: ['minimal'],
  standard: ['minimal', 'standard'],
  common: ['minimal', 'standard', 'common'],
  ardupilotmega: ['minimal', 'standard', 'common', 'ardupilotmega'],
  uavionix: ['minimal', 'standard', 'common', 'uavionix'],
  icarous: ['minimal', 'standard', 'common', 'icarous'],
  asluav: ['minimal', 'standard', 'common', 'asluav'],
  development: ['minimal', 'standard', 'common', 'development'],
  ualberta: ['minimal', 'standard', 'common', 'ualberta'],
  storm32: ['minimal', 'standard', 'common', 'storm32']
};

/**
 * List the dialect names this loader can serve from the bundled package.
 *
 * @returns {string[]}
 */
function knownDialects() {
  return Object.keys(DIALECT_CHAINS);
}

/**
 * Resolve the requested dialect name. `custom` is honoured only when the
 * supplied path names a bundled dialect (runtime XML compilation is not
 * supported in v2 — see DESIGN.md §15). Anything else fails loudly.
 */
function resolveDialectName(name, customDialectPath) {
  if (name === 'custom') {
    const candidate = String(customDialectPath || '').trim();
    const bare = candidate.replace(/^.*[\\/]/, '').replace(/\.xml$/i, '').toLowerCase();
    if (DIALECT_CHAINS[bare]) {
      return bare;
    }
    throw new MavlinkError(
      'DIALECT_LOAD_FAILED',
      `Custom dialect path '${candidate}' is not a bundled dialect. ` +
        `Runtime XML compilation is not supported; choose one of: ${knownDialects().join(', ')}.`,
      { dialect: name, customDialectPath: candidate }
    );
  }
  if (!DIALECT_CHAINS[name]) {
    throw new MavlinkError(
      'DIALECT_LOAD_FAILED',
      `Unknown dialect '${name}'. Available: ${knownDialects().join(', ')}.`,
      { dialect: name }
    );
  }
  return name;
}

/**
 * Load a dialect bundle. Never throws: on failure it returns an invalid bundle
 * with a structured error so the profile can mark itself invalid and nodes can
 * report a useful message instead of silently misbehaving.
 *
 * @param {string} name  dialect name (e.g. "ardupilotmega" or "custom")
 * @param {object} [opts]
 * @param {string} [opts.customDialectPath]
 * @returns {DialectBundle}
 */
function loadDialect(name, opts = {}) {
  try {
    const resolved = resolveDialectName(name, opts.customDialectPath);
    const chain = DIALECT_CHAINS[resolved];
    const modules = chain.map((d) => {
      const mod = mappings[d];
      if (!mod) {
        throw new MavlinkError('DIALECT_LOAD_FAILED', `Bundled dialect module '${d}' is missing.`, {
          dialect: resolved
        });
      }
      return mod;
    });

    // Merge registries (msgid -> class) in include order. Later wins, but
    // msgids are globally unique so order is not load-bearing.
    const registry = {};
    const byName = {};
    for (const mod of modules) {
      if (!mod.REGISTRY) {
        continue;
      }
      for (const [id, clazz] of Object.entries(mod.REGISTRY)) {
        registry[id] = clazz;
        byName[clazz.MSG_NAME] = clazz;
      }
    }

    const enums = buildEnumIndex(modules);

    return {
      name: resolved,
      requested: name,
      valid: true,
      error: null,
      modules,
      registry,
      byName,
      enums,
      // Global CRC-extra table; the splitter uses it to validate V2 packets
      // whose declared payload length may be truncated.
      magicNumbers: mappings.MSG_ID_MAGIC_NUMBER
    };
  } catch (err) {
    const e =
      err instanceof MavlinkError
        ? err
        : new MavlinkError('DIALECT_LOAD_FAILED', err.message, { dialect: name });
    return {
      name,
      requested: name,
      valid: false,
      error: { code: e.code, message: e.message, context: e.context },
      modules: [],
      registry: {},
      byName: {},
      enums: { byFullName: new Map(), byMember: new Map(), enumsByName: {} },
      magicNumbers: mappings.MSG_ID_MAGIC_NUMBER
    };
  }
}

/**
 * Look up a message class by name (e.g. "HEARTBEAT") or numeric id.
 */
function getMessageClass(bundle, nameOrId) {
  if (!bundle || !bundle.valid) {
    return undefined;
  }
  if (typeof nameOrId === 'number') {
    return bundle.registry[nameOrId];
  }
  if (/^\d+$/.test(String(nameOrId))) {
    return bundle.registry[Number(nameOrId)];
  }
  return bundle.byName[String(nameOrId).toUpperCase()] || bundle.byName[String(nameOrId)];
}

module.exports = {
  DIALECT_CHAINS,
  knownDialects,
  resolveDialectName,
  loadDialect,
  getMessageClass
};
