'use strict';

const { VehicleRegistry } = require('../lib/swarm/vehicle-registry');
const { formationTargets, nextLeaderSysid, moveDistanceMeters, SHAPES } = require('../lib/swarm/formation');
const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { toInt, toNum, toBool, firstDefined, parseJsonObjectConfig } = require('../lib/util/validation');
const { badgeForState } = require('../lib/util/status');
const { safeDetach } = require('../lib/util/node-lifecycle');

/**
 * Registry messages the follow-leader mode subscribes to: HEARTBEAT discovers
 * vehicles and drives staleness, GLOBAL_POSITION_INT gives the leader pose the
 * follower slots are computed from.
 */
const FOLLOW_MESSAGES = ['HEARTBEAT', 'GLOBAL_POSITION_INT'];

/**
 * Fallback tick so leader staleness / succession is evaluated even when the
 * leader has gone silent and no other traffic is arriving to drive it.
 */
const FOLLOW_TICK_MS = 1000;

/**
 * mavlink-ai-formation (issue #46 / #232).
 *
 * Computes one global position target per vehicle from a formation shape and
 * emits a `mavlink-ai-fanout`-shaped payload (`{ command, targets, ... }`), so
 * `formation → fanout → out` moves a swarm into formation. It computes *where*;
 * fanout owns send / per-vehicle ACK aggregation / pacing / dry-run.
 *
 * Geometric shapes (line/column/grid/wedge/circle) are a stateless transform: an
 * input message carries the vehicle list (`sysids`, a swarm registry's
 * `vehicles`, or `targets`) and the anchor, and one snapshot of targets comes
 * out. `follow-leader` mode instead holds a live registry: it tracks a leader
 * sysid and re-emits follower targets as the leader moves (rate limited), and
 * when the leader goes stale it promotes the next present sysid to leader.
 */
