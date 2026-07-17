#!/usr/bin/env node
'use strict';

const { VirtualFleet } = require('./virtual-fleet');

/**
 * Launch a virtual multi-drone MAVLink SITL and stream it at a GCS endpoint.
 *
 * This is a development/testing helper (it is NOT shipped in the npm package).
 * It drives the same {@link VirtualFleet} engine the CI test uses, so pointing
 * Node-RED at it exercises exactly the behavior the regression test guards.
 *
 * Every option has a CLI flag and an environment variable (the env var is what
 * the Docker image reads). Flags win over env vars.
 *
 *   --count N          drones in this process              (FLEET_COUNT, default 3)
 *   --sysid N          first system id; drones are N..N+count-1 (SYSID, default 1)
 *   --gcs-host HOST    where the GCS/Node-RED listens       (GCS_HOST, default 127.0.0.1)
 *   --gcs-port PORT    the udp-peer port to stream to       (GCS_PORT, default 14550)
 *   --bind-port PORT   this fleet's UDP source port, 0=any  (BIND_PORT, default 0)
 *   --dialect NAME     MAVLink dialect                      (DIALECT, default ardupilotmega)
 *   --lat --lon --alt  fleet origin (deg, deg, m AMSL)      (default 39.1 / -75.1 / 40)
 *   --spacing M        initial east spacing between drones  (default 10)
 *   --speed M          horizontal cruise, m/s               (default 5)
 *
 * Docker usage runs one drone per container with a distinct SYSID; a single
 * process can also host the whole fleet with --count.
 */

/** Minimal `--flag value` / `--flag=value` parser (no dependency). */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      out[arg.slice(2)] = next !== undefined && !next.startsWith('--') ? (i += 1, next) : true;
    }
  }
  return out;
}

/** First defined of flag / env / default, parsed as a number when numeric. */
function pick(args, flag, env, dflt) {
  const raw = args[flag] !== undefined ? args[flag] : process.env[env] !== undefined ? process.env[env] : dflt;
  return raw;
}
/**
 * Coerce a picked value (which may be a string from a flag/env) to a number.
 *
 * @param {*} v
 * @returns {number}
 */
function num(v) {
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Parse configuration, start the fleet, print a status line periodically, and
 * shut down cleanly on SIGINT/SIGTERM.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = {
    count: num(pick(args, 'count', 'FLEET_COUNT', 3)),
    baseSysid: num(pick(args, 'sysid', 'SYSID', 1)),
    dialect: String(pick(args, 'dialect', 'DIALECT', 'ardupilotmega')),
    origin: {
      lat: num(pick(args, 'lat', 'ORIGIN_LAT', 39.1)),
      lon: num(pick(args, 'lon', 'ORIGIN_LON', -75.1)),
      alt: num(pick(args, 'alt', 'ORIGIN_ALT', 40))
    },
    spacingM: num(pick(args, 'spacing', 'SPACING', 10)),
    speed: num(pick(args, 'speed', 'SPEED', 5))
  };
  const gcsHost = String(pick(args, 'gcs-host', 'GCS_HOST', '127.0.0.1'));
  const gcsPort = num(pick(args, 'gcs-port', 'GCS_PORT', 14550));
  const bindPort = num(pick(args, 'bind-port', 'BIND_PORT', 0));

  const fleet = new VirtualFleet(config);
  fleet.on('command', (c) => {
    const RESULT = { 0: 'ACCEPTED', 2: 'DENIED', 3: 'UNSUPPORTED' };
    console.log(`[cmd] sysid ${c.sysid} command ${c.command} -> ${RESULT[c.result] || c.result}`);
  });
  fleet.on('decodeError', (err) => console.error(`[decode] ${err.message}`));
  fleet.on('error', (err) => console.error(`[socket] ${err.message}`));

  const { port } = await fleet.start({ gcsHost, gcsPort, bindPort });
  const last = config.baseSysid + config.count - 1;
  console.log(
    `Virtual fleet up: ${config.count} drone(s) sysid ${config.baseSysid}..${last}, ` +
      `dialect ${config.dialect}, streaming to ${gcsHost}:${gcsPort} from udp/${port}.`
  );
  console.log(`Origin ${config.origin.lat},${config.origin.lon} @ ${config.origin.alt} m, ${config.spacingM} m apart.`);

  // Periodic status. This interval is intentionally NOT unref'd, so it holds the
  // process open (the fleet's own telemetry timers are unref'd for embedding).
  setInterval(() => {
    const snap = fleet.snapshot();
    const armed = snap.filter((d) => d.armed).length;
    const sep = fleet.drones.length > 1 ? ` | min sep ${fleet.currentMinSeparation().toFixed(1)} m` : '';
    console.log(`[status] ${armed}/${snap.length} armed${sep}`);
  }, 5000);

  const shutdown = async () => {
    console.log('\nStopping fleet…');
    await fleet.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
