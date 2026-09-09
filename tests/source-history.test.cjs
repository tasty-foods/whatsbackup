const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
test('import counts and first failure survive an engine reload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-history-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(root).startsWith('whatsbackup-history-')); fs.rmSync(root, { recursive: true, force: true }); });
  function load() {
    const ctx = { console, module: { exports: {} }, require: name => name === './paths' ? { DATA_DIR: root } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/source-history.js'), 'utf8'), ctx);
    return ctx.module.exports;
  }
  const run = { at: 1234, saved: 2, skipped: 1, failed: 1, firstError: 'http 503' };
  load().write('chatgpt', run);
  assert.equal(JSON.stringify(load().read('chatgpt')), JSON.stringify(run));
  assert.equal(load().read('gemini'), null);
  fs.writeFileSync(path.join(root, 'gemini-import.json'), 'interrupted');
  assert.equal(load().read('gemini'), null);
});
