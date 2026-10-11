const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { AiError } = require('../src/ai/provider');
const load = (file, deps) => {
  const context = { module: { exports: {} }, require: name => { if (!(name in deps)) throw new Error('Unexpected dependency: ' + name); return deps[name]; }, console, setTimeout, clearTimeout, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ai', file), 'utf8'), context);
  return context.module.exports;
};
function harness(t, work) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const ledger = load('store.js', { crypto: require('node:crypto'), '../messages': { handle: () => db } });
  const prefs = { aiEnabled: true, aiConsent: true, aiProvider: 'test', aiModel: 'fixture', aiAnalyseImages: true, aiAnalyseVideos: true, aiAnalyseDocuments: true, aiAnalyseChats: true, aiMonthlyBudget: 5, aiMode: 'manual', aiPaused: true, aiResumeOnLaunch: true, performanceMode: 'quiet' };
  const records = [{ id: 'target', kind: 'image' }, { id: 'other', kind: 'image' }];
  const calls = [];
  const deps = {
    '../settings': { read: () => ({ ...prefs }), write: patch => Object.assign(prefs, patch) },
    '../store': { get: id => records.find(r => r.id === id), listRecords: () => records },
    '../messages': { chatsWithText: () => new Set(), listChats: () => [] }, '../config': {}, './store': ledger,
    './label': { eachCandidate: fn => records.forEach(r => fn(r, 'image', null)), currentLabel: () => false, census: () => ({}), labelImage: async (cfg, rec) => { calls.push(rec.id); return work(cfg, rec); } },
    './arrange': {}, './probe': {}, './presets': { PRESETS: { test: { keyRequired: false } } }, './provider': { AiError },
    '../content/documents': { status: () => ({ running: false }) },
  };
  return { runner: load('index.js', deps), restart: () => load('index.js', deps), prefs, calls, ledger };
}
const idle = async runner => { const end = Date.now() + 5000; while (runner.status().running) { if (Date.now() > end) throw new Error('Runner did not finish'); await new Promise(r => setTimeout(r, 10)); } };
test('single-file indexing leaves unrelated queued jobs untouched and preserves pause', async t => {
  const h = harness(t, async cfg => { cfg.onUsage({ usage: { in: 20, out: 10 }, cost: 0.02, costCap: 0.02 }); return {}; });
  h.ledger.enqueue('label_image', 'other');
  assert.equal((await h.runner.run({ ids: ['target'], indexOnly: true })).ok, true);
  await idle(h.runner);
  assert.deepEqual(h.calls, ['target']); assert.equal(h.prefs.aiPaused, true);
  assert.equal(h.ledger.jobCounts().queued, 1);
  assert.equal(h.ledger.spendCapSince(0), 0.02);
});
test('pause finishes only the current item and retains the remaining queue for resume', async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const h = harness(t, async () => { await gate; return {}; });
  await h.runner.run({ indexOnly: true });
  h.runner.cancel(); finish(); await idle(h.runner);
  assert.deepEqual(h.calls, ['target']); assert.equal(h.ledger.jobCounts().queued, 1);
  assert.equal(h.prefs.aiPaused, true);
  await h.runner.kick(); assert.equal(h.calls.length, 1);
});
test('paid responses survive a later item failure and a restart cannot reset the budget', async t => {
  const h = harness(t, async cfg => {
    cfg.onUsage({ usage: { in: 500, out: 100 }, cost: 0.6, costCap: 0.6 });
    throw new AiError('A later scanned page failed', { retryable: false });
  });
  h.prefs.aiMonthlyBudget = 0.5;
  await h.runner.run({ indexOnly: true }); await idle(h.runner);
  assert.equal(h.ledger.spendCapSince(0), 0.6);
  assert.equal(h.ledger.jobCounts().queued, 1);
  assert.equal(h.calls.length, 1);
  await h.restart().kick(); assert.equal(h.calls.length, 1);
});
test('selected queue claiming never includes chat jobs with the same reference', t => {
  const h = harness(t, async () => ({}));
  h.ledger.enqueueMany([{ type: 'label_chat', refId: 'target' }, { type: 'label_image', refId: 'target' }, { type: 'label_video', refId: 'other' }]);
  const claimed = h.ledger.claim(3, { ids: ['target'], types: ['label_image'] });
  assert.equal(claimed.length, 1); assert.equal(claimed[0].type, 'label_image');
  assert.equal(h.ledger.claim(3, { ids: [] }).length, 0);
});