module.exports = function registerMavlinkAiFormation(RED) {
  function MavlinkAiFormationNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.shape = config.shape || 'wedge';
    node.followerShape = config.followerShape || 'wedge';
    node.spacing = toNum(config.spacing, 10);
    node.anchorMode = config.anchorMode === 'fixed' ? 'fixed' : 'msg';
    node.anchorLat = config.anchorLat;
    node.anchorLon = config.anchorLon;
    node.anchorAlt = config.anchorAlt;
    node.headingSource = config.headingSource || 'north';
    node.headingDeg = toNum(config.headingDeg, 0);
    node.leaderSysid = toInt(config.leaderSysid, 0);
    node.updateHz = toNum(config.updateHz, 2);
    node.minMoveM = toNum(config.minMoveM, 1);
    node.staleAction = ['successor', 'hold', 'stop'].includes(config.staleAction) ? config.staleAction : 'successor';
    node.staleMs = toInt(config.staleMs, 5000);
    node.expireMs = toInt(config.expireMs, 30000);
    node.slotAssign = config.slotAssign === 'explicit' ? 'explicit' : 'auto';
    node.command = config.command || 'MAV_CMD_DO_REPOSITION';
    node.sendAs = config.sendAs === 'long' ? 'long' : 'int';
    node.frame = config.frame || 'MAV_FRAME_GLOBAL';
    node.dryRun = toBool(config.dryRun, false);
    /** Clock, overridable in tests so rate-limit/staleness are deterministic. */
    node._now = Date.now;

    const isFollow = node.shape === 'follow-leader';
    /** The geometry the followers/vehicles arrange in. */
    const geometry = isFollow ? node.followerShape : node.shape;

    /**
     * An explicit `{sysid: slot}` map (slotAssign = explicit) is parsed as a
     * JSON object; malformed config invalidates the node rather than silently
     * becoming `{}` (accept-all auto assignment), matching the swarm/fanout
     * fail-closed convention (#204). Blank stays the empty default.
     */
    let slotMap = null;
    node._configError = null;
    if (node.slotAssign === 'explicit') {
      const parsed = parseJsonObjectConfig(config.slots, 'slots');
      node._configError = parsed.error;
      slotMap = parsed.value;
    }
    if (node._configError) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    }

    /** Emit a structured error and finish the input handler. */
    function sendError(msg, send, done, code, message, context) {
      node.status({ fill: 'red', shape: 'ring', text: code });
      msg.topic = 'mavlink/error';
      msg.payload = errorPayload({ node: 'mavlink-ai-formation', code, message, context });
      send(msg);
      done();
    }

    /**
     * Wrap a target list in the fanout-compatible payload. `command_int` selects
     * COMMAND_INT (degE7 x/y) vs COMMAND_LONG; the frame rides in `fields` so
     * fanout applies it to every target; `dry_run` asks a downstream fanout to
     * echo the built messages instead of sending.
     *
     * @param {Array<object>} targets
     * @param {number} [leader]  the leader sysid (follow-leader mode)
     * @returns {object} payload
     */
    function fanoutPayload(targets, leader) {
      const payload = {
        command: node.command,
        command_int: node.sendAs === 'int',
        fields: { frame: node.frame },
        dry_run: node.dryRun,
        targets
      };
      if (leader !== undefined) {
        payload.leader = leader;
      }
      return payload;
    }

    /** follow-leader live state (unused by the stateless geometric shapes). */
    let registry = null;
    let attachedTo;
    let subId = null;
    let onStatus = null;
    let tick = null;
    let currentLeader = node.leaderSysid;
    let lastEmit = 0;
    let lastLeaderPos = null;
    let staleHandled = false;
    const minIntervalMs = node.updateHz > 0 ? 1000 / node.updateHz : 0;

    /** Sorted non-stale followers (everyone tracked except the current leader). */
    function followerSysids() {
      return registry
        .sysids({ includeStale: false })
        .filter((id) => id !== currentLeader)
        .sort((a, b) => a - b);
    }

    /**
     * Compute and emit follower targets around the leader's live pose. Followers
     * take slots 1..n (slot 0 is reserved for the leader on the anchor), arranged
     * in `geometry` and rotated by the leader's heading (or the configured fixed
     * heading), all at the leader's altitude.
     *
     * @param {object} leader  leader snapshot from the registry
     * @returns {void}
     */
    function emitFollowers(leader) {
      const followers = followerSysids();
      if (!followers.length) {
        node.status({ fill: 'green', shape: 'dot', text: `leader ${currentLeader}, 0 followers` });
        return;
      }
      const heading =
        node.headingSource === 'fixed'
          ? node.headingDeg
          : leader.position.heading != null
            ? leader.position.heading
            : 0;
      const anchor = { lat: leader.position.lat, lon: leader.position.lon, alt: leader.position.alt };
      let targets;
      try {
        targets = formationTargets({
          shape: geometry,
          spacing: node.spacing,
          anchor,
          headingDeg: heading,
          sysids: followers,
          startSlot: 1
        });
      } catch (err) {
        const e = toMavlinkError(err, 'FORMATION_FAILED');
        node.status({ fill: 'red', shape: 'ring', text: e.code });
        node.send({ topic: 'mavlink/error', payload: errorPayload({ node: 'mavlink-ai-formation', code: e.code, message: e.message, context: e.context }) });
        return;
      }
      node.send({ topic: 'swarm/formation', payload: fanoutPayload(targets, currentLeader) });
      node.status({ fill: 'green', shape: 'dot', text: `leader ${currentLeader} → ${followers.length}` });
    }

    /**
     * The leader is stale/absent: apply the configured stale action. Succession
     * promotes the next present sysid ("leader = leader + 1", robustly); hold and
     * stop both cease emitting until the leader (or a new one) reports. Promotion
     * only picks from non-stale vehicles, and does not itself re-emit — the next
     * inbound message (or tick) drives the new leader — so it can never loop.
     *
     * @returns {void}
     */
    function handleStale() {
      if (node.staleAction === 'successor') {
        const next = nextLeaderSysid(currentLeader, registry.sysids({ includeStale: false }));
        if (next != null) {
          node.warn(`Formation leader ${currentLeader} went stale; promoting sysid ${next}.`);
          currentLeader = next;
          lastLeaderPos = null;
          lastEmit = 0;
          staleHandled = false;
          node.status({ fill: 'yellow', shape: 'dot', text: `leader → ${currentLeader} (succession)` });
          return;
        }
        node.status({ fill: 'red', shape: 'ring', text: 'no live leader' });
      } else if (node.staleAction === 'stop') {
        node.status({ fill: 'red', shape: 'ring', text: `leader ${currentLeader} stale — stopped` });
      } else {
        node.status({ fill: 'yellow', shape: 'ring', text: `leader ${currentLeader} stale — holding` });
      }
      staleHandled = true;
    }

    /**
     * Re-evaluate the leader and emit if due. Called on every inbound registry
     * message and on the fallback tick. Rate limited to `updateHz` and gated on a
     * minimum leader move so a jittering leader can't burst the link; a `force`
     * (input poke) bypasses both gates.
     *
     * @param {boolean} [force=false]
     * @returns {void}
     */
    function maybeEmit(force) {
      if (!registry) {
        return;
      }
      const leader = registry.vehicles({ sysids: [currentLeader] })[0];
      /**
       * Lost leader (never appeared, or no recent heartbeat) → stale action. A
       * leader that is heartbeating but has not sent a position yet is NOT stale
       * — it is simply not ready, so we wait rather than promote a successor.
       */
      if (!leader || leader.stale) {
        if (!staleHandled) {
          handleStale();
        }
        return;
      }
      staleHandled = false;
      if (!leader.position) {
        node.status({ fill: 'grey', shape: 'dot', text: `leader ${currentLeader} (awaiting position)` });
        return;
      }
      const now = node._now();
      if (!force) {
        if (now - lastEmit < minIntervalMs) {
          return;
        }
        if (lastLeaderPos && node.minMoveM > 0 && moveDistanceMeters(lastLeaderPos, leader.position) < node.minMoveM) {
          return;
        }
      }
      emitFollowers(leader);
      lastEmit = now;
      lastLeaderPos = { lat: leader.position.lat, lon: leader.position.lon };
    }
    /** Exposed for tests to drive staleness/succession without a real timer. */
    node._maybeEmit = maybeEmit;

    /** Drop the subscription and listeners from the attached connection. */
    function detach() {
      if (attachedTo) {
        try {
          if (subId != null) {
            attachedTo.unsubscribe(subId);
          }
          if (onStatus) {
            attachedTo.emitter.removeListener('status', onStatus);
          }
        } catch (err) {
          node.error(`Error detaching from connection: ${err && err.message ? err.message : err}`);
        }
      }
      attachedTo = null;
      subId = null;
      onStatus = null;
    }

    /**
     * (Re-)resolve the connection and (re-)subscribe (follow-leader only). Re-run
     * on every `flows:started` so a connection restored in a later deploy is
     * picked up, mirroring the swarm node. The registry survives re-attachment so
     * tracked vehicles aren't forgotten across a connection redeploy.
     */
    function attach() {
      const conn = RED.nodes.getNode(config.connection) || null;
      if (conn === attachedTo && conn === node.connection) {
        return;
      }
      detach();
      node.connection = conn;
      if (!node.connection) {
        node.status({ fill: 'red', shape: 'ring', text: 'missing connection' });
        return;
      }
      if (!registry) {
        const profile = node.connection.profile;
        const bundle = profile && typeof profile.getDialect === 'function' ? profile.getDialect() : null;
        registry = new VehicleRegistry({
          staleMs: node.staleMs,
          expireMs: node.expireMs,
          enums: bundle && bundle.valid ? bundle.enums : null,
          now: () => node._now()
        });
        node.registry = registry;
      }
      subId = node.connection.subscribe({ messageNames: FOLLOW_MESSAGES }, (message) => {
        registry.ingest(message.payload);
        maybeEmit(false);
      });
      onStatus = (status) => node.status(badgeForState(status.state, status.state));
      node.connection.emitter.on('status', onStatus);
      node.status({ fill: 'grey', shape: 'dot', text: `leader ${currentLeader}` });
      attachedTo = node.connection;
    }

    if (isFollow && !node._configError) {
      attach();
      if (RED.events && typeof RED.events.on === 'function') {
        RED.events.on('flows:started', attach);
        node.on('close', function removeAttachWatcher() {
          RED.events.removeListener('flows:started', attach);
        });
      }
      tick = setInterval(() => maybeEmit(false), FOLLOW_TICK_MS);
      if (typeof tick.unref === 'function') {
        tick.unref();
      }
    } else if (!node._configError) {
      node.status({});
    }

    /**
     * Pull the vehicle sysids out of an incoming payload: an explicit `sysids`
     * list, a swarm registry's `vehicles` output, or a `targets` list (sysids or
     * per-target objects) — the same shapes fanout accepts, so a swarm node wires
     * straight in.
     *
     * @param {object} p
     * @returns {Array<number>}
     */
    function extractSysids(p) {
      if (Array.isArray(p.sysids)) {
        return p.sysids;
      }
      if (Array.isArray(p.vehicles)) {
        return p.vehicles.map((v) => v && v.sysid).filter((s) => Number.isFinite(Number(s)));
      }
      if (Array.isArray(p.targets)) {
        return p.targets.map((t) => (t && typeof t === 'object' ? t.sysid : t));
      }
      return [];
    }

    /**
     * Resolve the anchor for a geometric snapshot: the fixed configured position,
     * or `msg.payload.origin`/`anchor` from the input.
     *
     * @param {object} p
     * @returns {?object} { lat, lon, alt }
     */
    function resolveAnchor(p) {
      if (node.anchorMode === 'fixed') {
        return { lat: toNum(node.anchorLat, NaN), lon: toNum(node.anchorLon, NaN), alt: toNum(node.anchorAlt, NaN) };
      }
      return p.origin || p.anchor || null;
    }

    node.on('input', (msg, send, done) => {
      if (node._configError) {
        return sendError(msg, send, done, 'INVALID_CONFIG', `mavlink-ai-formation: ${node._configError}`);
      }

      /** follow-leader: an input poke forces an immediate re-emit off the live registry. */
      if (isFollow) {
        if (!registry) {
          return sendError(msg, send, done, 'NO_CONNECTION', 'Follow-leader needs a connection to receive telemetry on.');
        }
        maybeEmit(true);
        return done();
      }

      /** geometric: stateless transform of the input's vehicle list + anchor. */
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const sysids = extractSysids(p);
      if (!sysids.length) {
        return sendError(msg, send, done, 'NO_TARGETS',
          'Formation needs a vehicle list (payload.sysids, a swarm registry payload.vehicles, or payload.targets).');
      }
      const anchor = resolveAnchor(p);
      const heading =
        node.headingSource === 'fixed'
          ? node.headingDeg
          : node.headingSource === 'msg'
            ? toNum(p.heading, 0)
            : 0;
      let targets;
      try {
        targets = formationTargets({
          shape: geometry,
          spacing: firstDefined(toNum(p.spacing, undefined), node.spacing),
          anchor,
          headingDeg: heading,
          sysids,
          slotMap: node.slotAssign === 'explicit' ? slotMap : undefined
        });
      } catch (err) {
        const e = toMavlinkError(err, 'FORMATION_FAILED');
        return sendError(msg, send, done, e.code, e.message, e.context);
      }
      msg.topic = 'swarm/formation';
      msg.payload = fanoutPayload(targets);
      node.status({ fill: 'green', shape: 'dot', text: `${geometry} ${targets.length}` });
      send(msg);
      done();
    });

    node.on('close', (done) => {
      if (tick) {
        clearInterval(tick);
        tick = null;
      }
      safeDetach(node, detach);
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-formation', MavlinkAiFormationNode);
};
