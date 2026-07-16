'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Param-editor catalog auto-load once-guard (#246 follow-up). The editor's
 * catalog status check re-runs on every action and profile change; the
 * automatic download it can trigger must fire at most ONCE per source per
 * dialog session, so an uncached catalog (offline, or the published URL
 * unreachable) doesn't re-fire the download on every toggle — the manual
 * Load parameters button is the documented retry path.
 *
 * Like the other editor-spec tests (#242, #251), this extracts the shipped
 * decision function from the HTML so the logic under test is the real code.
 */

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'mavlink-ai-param.html'), 'utf8');

/** Extract the editor's shouldAutoLoad (6-space indent, closes at the first 6-space brace). */
function editorShouldAutoLoad() {
  const match = /(function shouldAutoLoad\(source, relevant, attempted\) \{[\s\S]*?\n      \})/.exec(HTML);
  assert.ok(match, 'expected the editor to define shouldAutoLoad');
  return new Function(`${match[1]}\nreturn shouldAutoLoad;`)();
}

test('the automatic catalog load fires once per source per dialog session (#246)', () => {
  const shouldAutoLoad = editorShouldAutoLoad();
  const attempted = new Set();
  const ardupilot = { sourceKey: 'ardupilot:copter', urlRequired: false };

  assert.strictEqual(shouldAutoLoad(ardupilot, true, attempted), true, 'first status check auto-loads');
  assert.strictEqual(shouldAutoLoad(ardupilot, true, attempted), false, 'a re-check (action/profile toggle) does not re-fire');

  /** A different source (another vehicle/profile) still gets its own attempt. */
  const plane = { sourceKey: 'ardupilot:plane', urlRequired: false };
  assert.strictEqual(shouldAutoLoad(plane, true, attempted), true);
});

test('sources needing a pasted URL never auto-load; irrelevance does not consume the attempt (#246)', () => {
  const shouldAutoLoad = editorShouldAutoLoad();
  const attempted = new Set();

  const px4 = { sourceKey: 'px4:multicopter', urlRequired: true };
  assert.strictEqual(shouldAutoLoad(px4, true, attempted), false, 'PX4 waits for a pasted URL');
  assert.strictEqual(attempted.size, 0, 'a refused source consumes nothing');

  /** Seen first under a List action (catalog irrelevant)... */
  const ardupilot = { sourceKey: 'ardupilot:copter', urlRequired: false };
  assert.strictEqual(shouldAutoLoad(ardupilot, false, attempted), false);
  assert.strictEqual(attempted.size, 0, 'irrelevance does not consume the one attempt');
  /** ...switching to Read/Set still gets the one automatic attempt. */
  assert.strictEqual(shouldAutoLoad(ardupilot, true, attempted), true);
});
