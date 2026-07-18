'use strict';

const { VehicleRegistry } = require('../lib/swarm/vehicle-registry');
const { formationTargets, nextLeaderSysid, moveDistanceMeters } = require('../lib/swarm/formation');
const { MavlinkError, errorPayload, toMavlinkError } = require('../lib/util/errors');
const { makeFail } = require('../lib/util/node-errors');
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

    /** MAV_CMD_DO_REPOSITION in name or numeric (192) form. */
    const REPOSITION_COMMAND = new Set(['MAV_CMD_DO_REPOSITION', 'DO_REPOSITION', '192']);
    function isRepositionCommand(cmd) {
      return REPOSITION_COMMAND.has(String(cmd));
    }

    /**
     * The shared `fields` for the fanout payload. This node computes only
     * positions, but a bare per-target message would get DO_REPOSITION's non-
     * position params wrong: fanout fills omitted params with 0
     * (lib/swarm/fanout.js), and for DO_REPOSITION that means param1 = 0 m/s
     * ground speed and param4 = yaw-to-north instead of "keep current". So for a
     * reposition we set the same defaults the single-vehicle goto command uses —
     * param1 = -1 (vehicle default speed), param2 = 1 (MAV_DO_REPOSITION_FLAGS_
     * CHANGE_MODE → switch to guided so the reposition is accepted), and
     * param4 = NaN (keep the current yaw). An explicit `msg.payload.fields`
     * overrides any of them.
     *
     * @param {object} [p]  the input payload (geometric mode), for field overrides
     * @returns {object}
     */
    function baseFields(p) {
      const fields = { frame: node.frame };
      if (isRepositionCommand(node.command)) {
        fields.param1 = -1;
        fields.param2 = 1;
        fields.param4 = NaN;
      }
      if (p && p.fields && typeof p.fields === 'object') {
        Object.assign(fields, p.fields);
      }
      return fields;
    }

    /**
     * Wrap a target list in the fanout-compatible payload. `command_int` selects
     * COMMAND_INT (degE7 x/y) vs COMMAND_LONG; `fields` (frame + reposition
     * defaults) is applied by fanout to every target; `dry_run` asks a downstream
     * fanout to echo the built messages instead of sending.
     *
     * @param {Array<object>} targets
     * @param {object} fields  shared fields (see {@link baseFields})
     * @param {number} [leader]  the leader sysid (follow-leader mode)
     * @returns {object} payload
     */
    function fanoutPayload(targets, fields, leader) {
      const payload = {
        command: node.command,
        command_int: node.sendAs === 'int',
        fields,
        targets
      };
      /**
       * Only assert dry_run when THIS node explicitly asks for it. fanout prefers
       * an incoming dry_run over its own config, so emitting `dry_run: false`
       * unconditionally would force a downstream fanout that has Dry-run enabled
       * to send real commands — overriding its safety setting (Codex review on
       * #244). Omitting the field lets fanout keep its own dry-run choice.
       */
      if (node.dryRun) {
        payload.dry_run = true;
      }
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
    let lastFollowerSig = '';
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
     * @param {number[]} followers  the sorted follower sysids to position
     * @returns {boolean} true when it acted on this state (sent positions, or a
     *   deterministic error) — false only for the benign "no followers yet" case,
     *   so the caller keeps re-checking until one appears
     */
    function emitFollowers(leader, followers) {
      if (!followers.length) {
        node.status({ fill: 'green', shape: 'dot', text: `leader ${currentLeader}, 0 followers` });
        return false;
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
        return true;
      }
      node.send({ topic: 'swarm/formation', payload: fanoutPayload(targets, baseFields(null), currentLeader) });
      node.status({ fill: 'green', shape: 'dot', text: `leader ${currentLeader} → ${followers.length}` });
      return true;
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
          lastFollowerSig = '';
          staleHandled = false;
          node.status({ fill: 'yellow', shape: 'dot', text: `leader → ${currentLeader} (succession)` });
          return;
        }
        /**
         * No live successor yet — badge once, but keep re-checking on every
         * message/tick so a vehicle that appears LATER is promoted. Suppressing
         * this branch after the no-candidate case left `successor` mode stuck
         * until the original leader returned (Codex review on #244).
         */
        if (!staleHandled) {
          node.status({ fill: 'red', shape: 'ring', text: 'no live leader' });
          staleHandled = true;
        }
        return;
      }
      /**
       * hold / stop deliberately do NOT promote — they cease emitting until the
       * configured leader itself returns. Badge once to avoid per-message thrash.
       */
      if (staleHandled) {
        return;
      }
      if (node.staleAction === 'stop') {
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
       * handleStale is idempotent (retries succession, badges once for hold/stop),
       * so it is called unconditionally — the previous `!staleHandled` guard here
       * blocked succession retries after a no-candidate case (Codex review on #244).
       */
      if (!leader || leader.stale) {
        handleStale();
        return;
      }
      staleHandled = false;
      /**
       * Require a FRESH leader position, not just any position: the registry
       * keeps the last fix while only HEARTBEATs keep arriving, and commanding
       * followers around an arbitrarily old position — especially on a forced
       * emit or membership change, which bypass the move gate — is unsafe (Codex
       * review on #244). A missing or stale fix means "not ready": wait.
       */
      if (!leader.position || leader.positionStale) {
        node.status({ fill: 'grey', shape: 'dot', text: `leader ${currentLeader} (awaiting position)` });
        return;
      }
      const followers = followerSysids();
      const followerSig = followers.join(',');
      const membershipChanged = followerSig !== lastFollowerSig;
      const now = node._now();
      if (!force) {
        if (now - lastEmit < minIntervalMs) {
          return;
        }
        /**
         * A follower joining or leaving must re-emit even when the leader is
         * stationary, or a newly-arrived vehicle never receives its slot
         * (CodeRabbit review on #244). Only the minimum-move gate is bypassed on a
         * membership change; the rate limit still bounds the emit rate.
         */
        if (
          !membershipChanged &&
          lastLeaderPos &&
          node.minMoveM > 0 &&
          moveDistanceMeters(lastLeaderPos, leader.position) < node.minMoveM
        ) {
          return;
        }
      }
      if (emitFollowers(leader, followers)) {
        lastEmit = now;
        lastLeaderPos = { lat: leader.position.lat, lon: leader.position.lon };
        lastFollowerSig = followerSig;
      }
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
      /**
       * The single error exit (#285): one closure binds node/msg/send/done,
       * so call sites pass only the failure — no positional
       * (msg, send, done, code, ...) threading to arity-shift (#276).
       */
      const fail = makeFail({ node, nodeName: 'mavlink-ai-formation', msg, send, done });
      if (node._configError) {
        return fail(new MavlinkError('INVALID_CONFIG', `mavlink-ai-formation: ${node._configError}`));
      }

      /** follow-leader: an input poke forces an immediate re-emit off the live registry. */
      if (isFollow) {
        if (!registry) {
          return fail(new MavlinkError('NO_CONNECTION', 'Follow-leader needs a connection to receive telemetry on.'));
        }
        maybeEmit(true);
        return done();
      }

      /** geometric: stateless transform of the input's vehicle list + anchor. */
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const sysids = extractSysids(p);
      if (!sysids.length) {
        return fail(new MavlinkError('NO_TARGETS',
          'Formation needs a vehicle list (payload.sysids, a swarm registry payload.vehicles, or payload.targets).'));
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
        return fail(e);
      }
      msg.topic = 'swarm/formation';
      msg.payload = fanoutPayload(targets, baseFields(p));
      /**
       * Preserve an explicit source-identity request: replacing msg.payload
       * dropped msg.payload.localIdentity, so a multi-identity flow would
       * silently transmit as fanout's default identity (Codex review on #244).
       */
      if (p.localIdentity !== undefined && p.localIdentity !== null && p.localIdentity !== '') {
        msg.payload.localIdentity = p.localIdentity;
      }
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
