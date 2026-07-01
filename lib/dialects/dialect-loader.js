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
 * True if a custom dialect path points at an XML file to compile at runtime
 * (as opposed to naming a bundled dialect basename).
 *
 * @param {string} customDialectPath
 * @returns {boolean}
 */
function isCustomXmlPath(customDialectPath) {
  return /\.xml$/i.test(String(customDialectPath || '').trim());
}

/**
 * Resolve the requested dialect name to a bundled dialect. `custom` is honoured
 * here only when the supplied path names a bundled dialect basename; an XML file
 * path is compiled at runtime instead (see {@link loadDialect}). Anything else
 * fails loudly — no silent fallback to `common`.
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
      `Custom dialect path '${candidate}' is neither a bundled dialect nor an .xml file. ` +
        `Provide a path to a MAVLink XML dialect, or choose one of: ${knownDialects().join(', ')}.`,
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
 * Assemble a dialect bundle from an ordered list of dialect modules (bundled or
 * synthetic). Merges message registries and builds the enum index; the caller
 * supplies the magic-number table.
 *
 * @param {string} name  resolved dialect name
 * @param {string} requested  the originally requested name
 * @param {object[]} modules  dialect modules in include order
 * @param {object} magicNumbers  msgid -> CRC-extra table
 * @returns {DialectBundle}
 */
function buildBundleFromModules(name, requested, modules, magicNumbers) {
  // Merge registries (msgid -> class) in include order. Later wins, but msgids
  // are globally unique so order is not load-bearing.
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
  return {
    name,
    requested,
    valid: true,
    error: null,
    modules,
    registry,
    byName,
    enums: buildEnumIndex(modules),
    magicNumbers
  };
}

/**
 * Compile a custom XML dialect path into a bundle (issue #2). The compiled
 * message CRC-extra values win over the global table so custom/overridden
 * message ids validate correctly.
 *
 * @param {string} xmlPath
 * @param {object} opts  { includeDirs }
 * @returns {DialectBundle}
 */
function loadCustomXmlBundle(xmlPath, opts) {
  // eslint-disable-next-line global-require
  const { compileXmlDialect } = require('./xml-dialect-compiler');
  const compiled = compileXmlDialect(xmlPath, { includeDirs: opts.includeDirs });
  const bundle = buildBundleFromModules(
    compiled.name,
    'custom',
    [compiled.module],
    Object.assign({}, mappings.MSG_ID_MAGIC_NUMBER, compiled.magicNumbers)
  );
  bundle.customDialectPath = xmlPath;
  bundle.files = compiled.files;
  return bundle;
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
    // A custom XML file path is compiled at runtime (issue #2); a bare `custom`
    // basement still resolves to a bundled dialect via resolveDialectName.
    if (name === 'custom' && isCustomXmlPath(opts.customDialectPath)) {
      return loadCustomXmlBundle(String(opts.customDialectPath).trim(), opts);
    }

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

    // Global CRC-extra table; the splitter uses it to validate V2 packets whose
    // declared payload length may be truncated.
    return buildBundleFromModules(resolved, name, modules, mappings.MSG_ID_MAGIC_NUMBER);
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
