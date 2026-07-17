#!/usr/bin/env node
'use strict';

const dgram = require('dgram');

const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

/**
 * Stand-in GCS for CI: bind the fleet port, decode inbound MAVLink, and exit 0
 * once HEARTBEATs from the expected number of distinct system ids have arrived
 * (exit 1 on timeout). This is what the Docker-fleet workflow runs to prove the
 * containers actually reach the host and speak valid MAVLink — the same check a
 * human makes by watching the Swarm registry populate.
 *
 *   node test/sitl/verify-fleet-discovery.js [--port 14550] [--expect 3] [--timeout 30000]
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.GCS_PORT || 14550);
const EXPECT = Number(args.expect || process.env.EXPECT || 3);
const TIMEOUT = Number(args.timeout || process.env.TIMEOUT || 30000);
const DIALECT = args.dialect || process.env.DIALECT || 'ardupilotmega';

const codec = new MavlinkCodec({ bundle: loadDialect(DIALECT), version: 'v2' });
const seen = new Set();

const decoder = codec.createDecoder(
  (packet) => {
    const msg = codec.decode(packet, {});
    if (msg && msg.name === 'HEARTBEAT') {
      if (!seen.has(msg.sysid)) {
        seen.add(msg.sysid);
        console.log(`discovered sysid ${msg.sysid} (${seen.size}/${EXPECT})`);
      }
      if (seen.size >= EXPECT) {
        console.log(`OK: ${seen.size} system ids discovered: ${[...seen].sort((a, b) => a - b).join(', ')}`);
        process.exit(0);
      }
    }
  },
  (err) => console.error(`decode error: ${err.message}`)
);

const sock = dgram.createSocket('udp4');
sock.on('message', (buf) => decoder.write(buf));
sock.on('error', (err) => {
  console.error(`socket error: ${err.message}`);
  process.exit(1);
});
sock.bind(PORT, '0.0.0.0', () => {
  console.log(`Verifier listening udp/${PORT}, waiting for ${EXPECT} system ids (timeout ${TIMEOUT} ms)…`);
});

setTimeout(() => {
  console.error(`TIMEOUT: only ${seen.size}/${EXPECT} system ids seen: ${[...seen].sort((a, b) => a - b).join(', ') || 'none'}`);
  process.exit(1);
}, TIMEOUT);
