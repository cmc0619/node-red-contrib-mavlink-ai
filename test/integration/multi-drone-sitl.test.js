'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MockRED } = require('../helpers/mock-red');
const { VirtualFleet } = require('../sitl/virtual-fleet');
const { buildFanout } = require('../../lib/swarm/fanout');
const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { globalToNedOffset, nedOffsetToGlobal } = require('../../lib/swarm/coordinate-frames');

/**
 * Multi-drone SITL: the "one big hurrah". A fleet of virtual drones (real
 * MAVLink wire format, distinct system ids, collision-aware physics — see
 * test/sitl/virtual-fleet.js) is discovered, armed, and flown through a
 * coordinated maneuver by the *real* driver stack (routed connection,
 * per-system Vehicle Profiles, the fan-out builder). The maneuver is planned so
 * the drones never collide, and the test asserts that the minimum pairwise
 * separation actually observed never drops below the collision floor.
 *
 * This runs entirely in-process over UDP loopback — no Docker, no PX4/ArduPilot
 * image — so it is deterministic and finishes in a few seconds. The same fleet
 * engine also backs the `run-fleet.js` CLI and the Docker image, so a real
 * multi-vehicle SITL and this test share one behavior model.
 */

const ORIGIN = { lat: 39.1, lon: -75.1, alt: 40 };
const FLEET_SIZE = 3;
const SLOT_SPACING_M = 15; // horizontal spacing of formation slots
const LAYER_GAP_M = 10; // vertical spacing between altitude layers
const COLLISION_FLOOR_M = 8; // drones must never get closer than this

const ENUMS = loadDialect('ardupilotmega').enums;

