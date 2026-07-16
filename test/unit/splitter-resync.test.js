'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MavLinkPacketSplitter, MavLinkPacketParser } = require('node-mavlink');

const { loadDialect } = require('../../lib/dialects/dialect-loader');
const { MavlinkCodec } = require('../../lib/protocol/mavlink-codec');
const { LinkState } = require('../../lib/protocol/link-state');
const { enc } = require('../helpers/v3-config');

/**
 * Splitter resync on unvalidatable data (#153). node-mavlink's stock splitter
 * skips the full header-declared length of a frame whose msgid has no
 * CRC-extra entry — trusting a length byte it could not validate. A false
 * magic byte inside line noise can claim up to 280 bytes and swallow every
 * real frame in that window. The codec's splitter treats unvalidatable data
 * like a CRC failure instead: advance one byte and rescan (the MAVLink C
 * library / pymavlink strategy).
 */

const common = loadDialect('common');

/** Sequential valid HEARTBEAT frames (one shared link, so seq counts up). */
function heartbeats(count) {
  const codec = new MavlinkCodec({ bundle: common, version: 'v2' });
  const link = new LinkState();
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    frames.push(
      enc(codec, 'HEARTBEAT', { type: 2, autopilot: 3, base_mode: 81, custom_mode: i, system_status: 4 }, { sysid: 1, compid: 1, link })
    );
  }
  return frames;
}

/**
 * A phantom v2 header: a false magic byte claiming a 255-byte payload and an
 * unknown msgid (0xFFFFFF), as line noise on a serial link would produce. The
 * declared window (12 + 255 + 2 = 269 bytes) reaches deep into whatever
 * follows it. The splitter buffers until a claimed frame is complete, so the
 * tests feed more than 269 bytes of real frames behind the phantom — the
 * point where the stock splitter discards the whole window in one skip.
 */
const PHANTOM = Buffer.from([0xfd, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);

test('garbage claiming a huge phantom length no longer swallows the frames behind it (#153)', () => {
  const frames = heartbeats(14);
  const codec = new MavlinkCodec({ bundle: common, version: 'v2' });
  const got = [];
  const decoder = codec.createDecoder((packet) => got.push(packet.header.seq));

  decoder.write(Buffer.concat([PHANTOM, ...frames]));
  assert.strictEqual(got.length, 14, 'every real frame behind the phantom window decodes');
  assert.deepStrictEqual(got, frames.map((_, i) => i), 'in order, none skipped');
  decoder.destroy();
});

test('control: the stock splitter loses frames inside the phantom window (#153)', () => {
  /**
   * Pins the inherited defect this codec works around. If a node-mavlink
   * upgrade makes this control FAIL (all 14 frames decode), the stock
   * splitter has been fixed upstream and ResyncingPacketSplitter can go.
   */
  const frames = heartbeats(14);
  const splitter = new MavLinkPacketSplitter({}, { magicNumbers: common.magicNumbers });
  const parser = new MavLinkPacketParser();
  splitter.pipe(parser);
  const got = [];
  parser.on('data', (packet) => got.push(packet.header.seq));

  splitter.write(Buffer.concat([PHANTOM, ...frames]));
  assert.ok(got.length < 14, `stock splitter swallowed frames (decoded ${got.length}/14)`);
  splitter.destroy();
  parser.destroy();
});

test('a genuinely-unknown message between valid frames does not take its neighbours with it (#153)', () => {
  /**
   * An unknown-msgid frame cannot be CRC-validated (no CRC-extra), so the
   * resync walks through it byte-wise — slower than trusting its length byte,
   * but the frames around it must survive either way.
   */
  const frames = heartbeats(2);
  const unknown = Buffer.from([0xfd, 0x04, 0x00, 0x00, 0x07, 0x01, 0x01, 0xff, 0xff, 0xff, 0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb]);
  const codec = new MavlinkCodec({ bundle: common, version: 'v2' });
  const got = [];
  const decoder = codec.createDecoder((packet) => got.push(packet.header.seq));

  decoder.write(Buffer.concat([frames[0], unknown, frames[1]]));
  assert.deepStrictEqual(got, [0, 1], 'both neighbours decode');
  decoder.destroy();
});
