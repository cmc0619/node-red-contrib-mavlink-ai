'use strict';

const { MavlinkError, toMavlinkError } = require('../lib/util/errors');
const { makeFail } = require('../lib/util/node-errors');
const { firstDefined, toInt, toBool, parseJsonObjectConfig } = require('../lib/util/validation');
const { buildFanout } = require('../lib/swarm/fanout');
const { CommandSend } = require('../lib/command/command-workflow');
const { PRIORITY, commandPriorityFor } = require('../lib/runtime/send-priority');
const { watchConfigBadge } = require('../lib/util/node-lifecycle');
const { DELIVERY, resolveDeliveryMode } = require('../lib/util/delivery');

/**
 * mavlink-ai-fanout (issue #46).
 *
 * Expands one logical command into one message per target vehicle
 * (`target_system` filled in per sysid), or — explicitly and only when asked —
 * a single broadcast message to `target_system` 0.
 *
 * Delivery is explicit (#207): "Build only" hands the per-target
 * `mavlink/send` messages to a downstream mavlink-ai-out node; "Send via
 * connection" sends every decorated target directly and aggregates a
 * `swarm/sent` result; "Send & await result" sends each command on the
 * connection, runs the full command protocol per vehicle, and aggregates the
 * per-sysid results into accepted/failed/timedOut arrays — partial failure is
 * normal in swarm operations and is never hidden. Dry-run is its own
 * checkbox, orthogonal to Delivery: it short-circuits every mode to a
 * `swarm/dryrun` preview with nothing sent. Every mode emits on port 0
 * (product) with errors on port 1.
 *
 * Targets come from `msg.payload.targets` (sysids or per-target objects),
 * `msg.payload.sysids`, or a mavlink-ai-swarm registry output
 * (`msg.payload.vehicles`) wired straight in.
 */