/** Resolve when `predicate()` is true, polling every 25 ms up to `timeoutMs`. */
function waitFor(predicate, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (err) {
        clearInterval(timer);
        reject(err);
        return;
      }
      if (ok) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout: ${label}`));
      }
    };
    const timer = setInterval(tick, 25);
    tick();
  });
}

/**
 * Stand up a routed connection over an ephemeral UDP port with one Vehicle
 * Profile per system id, plus a virtual fleet streaming to it. Returns the live
 * connection, its port, an ack map that fills as COMMAND_ACKs arrive, and a
 * cleanup hook.
 */
async function setupFleet(t, opts = {}) {
  const size = opts.size || FLEET_SIZE;
  const RED = new MockRED().loadNodes();

  const sysids = [];
  const routeTable = [];
  for (let i = 0; i < size; i += 1) {
    const sysid = 1 + i;
    sysids.push(sysid);
    RED.create('mavlink-ai-vehicle', {
      id: `p${sysid}`,
      name: `Drone ${sysid}`,
      dialect: 'ardupilotmega',
      defaultTargetSystem: sysid,
      defaultTargetComponent: 1
    });
    routeTable.push({ sysid, compid: '*', profile: `p${sysid}` });
  }
  RED.create('mavlink-ai-local-identity', {
    id: 'gcs', name: 'GCS', role: 'gcs', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c', name: 'Fleet UDP', profile: 'p1', localIdentity: 'gcs',
    transport: 'udp', routingMode: 'routed', unmatchedPolicy: 'default',
    routeTable: JSON.stringify(routeTable),
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  const addr = await new Promise((resolve) => conn._transport.once('listening', resolve));

  const fleet = new VirtualFleet({
    count: size,
    baseSysid: 1,
    dialect: 'ardupilotmega',
    origin: ORIGIN,
    spacingM: SLOT_SPACING_M,
    speed: 15,
    telemetryHz: 20,
    heartbeatHz: 10
  });
  // Faster climb keeps the choreography (layer, then reshuffle) inside a few
  // seconds without changing what is exercised.
  for (const d of fleet.drones) {
    d.climbRate = 12;
  }
  await fleet.start({ gcsHost: '127.0.0.1', gcsPort: addr.port });

  // One persistent ACK observer: ackMap[sysid] -> Map(command -> result).
  const ackMap = new Map();
  conn.subscribe({ messageNames: ['COMMAND_ACK'] }, (m) => {
    const s = m.payload.sysid;
    if (!ackMap.has(s)) {
      ackMap.set(s, new Map());
    }
    ackMap.get(s).set(Number(m.payload.fields.command), Number(m.payload.fields.result));
  });

  t.after(async () => {
    await fleet.stop();
    await RED.close(conn);
  });

  return { RED, conn, fleet, sysids, port: addr.port, ackMap };
}

/**
 * Send one command to every system and re-send on an interval until each has
 * ACK'd it (UDP loopback can drop a datagram; the resend mirrors how a real GCS
 * retries an unacked command).
 *
 * @param {object} ctx        setup context
 * @param {string} msgName    'COMMAND_LONG' | 'COMMAND_INT'
 * @param {function} buildFor (sysid) => fields
 * @param {number} command    numeric MAV_CMD, for ACK matching
 */
async function commandAllUntilAck(ctx, msgName, buildFor, command) {
  const send = () => {
    for (const sysid of ctx.sysids) {
      ctx.conn
        .send({ name: msgName, fields: buildFor(sysid), target_system: sysid, target_component: 1 })
        .catch(() => {}); // a transient no-peer/queue reject is retried on the next tick
    }
  };
  const resend = setInterval(send, 200);
  try {
    send();
    await waitFor(
      () => ctx.sysids.every((s) => ctx.ackMap.get(s) && ctx.ackMap.get(s).has(command)),
      `all systems ACK command ${command}`
    );
  } finally {
    clearInterval(resend);
  }
}

test('fleet is discovered, commanded, and never breaches the collision floor', async (t) => {
  const ctx = await setupFleet(t);

  // 1. Discovery: every system id shows up on the routed connection.
  const seen = new Set();
  ctx.conn.subscribe({ messageNames: ['HEARTBEAT'] }, (m) => seen.add(m.payload.sysid));
  await waitFor(() => ctx.sysids.every((s) => seen.has(s)), 'discover all systems');
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), ctx.sysids, 'all fleet system ids discovered');

  // 2. Arm the whole fleet.
  await commandAllUntilAck(
    ctx,
    'COMMAND_LONG',
    () => ({ command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 1 }),
    400
  );
  assert.ok(ctx.fleet.snapshot().every((d) => d.armed), 'every drone reports armed');

  // 3. Take off to STAGGERED altitude layers (deconfliction technique: separate
  //    vertically before any horizontal reshuffle). Drone i climbs to a layer
  //    LAYER_GAP_M above the one below it.
  await commandAllUntilAck(
    ctx,
    'COMMAND_LONG',
    (sysid) => ({ command: 'MAV_CMD_NAV_TAKEOFF', param7: LAYER_GAP_M * sysid }),
    22
  );
  // Wait until every drone has reached its layer, so the reshuffle below happens
  // with full vertical separation already established.
  await waitFor(
    () =>
      ctx.fleet.snapshot().every((d) => {
        const wantAlt = ORIGIN.alt + LAYER_GAP_M * d.sysid;
        return Math.abs(d.pos.alt - wantAlt) < 0.5;
      }),
    'all drones reach their altitude layer'
  );

  // 4. The wringer: reshuffle horizontally into the REVERSED line. Paths cross,
  //    but the altitude layering keeps every pair ≥ ~LAYER_GAP_M apart in 3-D.
  //    Built through the real fan-out builder — one COMMAND_INT per drone.
  // Drone i -> east slot of drone (N-1-i), at its own altitude layer.
  const slotFor = (i) => ({ east: (ctx.sysids.length - 1 - i) * SLOT_SPACING_M, up: LAYER_GAP_M * (i + 1) });
  const reposition = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: true,
    origin: ORIGIN,
    enums: ENUMS,
    targets: ctx.sysids.map((sysid, i) => ({ sysid, ...slotFor(i), param4: 'NaN' /* keep current yaw */ })),
    defaults: { defaultTargetComponent: 1 }
  });
  // The exact global point each drone must reach, so the settle check keys off
  // the NEW reversed slots — not the takeoff target the drones already sit on.
  const expectedFinal = new Map(
    ctx.sysids.map((sysid, i) => {
      const { east, up } = slotFor(i);
      return [sysid, nedOffsetToGlobal(ORIGIN, { east, up })];
    })
  );
  const sendReposition = () => {
    for (const msg of reposition) {
      ctx.conn
        .send({ name: msg.name, fields: msg.fields, target_system: msg.target_system, target_component: msg.target_component })
        .catch(() => {});
    }
  };
  const resend = setInterval(sendReposition, 200);
  sendReposition();
  try {
    // Wait until every drone has reached its commanded reversed slot. Asserts
    // the maneuver actually completed, not just that it ACK'd.
    await waitFor(
      () =>
        ctx.fleet.snapshot().every((d) => {
          const off = globalToNedOffset(d.pos, expectedFinal.get(d.sysid));
          return Math.hypot(off.north, off.east, off.down) < 1;
        }),
      'fleet settles into the reversed formation'
    );
    // Also wait for every reposition ACK while the resend loop is still active:
    // position can settle before the ACK datagram lands, so clearing retries
    // first could strand a drone whose ACK dropped and make the assertion below
    // dereference a missing map entry.
    await waitFor(
      () => ctx.sysids.every((s) => ctx.ackMap.get(s) && ctx.ackMap.get(s).get(192) === 0),
      'every drone ACKs the reposition'
    );
  } finally {
    clearInterval(resend);
  }

  assert.ok(
    ctx.sysids.every((s) => ctx.ackMap.get(s).get(192) === 0),
    'every drone ACCEPTED the reposition'
  );

  // 5. The point of the whole exercise: no collision at any observed instant.
  assert.ok(
    ctx.fleet.minSeparationSeen >= COLLISION_FLOOR_M,
    `min separation observed ${ctx.fleet.minSeparationSeen.toFixed(2)} m must stay >= ${COLLISION_FLOOR_M} m`
  );
});

test('a colliding plan (two drones, same slot) is caught by the separation monitor', async (t) => {
  // The teeth behind the positive test: prove the separation check is not
  // vacuously satisfied. Two drones commanded to the SAME point at the SAME
  // altitude must converge, driving the observed minimum below the floor.
  const ctx = await setupFleet(t, { size: 2 });

  const seen = new Set();
  ctx.conn.subscribe({ messageNames: ['HEARTBEAT'] }, (m) => seen.add(m.payload.sysid));
  await waitFor(() => ctx.sysids.every((s) => seen.has(s)), 'discover both systems');

  await commandAllUntilAck(ctx, 'COMMAND_LONG', () => ({ command: 'MAV_CMD_COMPONENT_ARM_DISARM', param1: 1 }), 400);

  // Both drones -> identical global point (origin), identical altitude.
  const collide = buildFanout({
    command: 'MAV_CMD_DO_REPOSITION',
    useInt: true,
    origin: ORIGIN,
    enums: ENUMS,
    targets: ctx.sysids.map((sysid) => ({ sysid, north: 0, east: 0, up: 5, param4: 'NaN' })),
    defaults: { defaultTargetComponent: 1 }
  });
  const send = () => {
    for (const msg of collide) {
      ctx.conn.send({ name: msg.name, fields: msg.fields, target_system: msg.target_system, target_component: 1 }).catch(() => {});
    }
  };
  const resend = setInterval(send, 200);
  send();
  try {
    await waitFor(() => ctx.fleet.minSeparationSeen < COLLISION_FLOOR_M, 'drones converge below the floor');
  } finally {
    clearInterval(resend);
  }
  assert.ok(
    ctx.fleet.minSeparationSeen < COLLISION_FLOOR_M,
    `converging drones must breach the ${COLLISION_FLOOR_M} m floor (saw ${ctx.fleet.minSeparationSeen.toFixed(2)} m)`
  );
});
