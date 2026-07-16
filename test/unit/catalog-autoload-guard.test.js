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

/**
 * Extract the editor's loadCatalog and evaluate it against a scope object,
 * so the test controls ctxRequestId, the ajax outcome, and observes which
 * loaders re-fire. `with` makes the scope's bindings visible to the extracted
 * source exactly as the editor closure's would be.
 *
 * @param {object} scope
 * @returns {function}
 */
function editorLoadCatalog(scope) {
  const match = /(function loadCatalog\(\) \{[\s\S]*?\n      \})/.exec(HTML);
  assert.ok(match, 'expected the editor to define loadCatalog');
  return new Function('scope', `with (scope) { ${match[1]}; return loadCatalog; }`)(scope);
}

/** A scope stub capturing ajax handlers and loader re-fires. */
function catalogScope() {
  const scope = {
    calls: { statusCheck: 0, list: 0, detail: 0, ajax: 0 },
    statusTexts: [],
    handlers: null,
    ctxRequestId: 1,
    paramContext: () => ({ firmware: 'ardupilot', vehicleType: 'copter' }),
    loadCatalogStatus: () => (scope.calls.statusCheck += 1),
    loadParamList: () => (scope.calls.list += 1),
    loadParamDetail: () => (scope.calls.detail += 1)
  };
  const $ = () => ({
    is: () => false,
    val: () => '',
    text: (t) => scope.statusTexts.push(t)
  });
  $.ajax = () => {
    scope.calls.ajax += 1;
    const handle = { done(cb) { scope.handlers = Object.assign({}, scope.handlers, { done: cb }); return handle; },
      fail(cb) { scope.handlers = Object.assign({}, scope.handlers, { fail: cb }); return handle; } };
    return handle;
  };
  scope.$ = $;
  return scope;
}

test('a download outliving its generation still populates the dialog (#246, Codex review)', () => {
  /**
   * The auto-load attempt is consumed at fire time, so if the action changes
   * while the download is in flight (bumping ctxRequestId), the replacement
   * status check refuses to start another. The completed download must
   * therefore nudge the current context's loaders itself, or the dialog stays
   * dead until a manual click even though the cache landed on disk.
   */
  const scope = catalogScope();
  const loadCatalog = editorLoadCatalog(scope);

  loadCatalog();
  assert.strictEqual(scope.calls.ajax, 1);
  scope.ctxRequestId += 1;
  scope.handlers.done({ count: 900, sourceKey: 'ardupilot:copter' });
  assert.strictEqual(scope.calls.statusCheck, 1, 'the stale success re-checks status for the current context');
  assert.strictEqual(scope.calls.list, 1, 'the param list is re-driven');
  assert.strictEqual(scope.calls.detail, 1, 'the value control is re-driven');

  /** A current-generation success populates directly, no status re-check. */
  const fresh = catalogScope();
  const freshLoad = editorLoadCatalog(fresh);
  freshLoad();
  fresh.handlers.done({ count: 900, sourceKey: 'ardupilot:copter' });
  assert.strictEqual(fresh.calls.statusCheck, 0);
  assert.strictEqual(fresh.calls.list, 1);
  assert.strictEqual(fresh.calls.detail, 1);
  assert.ok(fresh.statusTexts.some((t) => /Loaded 900 parameters/.test(t)));

  /** A stale failure stays quiet — the replacement status is already accurate. */
  const failed = catalogScope();
  const failedLoad = editorLoadCatalog(failed);
  failedLoad();
  failed.ctxRequestId += 1;
  failed.handlers.fail({});
  assert.strictEqual(failed.calls.statusCheck, 0);
  assert.strictEqual(failed.calls.list, 0);
});
