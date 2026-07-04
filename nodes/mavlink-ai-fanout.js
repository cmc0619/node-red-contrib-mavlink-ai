'use strict';

const { errorPayload, toMavlinkError } = require('../lib/util/errors');
const { firstDefined, toInt, toBool } = require('../lib/util/validation');
const { buildFanout } = require('../lib/swarm/fanout');
const { CommandSend } = require('../lib/command/command-workflow');

/**
 * mavlink-ai-fanout (issue #46).
 *
 * Expands one logical command into one message per target vehicle
 * (`target_system` filled in per sysid), or — explicitly and only when asked —
 * a single broadcast message to `target_system` 0. With "await acks" enabled
 * it runs the command protocol per vehicle and aggregates the per-sysid
 * results into accepted/failed/timedOut arrays; partial failure is normal in
 * swarm operations and is never hidden.
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
    node.profile = RED.nodes.getNode(config.profile);
    node.connection = config.connection ? RED.nodes.getNode(config.connection) : null;
    node.command = config.command || '';
    node.mode = config.mode === 'broadcast' ? 'broadcast' : 'fanout';
    node.sendAs = config.sendAs || 'long';
    node.awaitAck = toBool(config.awaitAck, false);
    node.timeoutMs = toInt(config.timeoutMs, 3000);
    node.maxRetries = toInt(config.maxRetries, 3);
    node.spacingMs = toInt(config.spacingMs, 0);
    node.stopOnError = toBool(config.stopOnError, false);
    node.dryRun = toBool(config.dryRun, false);

    let configBase = {};
    if (config.fields) {
      try {
        configBase = JSON.parse(config.fields);
      } catch (e) {
        node.warn(`mavlink-ai-fanout: invalid fields JSON, ignoring (${e.message})`);
      }
    }

    /** Emit a structured error and finish the handler. */
    function sendError(msg, send, done, code, message, context) {
      node.status({ fill: 'red', shape: 'ring', text: code });
      msg.topic = 'mavlink/error';
      msg.payload = errorPayload({ node: 'mavlink-ai-fanout', code, message, context });
      send(msg);
      done();
    }

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    node.on('input', async (msg, send, done) => {
      const incoming = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};

      if (!node.profile) {
        return sendError(msg, send, done, 'MISSING_PROFILE',
          'Fan-out node has no profile configured (deleted or disabled config node?).');
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

      let messages;
      try {
        messages = buildFanout({
          command,
          useInt,
          broadcast,
          targets,
          base,
          origin: incoming.origin || null,
          defaults
        });
      } catch (err) {
        const e = toMavlinkError(err, 'FANOUT_FAILED');
        return sendError(msg, send, done, e.code, e.message, e.context);
      }
      const decorated = messages.map((m) => Object.assign({ profile: node.profile && node.profile.name }, m));

      // Dry-run: show exactly what would be sent (per issue #46, formation and
      // frame mistakes should be visible before anything reaches a vehicle).
      if (toBool(firstDefined(incoming.dry_run, node.dryRun), false)) {
        msg.topic = 'swarm/dryrun';
        msg.payload = { broadcast, count: decorated.length, messages: decorated };
        node.status({ fill: 'yellow', shape: 'dot', text: `dry-run ${decorated.length}` });
        send(msg);
        return done();
      }

      // --- await-acks mode: run the command protocol per vehicle -------------
      if (node.awaitAck) {
        if (!node.connection) {
          return sendError(msg, send, done, 'NO_CONNECTION',
            'Await acks requires a connection to send on (select one in the node config).');
        }
        if (broadcast) {
          return sendError(msg, send, done, 'BROADCAST_NO_ACK',
            'Broadcast (target_system 0) cannot collect per-vehicle ACKs — use fan-out mode, or disable await acks.');
        }
        const bundle = node.profile.getDialect ? node.profile.getDialect() : null;
        const results = {};
        const accepted = [];
        const failed = [];
        const timedOut = [];
        const skipped = [];
        let aborted = false;

        for (let i = 0; i < decorated.length; i += 1) {
          const m = decorated[i];
          const sysid = m.target_system;
          if (aborted) {
            skipped.push(sysid);
            results[sysid] = { error: 'SKIPPED', reason: 'stop-on-error aborted remaining targets' };
            continue;
          }
          node.status({ fill: 'blue', shape: 'dot', text: `ack ${i + 1}/${decorated.length} (sys ${sysid})` });
          try {
            const workflow = new CommandSend({
              connection: node.connection,
              targetSystem: sysid,
              targetComponent: m.target_component,
              command: m.fields.command,
              fields: m.fields,
              useInt,
              enums: bundle && bundle.valid ? bundle.enums : null,
              timeoutMs: node.timeoutMs,
              maxRetries: node.maxRetries
            });
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
          }
          if (node.spacingMs > 0 && i < decorated.length - 1) {
            await delay(node.spacingMs);
          }
        }

        msg.topic = 'swarm/ack';
        msg.payload = { accepted, failed, timedOut, skipped, results };
        const ok = failed.length === 0 && timedOut.length === 0 && skipped.length === 0;
        node.status({
          fill: ok ? 'green' : 'yellow',
          shape: 'dot',
          text: `${accepted.length}/${decorated.length} accepted`
        });
        send(msg);
        return done();
      }

      // --- build-only mode (default): hand off to mavlink-ai-out -------------
      const toSend = decorated.map((payload) => {
        const out = RED.util.cloneMessage(msg);
        out.topic = 'mavlink/send';
        out.payload = payload;
        return out;
      });
      if (node.spacingMs > 0 && toSend.length > 1) {
        // Pace the emission so a downstream out node doesn't burst the link.
        for (let i = 0; i < toSend.length; i += 1) {
          send(toSend[i]);
          if (i < toSend.length - 1) {
            await delay(node.spacingMs);
          }
        }
      } else {
        send([toSend]);
      }
      node.status({
        fill: 'green',
        shape: 'dot',
        text: broadcast ? 'broadcast' : `fan-out ${toSend.length}`
      });
      done();
    });
  }

  RED.nodes.registerType('mavlink-ai-fanout', MavlinkAiFanoutNode);
};
