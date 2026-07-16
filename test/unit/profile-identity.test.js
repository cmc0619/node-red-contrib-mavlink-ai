'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { makeIdentity, makeProfile, makeConnection } = require('../helpers/v3-config');

/**
 * Identity/target validation for the v3 split (#90, #228). MAVLink identity
 * fields are wire uint8s: out-of-range / non-integer values must fail closed at
 * runtime (imported/API flows bypass the editor), never be silently truncated,
 * wrapped, or replaced with a default.
 *
 * Source identity now lives on the Local Identity config node; target ids and
 * vehicle family live on the Vehicle Profile.
 */

// --- Local Identity source ids ---------------------------------------------
test('valid boundary source identity values are accepted (#90)', () => {
  const RED = new MockRED().loadNodes();
  /** Source compid floor is 1: 0 is MAV_COMP_ID_ALL, a broadcast address (#153). */
  const id = makeIdentity(RED, { sourceSystemId: 1, sourceComponentId: 1 });
  assert.strictEqual(id.isValid(), true);
  assert.deepStrictEqual(id.getIdentity(), { sysid: 1, compid: 1 });
});

test('source component 0 (MAV_COMP_ID_ALL) invalidates the identity (#153)', () => {
  const RED = new MockRED().loadNodes();
  const id = makeIdentity(RED, { sourceComponentId: 0 });
  assert.strictEqual(id.isValid(), false);
  assert.strictEqual(id.getError().code, 'IDENTITY_INVALID');
});

test('blank source identity values take the role preset defaults (#90, #106)', () => {
  const RED = new MockRED().loadNodes();
  const gcs = makeIdentity(RED, { role: 'gcs', sourceSystemId: '', sourceComponentId: '' });
  assert.deepStrictEqual(gcs.getIdentity(), { sysid: 255, compid: 190 });
  // Companion preset suggests the vehicle sysid (1) and CompID 191.
  const companion = makeIdentity(RED, { role: 'companion', sourceSystemId: '', sourceComponentId: '' });
  assert.deepStrictEqual(companion.getIdentity(), { sysid: 1, compid: 191 });
});

test('an explicit source CompID is not rewritten by the role preset (#106)', () => {
  const RED = new MockRED().loadNodes();
  const id = makeIdentity(RED, { role: 'companion', sourceComponentId: 42 });
  assert.strictEqual(id.getIdentity().compid, 42);
});

test('out-of-range and non-integer source identity values invalidate the identity (#90)', () => {
  const RED = new MockRED().loadNodes();
  const bad = [
    { sourceSystemId: 0 }, // 0 = unknown/broadcast, not a valid sender id
    { sourceSystemId: 256 },
    { sourceSystemId: -1 },
    { sourceSystemId: 12.5 },
    { sourceSystemId: 'abc' },
    { sourceComponentId: 300 }
  ];
  for (const overrides of bad) {
    const id = makeIdentity(RED, overrides);
    assert.strictEqual(id.isValid(), false, `${JSON.stringify(overrides)} should invalidate the identity`);
    const err = id.getError();
    assert.strictEqual(err.code, 'IDENTITY_INVALID');
    assert.match(err.message, /must be an integer/);
  }
});

test("sign-outbound with no passphrase invalidates the identity (fail closed, #91)", () => {
  const RED = new MockRED().loadNodes();
  const id = makeIdentity(RED, { signOutbound: true });
  assert.strictEqual(id.isValid(), false);
  assert.strictEqual(id.getError().code, 'IDENTITY_INVALID');
  assert.match(id.getError().message, /passphrase/);
});

// --- Vehicle Profile target ids --------------------------------------------
test('valid boundary target values are accepted (#90)', () => {
  const RED = new MockRED().loadNodes();
  const profile = makeProfile(RED, { defaultTargetSystem: 0, defaultTargetComponent: 255 });
  assert.strictEqual(profile.isValid(), true);
  const d = profile.getDefaults();
  assert.strictEqual(d.defaultTargetSystem, 0);
  assert.strictEqual(d.defaultTargetComponent, 255);
});

