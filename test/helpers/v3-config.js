'use strict';

const { LinkState } = require('../../lib/protocol/link-state');

/**
 * Test helpers for the v3 three-node model (issue #228): Local Identity,
 * Vehicle Profile, and Connection are now separate config nodes. These builders
 * apply sensible defaults so a test only names the fields it cares about.
 *
 * They also wrap the codec's identity-aware encode() API: the codec is now
 * dialect-scoped only, so encode() needs the sender's sysid/compid plus a
 * connection-owned LinkState carrying sequence/signing/version state (#192).
 */

let seq = 0;
/** A unique config-node id per call, so a test can create several nodes. */
function uid(prefix) {
  seq += 1;
  return `${prefix}${seq}`;
}

/**
 * Create a Local Identity config node with GCS-ish defaults.
 *
 * @param {MockRED} RED
 * @param {object} [config]  overrides (id/name/role/sourceSystemId/... )
 * @returns {object} the identity node
 */
function makeIdentity(RED, config = {}) {
  return RED.create(
    'mavlink-ai-local-identity',
    Object.assign(
      {
        id: uid('id'),
        name: 'GCS',
        role: 'custom',
        sourceSystemId: 255,
        sourceComponentId: 190
      },
      config
    )
  );
}

/**
 * Create a Vehicle Profile config node.
 *
 * @param {MockRED} RED
 * @param {object} [config]  overrides (id/name/dialect/mavlinkVersion/... )
 * @returns {object} the profile node
 */
function makeProfile(RED, config = {}) {
  return RED.create(
    'mavlink-ai-vehicle',
    Object.assign(
      {
        id: uid('p'),
        name: 'Vehicle',
        dialect: 'ardupilotmega',
        mavlinkVersion: 'auto'
      },
      config
    )
  );
}

/**
 * Create a Connection config node, auto-creating a default Local Identity and
 * Vehicle Profile if the caller didn't reference existing ones.
 *
 * @param {MockRED} RED
 * @param {object} [config]  overrides; `profile`/`localIdentity` may name
 *   existing config-node ids, otherwise defaults are created
 * @param {object} [opts]
 * @param {object} [opts.identityConfig]  overrides for the auto identity
 * @param {object} [opts.profileConfig]   overrides for the auto profile
 * @returns {{connection: object, profile: object, identity: object}}
 */
function makeConnection(RED, config = {}, opts = {}) {
  let profile = null;
  let identity = null;
  const merged = Object.assign(
    {
      id: uid('c'),
      name: 'C',
      transport: 'udp-peer',
      bindAddress: '127.0.0.1',
      bindPort: 0,
      reconnect: false,
      heartbeat: false
    },
    config
  );
  if (!merged.profile) {
    profile = makeProfile(RED, opts.profileConfig || {});
    merged.profile = profile.id;
  } else {
    profile = RED.nodes.getNode(merged.profile);
  }
  if (!merged.localIdentity) {
    identity = makeIdentity(RED, opts.identityConfig || {});
    merged.localIdentity = identity.id;
  } else {
    identity = RED.nodes.getNode(merged.localIdentity);
  }
  const connection = RED.create('mavlink-ai-connection', merged);
  return { connection, profile, identity };
}

/**
 * Encode through a dialect codec with an explicit sender identity + LinkState,
 * matching the connection's own encode path (#192, #228). Creates a throwaway
 * LinkState unless one is supplied, so a standalone codec test doesn't need to
 * build one.
 *
 * @param {MavlinkCodec} codec
 * @param {string} name
 * @param {object} fields
 * @param {object} [opts]  { sysid, compid, link, signing, targetSystem, targetComponent }
 * @returns {Buffer}
 */
function enc(codec, name, fields, opts = {}) {
  return codec.encode(name, fields, {
    sysid: opts.sysid !== undefined ? opts.sysid : 255,
    compid: opts.compid !== undefined ? opts.compid : 190,
    link: opts.link || new LinkState(),
    signing: opts.signing || null,
    targetSystem: opts.targetSystem,
    targetComponent: opts.targetComponent
  });
}

/**
 * A minimal stub Local Identity for node-level tests that use a hand-rolled
 * fake connection. Exposes the identity surface the action/workflow nodes call
 * (getIdentity/getSigningPolicy/getHeartbeatFields/describe).
 *
 * @param {number} [sysid=255]
 * @param {number} [compid=190]
 * @returns {object}
 */
function fakeIdentity(sysid = 255, compid = 190) {
  return {
    id: 'id-stub',
    name: 'GCS',
    getIdentity: () => ({ sysid, compid }),
    getSigningPolicy: () => null,
    getHeartbeatFields: () => ({
      type: 'MAV_TYPE_GCS',
      autopilot: 'MAV_AUTOPILOT_INVALID',
      base_mode: 0,
      custom_mode: 0,
      system_status: 'MAV_STATE_ACTIVE',
      mavlink_version: 3
    }),
    isValid: () => true,
    getError: () => null,
    describe: () => `GCS (${sysid}/${compid})`
  };
}

/**
 * Attach a default outbound-identity resolver to a fake connection stub, so a
 * node calling `connection.resolveOutboundIdentity(ref)` gets the stub identity
 * (the default) for any blank/unknown ref. Returns the connection for chaining.
 *
 * @param {object} conn
 * @param {object} [identity]  the identity to return (defaults to fakeIdentity())
 * @returns {object} conn
 */
function attachIdentityStub(conn, identity = fakeIdentity()) {
  conn.localIdentity = identity;
  conn.getDefaultIdentity = () => identity;
  conn.resolveOutboundIdentity = () => identity;
  return conn;
}

module.exports = {
  makeIdentity,
  makeProfile,
  makeConnection,
  enc,
  uid,
  LinkState,
  fakeIdentity,
  attachIdentityStub
};
