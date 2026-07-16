'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../../lib/command/bitmask');

/**
 * The command editor (nodes/mavlink-ai-command.html) runs in the browser and
 * can't require lib/command/bitmask.js, so it inlines byte-for-byte copies of
 * the uint32 helpers (#242). Like the transport-fields spec test (#103), this
 * extracts the editor's copies and runs the same acceptance matrix against
 * BOTH implementations, so the two can't drift apart — and the matrix itself
 * proves the signed-bitwise bugs stay fixed: bit 31 never flips a value
 * negative, unknown bits survive toggling known flags, and garbage input is
 * rejected instead of silently truncated.
 */

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'mavlink-ai-command.html'), 'utf8');

/**
 * Extract the editor's inlined helper functions (defined at 6-space indent,
 * so the first 6-space closing brace ends each body — nested blocks close
 * deeper) and evaluate them together into a callable namespace.
 *
 * @returns {object}
 */
function extractEditorHelpers() {
  const names = ['parseBitmaskValue', 'isSingleBit', 'orBits', 'hasBit', 'residualBits'];
  const sources = names.map((name) => {
    const match = new RegExp(`(function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n      \\})`).exec(HTML);
    assert.ok(match, `expected the editor to inline ${name}`);
    return match[1];
  });
  return new Function(
    `${sources.join('\n')}\nreturn { parseBitmaskValue, isSingleBit, orBits, hasBit, residualBits };`
  )();
}

const editor = extractEditorHelpers();
const BIT30 = 1073741824;
const BIT31 = 2147483648;
const ALL = 4294967295;

for (const [label, impl] of [
  ['lib/command/bitmask', lib],
  ['editor inline copy', editor]
]) {
  test(`${label}: uint32 parse accepts decimal/hex, rejects garbage (#242)`, () => {
    assert.strictEqual(impl.parseBitmaskValue(0), 0);
    assert.strictEqual(impl.parseBitmaskValue(1), 1);
    assert.strictEqual(impl.parseBitmaskValue('4294967295'), ALL);
    /** hex strings parse exactly — uint32 fits a double with no precision loss */
    assert.strictEqual(impl.parseBitmaskValue('0xFFFFFFFF'), ALL);
    assert.strictEqual(impl.parseBitmaskValue('0x80000000'), BIT31);
    for (const bad of [1.5, -1, 4294967296, NaN, Infinity, '', '   ', 'x', null, undefined, {}]) {
      assert.strictEqual(impl.parseBitmaskValue(bad), null, `rejects ${String(bad)}`);
    }
  });

  test(`${label}: single-bit detection covers bits 0, 30, 31 (#242)`, () => {
    assert.strictEqual(impl.isSingleBit(1), true);
    assert.strictEqual(impl.isSingleBit(BIT30), true);
    assert.strictEqual(impl.isSingleBit(BIT31), true, 'bit 31 is a valid flag, not a negative number');
    assert.strictEqual(impl.isSingleBit(3), false);
    assert.strictEqual(impl.isSingleBit(0), false);
    assert.strictEqual(impl.isSingleBit(ALL), false);
    assert.strictEqual(impl.isSingleBit(4294967296), false, 'above uint32 is not a flag');
  });

  test(`${label}: OR / membership / residual stay non-negative through bit 31 (#242)`, () => {
    assert.strictEqual(impl.orBits([1, BIT31]), BIT31 + 1, 'OR with bit 31 stays positive');
    assert.strictEqual(impl.orBits([]), 0);
    assert.strictEqual(impl.orBits([ALL]), ALL);
    assert.strictEqual(impl.hasBit(BIT31 + 1, BIT31), true);
    assert.strictEqual(impl.hasBit(BIT31 + 1, 2), false);
    /** known flags 1|2; a saved value carrying bit 31 leaves a POSITIVE residual */
    assert.strictEqual(impl.residualBits(BIT31 + 1, 3), BIT31);
    assert.strictEqual(impl.residualBits(ALL, 0), ALL);
    assert.strictEqual(impl.residualBits(ALL, ALL), 0);
  });

  test(`${label}: save/reopen round trip and unknown-bit preservation (#242)`, () => {
    /** String(value) -> parse recovers the exact uint32, including all-bits-set */
    for (const v of [1, BIT30, BIT31, BIT31 + 1, ALL]) {
      assert.strictEqual(impl.parseBitmaskValue(String(impl.orBits([v]))), v);
    }
    /**
     * The editor recomputes the persisted value as OR(checked flags, residual):
     * unchecking a known flag must not disturb bits the current metadata
     * doesn't know (the same math re-derives the residual after a metadata
     * refresh, so a rebuilt control preserves them too).
     */
    const saved = impl.parseBitmaskValue('2147483651'); /** bit31 | flags 1,2 */
    const residual = impl.residualBits(saved, 3);
    assert.strictEqual(impl.orBits([1, residual]), BIT31 + 1, 'unchecking flag 2 keeps bit 31');
    assert.strictEqual(impl.orBits([1, 2, residual]), saved, 'rechecking restores the exact value');
  });
}