test('blank target values take the documented defaults (#90)', () => {
  const RED = new MockRED().loadNodes();
  const profile = makeProfile(RED, {});
  const d = profile.getDefaults();
  assert.strictEqual(d.defaultTargetSystem, 1);
  assert.strictEqual(d.defaultTargetComponent, 1);
});

test('out-of-range target values invalidate the profile (#90)', () => {
  const RED = new MockRED().loadNodes();
  for (const overrides of [{ defaultTargetSystem: 999 }, { defaultTargetComponent: -2 }]) {
    const profile = makeProfile(RED, overrides);
    assert.strictEqual(profile.isValid(), false, `${JSON.stringify(overrides)} should invalidate the profile`);
    assert.strictEqual(profile.getError().code, 'PROFILE_CONFIG_INVALID');
  }
});

test('the Vehicle Profile no longer owns source identity (#228)', () => {
  const RED = new MockRED().loadNodes();
  const profile = makeProfile(RED, {});
  const d = profile.getDefaults();
  assert.strictEqual('sourceSystemId' in d, false);
  assert.strictEqual('sourceComponentId' in d, false);
  assert.strictEqual(typeof profile.getHeartbeatFields, 'undefined');
  assert.strictEqual(typeof profile.getSigningPolicy, 'undefined');
});

test('legacy profileType is deterministically converted to a vehicle family, with a warning (#228)', () => {
  const RED = new MockRED().loadNodes();
  const copter = makeProfile(RED, { profileType: 'copter', vehicleFamily: '' });
  assert.strictEqual(copter.vehicleFamily, 'copter');
  assert.ok(copter.warnings.some((w) => /legacy/.test(w) && /copter/.test(w)));
  // A role-only legacy type carried no vehicle info -> generic.
  const gcs = makeProfile(RED, { profileType: 'gcs', vehicleFamily: '' });
  assert.strictEqual(gcs.vehicleFamily, 'generic');
});

test('legacy identity/signing fields on a profile are ignored with a pointer warning (#228)', () => {
  const RED = new MockRED().loadNodes();
  const profile = makeProfile(RED, { sourceSystemId: 7, signOutbound: true, heartbeatType: 'MAV_TYPE_GCS' });
  assert.ok(profile.warnings.some((w) => /no longer owns local identity/.test(w)));
  assert.ok(profile.warnings.some((w) => /Local Identity/.test(w)));
});

// --- Connection fail-closed on bad required config -------------------------
test('connection refuses to start on an identity-invalid default identity (#90, #228)', async () => {
  const RED = new MockRED().loadNodes();
  const identity = makeIdentity(RED, { id: 'id-bad', sourceSystemId: 4711 });
  assert.strictEqual(identity.isValid(), false);
  const { connection } = makeConnection(RED, { id: 'c-bad', localIdentity: 'id-bad', bindPort: 0 });
  assert.ok(
    connection.errors.some((e) => /LOCAL_IDENTITY_INVALID/.test(String(e))),
    'connection logged the identity error'
  );
  await assert.rejects(connection.send({ name: 'HEARTBEAT', fields: {} }), (e) => e.code === 'CONNECTION_INVALID');
  await RED.close(connection);
});

test('connection refuses to start with no default identity (#228)', async () => {
  const RED = new MockRED().loadNodes();
  const profile = makeProfile(RED, { id: 'p1' });
  const connection = RED.create('mavlink-ai-connection', {
    id: 'c-noid',
    name: 'C',
    profile: 'p1',
    transport: 'udp-peer',
    bindPort: 0
  });
  assert.ok(connection.errors.some((e) => /LOCAL_IDENTITY_REQUIRED/.test(String(e))));
  await assert.rejects(connection.send({ name: 'HEARTBEAT', fields: {} }), (e) => e.code === 'CONNECTION_INVALID');
  await RED.close(connection);
});
