'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MavLinkProtocolV2, minimal, x25crc } = require('node-mavlink');
const { MockRED } = require('../helpers/mock-red');
const { nextEvent } = require('../helpers/next-event');
const { loadDialect, getMessageClass } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { enc } = require('../helpers/v3-config');

/**
 * A frame carrying a MAVLink-2 incompatibility flag the implementation does not
 * understand must be discarded per the spec — an unknown incompat flag can
 * change how the rest of the frame is interpreted (#153). Only IFLAG_SIGNED
 * (0x01) is understood; a frame setting any other bit is rejected in onPacket
 * before it is decoded or dispatched.
 */

const common = loadDialect('common');
const HB = {
  type: minimal.MavType.GCS,
  autopilot: minimal.MavAutopilot.INVALID,
  base_mode: 0,
  custom_mode: 0,
  system_status: minimal.MavState.ACTIVE
};

function setup() {
  const RED = new MockRED().loadNodes();
  RED.create('mavlink-ai-vehicle', {
    id: 'p1', name: 'P', dialect: 'common', mavlinkVersion: 'v2',
    defaultTargetSystem: 7, defaultTargetComponent: 3
  });
  RED.create('mavlink-ai-local-identity', {
    id: 'id1', name: 'GCS', role: 'custom', sourceSystemId: 255, sourceComponentId: 190
  });
  const conn = RED.create('mavlink-ai-connection', {
    id: 'c1', name: 'C', profile: 'p1', localIdentity: 'id1', transport: 'udp',
    bindAddress: '127.0.0.1', bindPort: 0, reconnect: false, heartbeat: false
  });
  return { RED, conn };
}

/**
 * Build a valid v2 HEARTBEAT frame, then set an unsupported incompat flag byte
 * (v2 header index 2) and recompute the CRC so the frame still passes the
 * splitter's CRC check and reaches onPacket with the bad flag intact.
 *
 * @param {number} incompatFlags  the incompat byte to stamp (e.g. 0x02)
 * @returns {Buffer}
 */
function heartbeatWithIncompat(incompatFlags) {
  const codec = new MavlinkCodec({ bundle: common, version: 'v2' });
  const frame = Buffer.from(enc(codec, 'HEARTBEAT', HB, { sysid: 3, compid: 1 }));
  frame.writeUInt8(incompatFlags, 2);
  const magic = getMessageClass(common, 'HEARTBEAT').MAGIC_NUMBER;
  const crc = x25crc(frame, 1, 2, magic);
  frame.writeUInt16LE(crc, frame.length - 2);
  return frame;
}

test('a frame with an unsupported incompat flag is rejected, not decoded (#153)', async (t) => {
  const { RED, conn } = setup();
  t.after(() => RED.close(conn));

  const messages = [];
  conn.subscribe({}, (m) => messages.push(m));

  /** incompat 0x02 is not implemented → the frame must be rejected. */
  const rejected = nextEvent(conn.emitter, 'rejected');
  conn._transport.emit('data', heartbeatWithIncompat(MavLinkProtocolV2.IFLAG_SIGNED << 1));
  assert.strictEqual((await rejected).reason, 'incompat-unsupported');
  assert.strictEqual(messages.length, 0, 'the frame must not be dispatched');
});

test('a normal frame (no incompat flags) still decodes (#153)', async (t) => {
  const { RED, conn } = setup();
  t.after(() => RED.close(conn));

  const message = nextEvent(conn.emitter, 'message');
  conn._transport.emit('data', heartbeatWithIncompat(0x00));
  assert.strictEqual((await message).payload.name, 'HEARTBEAT');
});
