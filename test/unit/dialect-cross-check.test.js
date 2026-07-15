'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const mappings = require('mavlink-mappings');
const { compileXmlDialect } = require('../../lib/dialects/xml-dialect-compiler');

/**
 * Compiled-vs-generated cross-check and <extensions> compiler coverage
 * (#152 items 3 and 4).
 *
 * The runtime XML dialect compiler (lib/dialects/xml-dialect-compiler.js) has to
 * reproduce MAVLink's wire layout exactly — size-descending field sort, extension
 * fields appended in source order, payload length, and the CRC_EXTRA magic number
 * that excludes extension fields. Manual inspection found it correct today, but a
 * regression there would be invisible: nothing asserted the compiled classes equal
 * the pre-generated mavlink-mappings ones. These tests pin that invariant against
 * three real messages that together exercise size-sorting, an array field, and the
 * extension boundary.
 *
 * Two fixtures back these tests. common_replica.xml holds faithful replicas of
 * HEARTBEAT (0), PARAM_VALUE (22) and COMMAND_ACK (77) whose field types, names,
 * ids and source order match the upstream dialect XML, so the compiled wire layout
 * can be asserted equal to the generated classes. command_ack_noext.xml is the same
 * COMMAND_ACK field set without the <extensions/> marker, isolating the extension
 * region's effect on field order and CRC_EXTRA.
 */

const DIR = path.join(__dirname, '..', 'fixtures', 'dialects');
const fixture = (name) => path.join(DIR, name);

/**
 * The generated message class for a numeric id, from the bundled minimal+common.
 *
 * @param {number} id
 * @returns {Function|undefined}
 */
function generatedClassById(id) {
  for (const mod of [mappings.minimal, mappings.common]) {
    if (mod.REGISTRY && mod.REGISTRY[id]) {
      return mod.REGISTRY[id];
    }
  }
  return undefined;
}

/**
 * A comparable, order-preserving snapshot of a class's wire layout.
 *
 * @param {Function} clazz  a message class with a FIELDS array
 * @returns {object[]}
 */
function fieldLayout(clazz) {
  return clazz.FIELDS.map((f) => ({
    source: f.source,
    offset: f.offset,
    size: f.size,
    type: f.type,
    arrayLength: f.arrayLength || 0,
    extension: Boolean(f.extension)
  }));
}

/**
 * HEARTBEAT exercises size-sorting (uint32 custom_mode jumps ahead of the uint8s
 * declared before it); PARAM_VALUE carries a char[16] array field; COMMAND_ACK
 * straddles the <extensions> boundary.
 */
const CROSS_CHECK = [
  { id: 0, name: 'HEARTBEAT' },
  { id: 22, name: 'PARAM_VALUE' },
  { id: 77, name: 'COMMAND_ACK' }
];

test('compiled common replicas match the generated mavlink-mappings classes (#152.4)', () => {
  const compiled = compileXmlDialect(fixture('common_replica.xml'));
  for (const { id, name } of CROSS_CHECK) {
    const got = compiled.module.REGISTRY[id];
    const gen = generatedClassById(id);
    assert.ok(got, `compiled ${name} present`);
    assert.ok(gen, `generated ${name} present`);
    assert.strictEqual(got.MSG_ID, gen.MSG_ID, `${name} MSG_ID`);
    assert.strictEqual(got.MSG_NAME, gen.MSG_NAME, `${name} MSG_NAME`);
    /**
     * The CRC_EXTRA magic is the single most sensitive invariant: it folds in
     * every field's type, name, order, and array length, and a wrong one makes
     * every packet of this id fail validation.
     */
    assert.strictEqual(got.MAGIC_NUMBER, gen.MAGIC_NUMBER, `${name} MAGIC_NUMBER`);
    assert.strictEqual(got.PAYLOAD_LENGTH, gen.PAYLOAD_LENGTH, `${name} PAYLOAD_LENGTH`);
    assert.deepStrictEqual(fieldLayout(got), fieldLayout(gen), `${name} field layout`);
  }
});

test('COMMAND_ACK extension fields are appended in source order and flagged (#152.3)', () => {
  const ack = compileXmlDialect(fixture('common_replica.xml')).module.REGISTRY[77];
  const bySource = ack.FIELDS.map((f) => f.source);
  /**
   * Base fields first (in size-descending order), then the four extension fields
   * in the XML source order they were declared — never size-sorted among.
   */
  assert.deepStrictEqual(bySource, [
    'command',
    'result',
    'progress',
    'result_param2',
    'target_system',
    'target_component'
  ]);
  const extension = ack.FIELDS.filter((f) => f.extension).map((f) => f.source);
  assert.deepStrictEqual(extension, ['progress', 'result_param2', 'target_system', 'target_component']);
  /** The base fields carry no extension flag. */
  assert.deepStrictEqual(ack.FIELDS.filter((f) => !f.extension).map((f) => f.source), ['command', 'result']);
});

test('extension fields are excluded from CRC_EXTRA and kept in source order (#152.3)', () => {
  const withExt = compileXmlDialect(fixture('common_replica.xml')).module.REGISTRY[77];
  const noExt = compileXmlDialect(fixture('command_ack_noext.xml')).module.REGISTRY[77];

  /** Same six fields, same payload length either way... */
  assert.strictEqual(withExt.PAYLOAD_LENGTH, noExt.PAYLOAD_LENGTH);

  /**
   * ...but marking the trailing four as extensions changes the wire layout and
   * the magic: as extensions they stay in source order and drop out of CRC_EXTRA;
   * as ordinary fields they size-sort (int32 result_param2 moves to offset 0) and
   * count toward the magic. Different magic from an identical field set is the
   * observable proof the compiler treats the extension region specially.
   */
  assert.notStrictEqual(withExt.MAGIC_NUMBER, noExt.MAGIC_NUMBER);
  assert.strictEqual(noExt.FIELDS[0].source, 'result_param2');
  assert.ok(noExt.FIELDS.every((f) => !f.extension), 'no field is an extension without the marker');

  /** The extension-aware magic is the correct one — it equals the generated class. */
  assert.strictEqual(withExt.MAGIC_NUMBER, generatedClassById(77).MAGIC_NUMBER);
});
