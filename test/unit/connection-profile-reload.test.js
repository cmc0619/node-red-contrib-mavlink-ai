'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');

/**
 * Editing a profile's dialect and redeploying must update an already-running
 * connection, without restarting the transport.
 *
 * Node-RED recreates an edited profile config node but leaves an unchanged
 * connection node running. Before the fix the connection kept its stale profile
 * object, codec, per-profile codec cache, router default profile, and decoder —
 * all built from the pre-edit dialect — so a profile switched from `common` to
 * `development` still rejected message 441 (GNSS_INTEGRITY, defined only by the
 * development dialect) with "Unable to decode message id 441 with dialect
 * 'common'" until Node-RED was restarted. The connection now rebuilds all
 * profile-dependent state on flows:started.
 */

// A GNSS_INTEGRITY (message id 441) frame from sysid 1. The message exists only
// in the development dialect, so `common` cannot decode it but `development` can.
const GNSS_INTEGRITY_MSGID = 441;
function gnssIntegrityFrame() {
  const dev = loadDialect('development');
  const codec = new MavlinkCodec({ bundle: dev, version: 'v2', sysid: 1, compid: 1 });
  return codec.encode('GNSS_INTEGRITY', {});
}

/**
 * Resolve on the first matching event, or reject after a timeout. Feeding one
 * datagram directly at the transport is enough — the splitter buffers it and
 * the parser emits on a later tick, so we wait rather than assert synchronously.
 */
function nextEvent(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`timeout waiting for '${event}'`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    emitter.once(event, onEvent);
  });
}

test('editing a profile dialect updates a running connection on redeploy (message 441)', async (t) => {
  const RED = new MockRED().loadNodes();

  // Start on `common`.
  RED.create('mavlink-ai-profile', {
    id: 'p1', name: 'Vehicle', profileType: 'gcs', dialect: 'common', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'UDP', profile: 'p1',
    transport: 'udp-peer', routingMode: 'single-profile',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  t.after(() => RED.close(conn));

  const frame = gnssIntegrityFrame();

  // 1. With the common profile, message 441 cannot be decoded: expect a
  //    structured decode error naming the common dialect.
  const errPromise = nextEvent(conn.emitter, 'decodeError');
  conn._transport.emit('data', frame);
  const decodeError = await errPromise;
  assert.strictEqual(decodeError.payload.code, 'DECODE_FAILED');
  assert.strictEqual(decodeError.payload.context.msgid, GNSS_INTEGRITY_MSGID);
  assert.strictEqual(decodeError.payload.context.dialect, 'common');

  // 2. Change the profile's dialect to `development` and redeploy. Node-RED
  //    recreates the profile config node under the same id; the connection node
  //    is left running (its own config is unchanged).
  RED.create('mavlink-ai-profile', {
    id: 'p1', name: 'Vehicle', profileType: 'gcs', dialect: 'development', mavlinkVersion: 'v2',
    sourceSystemId: 255, sourceComponentId: 190, defaultTargetSystem: 1, defaultTargetComponent: 1
  });
  RED.events.emit('flows:started');

  // The connection must now hold the new profile without a transport restart.
  assert.strictEqual(conn.profile.dialect, 'development');
  assert.strictEqual(conn.profile, RED.nodes.getNode('p1'));

  // 3. The same message 441 now decodes as GNSS_INTEGRITY via the development
  //    dialect — no Node-RED restart required.
  const msgPromise = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', gnssIntegrityFrame());
  const message = await msgPromise;
  assert.strictEqual(message.payload.name, 'GNSS_INTEGRITY');
  assert.strictEqual(message.payload.id, GNSS_INTEGRITY_MSGID);
  assert.strictEqual(message.payload.profile, 'Vehicle');
});