module.exports = function registerMavlinkAiFanout(RED) {
  function MavlinkAiFanoutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    /**
     * Resolve node.profile + node.connection and keep their idle badges live
     * across deploys. The connection is only *needed* for Send/Await delivery
     * (Build only hands mavlink/send to a downstream Out node), so a missing
     * connection is badged only in those modes (#164, #207).
     */
    watchConfigBadge(RED, node, config, {
      profile: 'required',
      connection: 'optional',
      connectionRequiredWhen: () => config.delivery === DELIVERY.SEND || config.delivery === DELIVERY.AWAIT
    });
    node.command = config.command || '';
    node.mode = config.mode === 'broadcast' ? 'broadcast' : 'fanout';
    node.sendAs = config.sendAs || 'long';
    node.timeoutMs = toInt(config.timeoutMs, 3000);
    node.maxRetries = toInt(config.maxRetries, 3);
    node.spacingMs = toInt(config.spacingMs, 0);
    node.stopOnError = toBool(config.stopOnError, false);
    node.dryRun = toBool(config.dryRun, false);
    /**
     * How many per-target await-ack workflows may run at once (#155). Default 1
     * keeps the original strictly-sequential behavior; a higher value lets a
     * "simultaneous" formation command dispatch to several vehicles in parallel
     * so one slow/timing-out straggler doesn't delay the rest by timeout×retries.
     * Clamped to at least 1.
     */
    node.concurrency = Math.max(1, toInt(config.concurrency, 1));

    /**
     * Malformed static `fields` JSON invalidates the node instead of silently
     * becoming `{}` and omitting intended shared params (#204). Blank stays the
     * empty default; imported/API/hand-edited flows bypass the editor validator.
     */
    const parsedBase = parseJsonObjectConfig(config.fields, 'fields');
    const configBase = parsedBase.value;

    /**
     * A missing/invalid Delivery selection (#207, #308) is a construct-time
     * config error too, not just an input-time one: a pre-upgrade node (or one
     * created via import/API without a `delivery` value) must show the same red
     * badge at deploy time as malformed static JSON, instead of looking healthy
     * until the first message. Folded into the same `node._configError` the
     * input handler already short-circuits on; `watchConfigBadge`'s own
     * `flows:started` refresh also checks this flag (#308 G1), so the badge
     * is re-asserted — not cleared — on every later redeploy too, for as
     * long as delivery stays unset.
     */
    let deliveryConfigError = null;
    try {
      resolveDeliveryMode(config, { allow: [DELIVERY.BUILD, DELIVERY.SEND, DELIVERY.AWAIT] });
    } catch (err) {
      if (err.code !== 'DELIVERY_UNSET') {
        throw err;
      }
      deliveryConfigError = err.message;
    }

    node._configError = parsedBase.error || deliveryConfigError;
    /**
     * Precedence (#308): "invalid profile" is the more fundamental problem and
     * watchConfigBadge already painted that badge above, so only paint over it
     * with "invalid config" when the profile itself resolved fine — a
     * delivery-unset (or malformed-fields) node with a broken profile keeps
     * showing "invalid profile" instead of masking it.
     */
    const profileOk = !!(node.profile && typeof node.profile.isValid === 'function' && node.profile.isValid());
    if (node._configError && profileOk) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    }

    /** Emit a structured error and finish the handler. */
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Close-time abort state (#83): every in-flight per-target ACK workflow (a
     * Set now that up to node.concurrency run at once, #155), and a flag the
     * dispatcher checks so a closed node stops fanning out to the remaining
     * targets instead of pacing on until success/timeout.
     */
    const activeWorkflows = new Set();
    let closed = false;

    node.on('input', async (msg, send, done) => {
      /**
       * The single error exit (#285): one closure binds node/msg/send/done,
       * so call sites pass only the failure — no positional
       * (msg, send, done, code, ...) threading to arity-shift (#276).
       */
      const fail = makeFail({
        node,
        nodeName: 'mavlink-ai-fanout',
        msg,
        send,
        done,
        outputs: 2,
        errorIndex: 1,
        connectionName: () => node.connection && node.connection.name
      });

      /**
       * Delivery is explicit (#207): a node saved before this change (or
       * imported/API-created without a delivery value) fails closed instead
       * of silently picking a behavior.
       */
      let mode;
      try {
        mode = resolveDeliveryMode(config, { allow: [DELIVERY.BUILD, DELIVERY.SEND, DELIVERY.AWAIT] });
      } catch (err) {
        return fail(err);
      }
      if (node._configError) {
        return fail(new MavlinkError('INVALID_CONFIG', `mavlink-ai-fanout: ${node._configError}`));
      }
      const incoming = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      if (!node.profile) {
        return fail(new MavlinkError('MISSING_PROFILE',
          'Fan-out node has no profile configured (deleted or disabled config node?).'));
      }
      const defaults = node.profile.getDefaults ? node.profile.getDefaults() : {};

      const broadcast = toBool(firstDefined(incoming.broadcast, node.mode === 'broadcast'), false);
      // Target list precedence: explicit targets > sysids > a swarm registry
      // output's vehicles (wired straight from mavlink-ai-swarm).
      let targets = incoming.targets;
      if (!Array.isArray(targets) && Array.isArray(incoming.sysids)) {
        targets = incoming.sysids;
      }
      if (!Array.isArray(targets) && Array.isArray(incoming.vehicles)) {
        targets = [...new Set(incoming.vehicles.map((v) => v && v.sysid).filter((s) => Number.isFinite(Number(s))))];
      }

      const command = firstDefined(incoming.command, node.command || undefined);
      const useInt = toBool(firstDefined(incoming.command_int, node.sendAs === 'int'), false);
      const base = Object.assign({}, configBase, incoming.fields && typeof incoming.fields === 'object' ? incoming.fields : {});
      /**
       * The dialect enums let buildFanout reject an unknown command/frame NAME
       * up front (fail fast at this node), matching the Mission node. Null when
       * the profile's dialect isn't loaded — buildFanout then range-checks
       * numbers and requires a non-blank name, deferring name resolution to the
       * codec as before.
       */
      const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
      const enums = bundle && bundle.valid ? bundle.enums : null;

      let messages;
      try {
        messages = buildFanout({
          command,
          useInt,
          broadcast,
          targets,
          base,
          origin: incoming.origin || null,
          defaults,
          enums
        });
      } catch (err) {
        const e = toMavlinkError(err, 'FANOUT_FAILED');
        return fail(e);
      }
      // `vehicleProfile` carries the config-node id — the canonical reference
      // the connection resolves a codec by. The name is display-only. An
      // explicit localIdentity request rides along untouched; it is never
      // derived from the Vehicle Profile (#228).
      const decorated = messages.map((m) => {
        const out = Object.assign(
          { vehicleProfile: node.profile && node.profile.id, vehicleProfileName: node.profile && node.profile.name },
          m
        );
        if (incoming.localIdentity !== undefined && incoming.localIdentity !== null && incoming.localIdentity !== '') {
          out.localIdentity = incoming.localIdentity;
        }
        return out;
      });

      // Dry-run: show exactly what would be sent (per issue #46, formation and
      // frame mistakes should be visible before anything reaches a vehicle).
      // Orthogonal to Delivery (#207): it short-circuits FIRST in any mode, so
      // Send/Await never touch a vehicle while dry-run is on.
      if (toBool(firstDefined(incoming.dry_run, node.dryRun), false)) {
        msg.topic = 'swarm/dryrun';
        msg.payload = { broadcast, count: decorated.length, messages: decorated };
        node.status({ fill: 'yellow', shape: 'dot', text: `dry-run ${decorated.length}` });
        send([msg, null]);
        return done();
      }

      /**
       * Priority stamp shared by Send and Build delivery (#241): every clone
       * carries the same command, so one resolution serves all decorated
       * targets. Await needs no stamp — CommandSend sends immediately.
       */
      const buildBundle = node.profile && node.profile.getDialect ? node.profile.getDialect() : null;
      const fanPriority = commandPriorityFor(buildBundle && buildBundle.valid ? buildBundle.enums : null, command);

      // --- await mode: run the command protocol per vehicle ------------------
      if (mode === DELIVERY.AWAIT) {
        if (!node.connection) {
          return fail(new MavlinkError('NO_CONNECTION',
            'Send & await result requires a connection to send on (select one in the node config).'));
        }
        if (broadcast) {
          return fail(new MavlinkError('BROADCAST_NO_ACK',
            'Broadcast (target_system 0) cannot collect per-vehicle ACKs — use fan-out mode, or use a non-await Delivery mode.'));
        }
        const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
        // The Local Identity these workflows transmit as (#228): the explicit
        // payload request when present, else the connection default. Its
        // source ids gate per-vehicle ACK matching (#99).
        let source;
        try {
          source = node.connection.resolveOutboundIdentity(incoming.localIdentity).getIdentity();
        } catch (err) {
          const e = toMavlinkError(err, 'LOCAL_IDENTITY_UNRESOLVED');
          return fail(e);
        }
        const results = {};
        const accepted = [];
        const failed = [];
        const timedOut = [];
        const skipped = [];
        let aborted = false;
        let dispatched = 0;

        /**
         * Run the command protocol for one target and fold the outcome into the
         * aggregation arrays. Never rejects — every error is classified here — so
         * the dispatcher can Promise.race the in-flight set safely. Sets `aborted`
         * on the first failure when stop-on-error is on, so the dispatcher stops
         * launching new targets.
         *
         * @param {number} i  index into `decorated`
         * @returns {Promise<void>}
         */
        async function runTarget(i) {
          const m = decorated[i];
          const sysid = m.target_system;
          dispatched += 1;
          node.status({ fill: 'blue', shape: 'dot', text: `ack ${dispatched}/${decorated.length} (sys ${sysid})` });
          let workflow;
          try {
            workflow = new CommandSend({
              connection: node.connection,
              /** The connection must encode these sends with this node's Vehicle Profile, not its own default. */
              vehicleProfile: node.profile.id,
              /** Explicit identity request passes through; blank means the connection default. */
              localIdentity: incoming.localIdentity,
              targetSystem: sysid,
              targetComponent: m.target_component,
              /** Our own identity, so an ACK addressed to another GCS sharing this link doesn't settle the workflow (#99). */
              sourceSystem: source.sysid,
              sourceComponent: source.compid,
              command: m.fields.command,
              fields: m.fields,
              useInt,
              enums: bundle && bundle.valid ? bundle.enums : null,
              dialect: bundle && bundle.valid ? bundle.name : 'unknown',
              timeoutMs: node.timeoutMs,
              maxRetries: node.maxRetries
            });
            activeWorkflows.add(workflow);
            const res = await workflow.run();
            accepted.push(sysid);
            results[sysid] = { result: res.payload.result_name || res.payload.result, command: res.payload.command_name };
          } catch (err) {
            const e = toMavlinkError(err, 'COMMAND_FAILED');
            if (e.code === 'COMMAND_TIMEOUT') {
              timedOut.push(sysid);
              results[sysid] = { error: e.code };
            } else {
              failed.push(sysid);
              results[sysid] = { error: e.code, result: e.context && e.context.result_name, reason: e.message };
            }
            if (node.stopOnError) {
              aborted = true;
            }
          } finally {
            if (workflow) {
              activeWorkflows.delete(workflow);
            }
          }
        }

        /**
         * Dispatch up to node.concurrency targets at once. A free slot is awaited
         * before each launch; `spacingMs` still paces successive dispatches (a gap
         * before every launch but the first), so at concurrency 1 the run/gap/run
         * cadence is identical to the original sequential loop. `closed` (redeploy)
         * and `aborted` (stop-on-error) both halt further dispatch.
         */
        let nextIndex = 0;
        const inFlight = new Set();
        while (nextIndex < decorated.length && !closed && !aborted) {
          while (inFlight.size >= node.concurrency) {
            await Promise.race(inFlight);
            if (closed || aborted) {
              break;
            }
          }
          if (closed || aborted) {
            break;
          }
          if (node.spacingMs > 0 && nextIndex > 0) {
            await delay(node.spacingMs);
            if (closed || aborted) {
              break;
            }
          }
          const i = nextIndex;
          nextIndex += 1;
          const p = runTarget(i).finally(() => inFlight.delete(p));
          inFlight.add(p);
        }
        await Promise.allSettled(inFlight);

        /** Aborted by close (redeploy): emit no output from an obsolete node. */
        if (closed) {
          return done();
        }

        /**
         * Stop-on-error leaves the targets never dispatched — mark them skipped in
         * target order so the caller sees exactly which vehicles were not commanded.
         */
        for (let i = nextIndex; aborted && i < decorated.length; i += 1) {
          const sysid = decorated[i].target_system;
          skipped.push(sysid);
          results[sysid] = { error: 'SKIPPED', reason: 'stop-on-error aborted remaining targets' };
        }
        msg.topic = 'swarm/ack';
        msg.payload = { accepted, failed, timedOut, skipped, results };
        const ok = failed.length === 0 && timedOut.length === 0 && skipped.length === 0;
        node.status({
          fill: ok ? 'green' : 'yellow',
          shape: 'dot',
          text: `${accepted.length}/${decorated.length} accepted`
        });
        send([msg, null]);
        return done();
      }

      // --- send mode: send every target directly on the connection (#207) ----
      if (mode === DELIVERY.SEND) {
        if (!node.connection) {
          return fail(new MavlinkError('NO_CONNECTION',
            'Send via connection requires a connection to send on (select one in the node config).'));
        }
        const connection = node.connection;
        const results = {};
        const sent = [];
        const sendFailed = [];
        const skipped = [];
        let aborted = false;
        let dispatched = 0;

        /**
         * Send one decorated target directly on the connection and fold the
         * outcome into the aggregation arrays. Never rejects — every error is
         * classified here — so the dispatcher can Promise.race the in-flight
         * set safely. Sets `aborted` on the first failure when stop-on-error
         * is on, so the dispatcher stops launching new targets.
         *
         * @param {number} i  index into `decorated`
         * @returns {Promise<void>}
         */
        async function sendTarget(i) {
          const m = decorated[i];
          const sysid = m.target_system;
          dispatched += 1;
          node.status({ fill: 'blue', shape: 'dot', text: `send ${dispatched}/${decorated.length} (sys ${sysid})` });
          try {
            await connection.send(m, { priority: fanPriority });
            sent.push(sysid);
            results[sysid] = { sent: true };
          } catch (err) {
            const e = toMavlinkError(err, 'SEND_FAILED');
            sendFailed.push(sysid);
            results[sysid] = { error: e.code, reason: e.message };
            if (node.stopOnError) {
              aborted = true;
            }
          }
        }

        /**
         * Dispatch up to node.concurrency targets at once, identical pacing to
         * the await dispatcher above: a free slot is awaited before each
         * launch, `spacingMs` paces successive dispatches, and `closed`
         * (redeploy) / `aborted` (stop-on-error) both halt further dispatch.
         */
        let nextIndex = 0;
        const inFlight = new Set();
        while (nextIndex < decorated.length && !closed && !aborted) {
          while (inFlight.size >= node.concurrency) {
            await Promise.race(inFlight);
            if (closed || aborted) {
              break;
            }
          }
          if (closed || aborted) {
            break;
          }
          if (node.spacingMs > 0 && nextIndex > 0) {
            await delay(node.spacingMs);
            if (closed || aborted) {
              break;
            }
          }
          const i = nextIndex;
          nextIndex += 1;
          const p = sendTarget(i).finally(() => inFlight.delete(p));
          inFlight.add(p);
        }
        await Promise.allSettled(inFlight);

        /** Aborted by close (redeploy): emit no output from an obsolete node. */
        if (closed) {
          return done();
        }

        /**
         * Stop-on-error leaves the targets never dispatched — mark them skipped in
         * target order (mirroring the await-ack aggregate's top-level `skipped`
         * array, #308) so a consumer can see exactly which vehicles were not sent
         * to without having to scan `results` for `error: 'SKIPPED'` entries.
         */
        for (let i = nextIndex; aborted && i < decorated.length; i += 1) {
          const sysid = decorated[i].target_system;
          skipped.push(sysid);
          results[sysid] = { error: 'SKIPPED', reason: 'stop-on-error aborted remaining targets' };
        }
        msg.topic = 'swarm/sent';
        msg.payload = { sent, failed: sendFailed, skipped, results };
        const ok = sendFailed.length === 0 && skipped.length === 0;
        node.status({
          fill: ok ? 'green' : 'yellow',
          shape: 'dot',
          text: `${sent.length}/${decorated.length} sent`
        });
        send([msg, null]);
        return done();
      }

      // --- build mode (default): hand off to mavlink-ai-out -------------------
      /**
       * Stamp the CRITICAL band when the fanned-out command resolves to a
       * critical MAV_CMD (#241), mirroring the command node: fanout -> out
       * must ride the same band as Send/Await delivery, or a fanned arm/mode
       * change queues behind normal traffic. Non-critical commands carry no
       * stamp so flows keep control of the field.
       */
      const toSend = decorated.map((payload) => {
        const out = RED.util.cloneMessage(msg);
        out.topic = 'mavlink/send';
        out.payload = payload;
        if (fanPriority === PRIORITY.CRITICAL) {
          out.priority = fanPriority;
        }
        return out;
      });
      if (node.spacingMs > 0 && toSend.length > 1) {
        // Pace the emission so a downstream out node doesn't burst the link.
        for (let i = 0; i < toSend.length; i += 1) {
          if (closed) {
            return done(); // node closed mid-pacing: stop emitting (#83)
          }
          send([toSend[i], null]);
          if (i < toSend.length - 1) {
            await delay(node.spacingMs);
          }
        }
      } else {
        // Multiple messages on port 0, nothing on port 1: the outer array is
        // per-port, the inner array is the batch of fan-out messages (#207).
        send([toSend, null]);
      }
      node.status({
        fill: 'green',
        shape: 'dot',
        text: broadcast ? 'broadcast' : `fan-out ${toSend.length}`
      });
      done();
    });

    /**
     * Abort every in-flight per-target ACK workflow and stop the fan-out
     * dispatcher on close (#83), so a partial deploy doesn't keep commanding the
     * remaining targets from an obsolete node. Multiple may be in flight once
     * concurrency > 1 (#155).
     */
    node.on('close', function closeFanout(done) {
      closed = true;
      for (const workflow of activeWorkflows) {
        workflow.abort('mavlink-ai-fanout node closed');
      }
      activeWorkflows.clear();
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-fanout', MavlinkAiFanoutNode);
};
