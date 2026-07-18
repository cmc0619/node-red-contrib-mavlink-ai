'use strict';

/**
 * Firmware -> parameter-definition source registry (issue #125).
 *
 * The picker/resolver and editor controls are firmware-agnostic; only this
 * registry knows where each firmware publishes its parameter metadata and which
 * parser reads it. Adding a firmware that later publishes machine-readable
 * metadata is a data change here, not a change to the resolver or UI.
 *
 * The `generic` firmware (and any unknown value) has no standard param-def
 * format, so it resolves to "no source" and the editor keeps its free-text /
 * numeric behavior — graceful degradation is the default path, not a special
 * case.
 */

const { parseApmPdefJson, parsePx4ParamsJson } = require('./param-def-parsers');

/**
 * Profile `vehicleFamily` -> ArduPilot
 * autotest parameter directory. `apm.pdef.json` is generated per vehicle, so a
 * profile whose type isn't a concrete vehicle (gcs / companion computer /
 * generic) has no unambiguous ArduPilot source and degrades to free text.
 */
const ARDUPILOT_VEHICLE_DIR = {
  copter: 'ArduCopter',
  plane: 'ArduPlane',
  rover: 'Rover',
  boat: 'Rover',
  sub: 'ArduSub',
  'antenna-tracker': 'AntennaTracker'
};

/** Base for ArduPilot's per-vehicle generated parameter metadata. */
const ARDUPILOT_AUTOTEST_BASE = 'https://autotest.ardupilot.org/Parameters';

/**
 * Resolve the parameter-definition source for a profile's firmware/vehicle, or
 * null when none applies (unknown firmware, generic/custom, or an ArduPilot
 * profile whose type isn't a concrete vehicle).
 *
 * @param {object} ctx
 * @param {string} ctx.firmware      profile firmware (generic|ardupilot|px4|custom)
 * @param {string} [ctx.vehicleType] profile type doubling as vehicle (copter|plane|...)
 * @returns {?{sourceKey:string, firmware:string, vehicleType:?string, format:string,
 *   url:?string, urlRequired:boolean, parse:function(string):Array}}
 */
function resolveParamDefSource(ctx = {}) {
  const firmware = String(ctx.firmware || '').toLowerCase();
  const vehicleType = ctx.vehicleType ? String(ctx.vehicleType).toLowerCase() : '';

  if (firmware === 'ardupilot') {
    const dir = ARDUPILOT_VEHICLE_DIR[vehicleType];
    if (!dir) {
      return null;
    }
    return {
      sourceKey: `ardupilot-${vehicleType}`,
      firmware,
      vehicleType,
      format: 'apm-pdef-json',
      url: `${ARDUPILOT_AUTOTEST_BASE}/${dir}/apm.pdef.json`,
      urlRequired: false,
      parse: parseApmPdefJson
    };
  }

  if (firmware === 'px4') {
    /**
     * PX4 publishes `parameters.json` as a build artifact rather than at one
     * stable public URL, so there is no baked-in default — the editor supplies
     * the URL (a release asset, a self-hosted copy, or a version pin) and the
     * parser reads it. The source is still first-class so PX4 selection works
     * and the value pulldowns populate once a URL is provided.
     *
     * Key the cache by vehicle type (like ArduPilot) so distinct vehicle
     * profiles don't overwrite each other's cached catalog. The lookup path
     * (`get`/`paramChoices`) resolves the key from firmware+vehicle only — it
     * has no URL in hand — so re-downloading a different URL for the SAME
     * vehicle context deliberately replaces that context's cache (a refresh),
     * which is the same overwrite semantics ArduPilot already has.
     */
    return {
      sourceKey: vehicleType ? `px4-${vehicleType}` : 'px4',
      firmware,
      vehicleType: vehicleType || null,
      format: 'px4-params-json',
      url: null,
      urlRequired: true,
      parse: parsePx4ParamsJson
    };
  }

  return null;
}

module.exports = { resolveParamDefSource };
