// The AI chain under free-tier pressure: providers that run out wait instead
// of failing the queue, the next model of the same provider takes over, the
// items failed by the old behaviour come back, and a new key starts clean.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { AiError } = require('../src/ai/provider');
const limitsLib = require('../src/ai/limits');

const load = (file, deps) => {
  const context = { module: { exports: {} }, require: (name) => { if (!(name in deps)) throw new Error('Unexpected dependency: ' + name); return deps[name]; }, console, setTimeout, clearTimeout, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ai', file), 'utf8'), context);
  return context.module.exports;
};
const quiet = (t) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; t.after(() => { console.warn = w; console.log = l; }); };

function harness(t, work, { ids = ['a', 'b', 'c'], chain = [] } = {}) {
  quiet(t);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const ledger = load('store.js', { crypto: require('node:crypto'), '../messages': { handle: () => db } });
  const limits = limitsLib.create({ file: null });
  const prefs = { aiEnabled: true, aiConsent: true, aiProvider: 'test', aiModel: 'first', aiChain: chain, aiChainEnabled: chain.length > 0, aiAnalyseImages: true, aiAnalyseVideos: true, aiAnalyseDocuments: true, aiAnalyseChats: true, aiMonthlyBudget: 0, aiMode: 'manual', aiPaused: false, aiResumeOnLaunch: true, performanceMode: 'quiet' };
  const records = ids.map((id) => ({ id, kind: 'image' }));
  const calls = [];
  const deps = {
    '../settings': { read: () => ({ ...prefs }), write: (patch) => Object.assign(prefs, patch) },
    '../store': { get: (id) => records.find((r) => r.id === id), listRecords: () => records },
    '../messages': { chatsWithText: () => new Set(), listChats: () => [] }, '../config': {}, './store': ledger,
    './label': { eachCandidate: (fn) => records.forEach((r) => fn(r, 'image', null)), currentLabel: () => false, census: () => ({}), skipReason: () => null, kindOf: () => 'image',
      labelImage: async (cfg, rec) => { calls.push(cfg.provider + ':' + cfg.model + ':' + rec.id); return work(cfg, rec, calls.length); } },
    './arrange': {}, './probe': {}, './provider': { AiError },
    './presets': { PRESETS: {
      test: { keyRequired: false, defaultModel: 'first', fallbacks: { vision: ['second'] } },
      spare: { keyRequired: false, defaultModel: 'spare-model' },
      anthropic: { keyRequired: true, defaultModel: 'claude-haiku-4-5' },
    } },
    '../content/documents': { status: () => ({ running: false }) },
    './limits': limits,
  };
  return { runner: load('index.js', deps), prefs, calls, ledger, limits, db };
}
const idle = async (runner, ms = 8000) => { const end = Date.now() + ms; while (runner.status().running) { if (Date.now() > end) throw new Error('Runner did not finish'); await new Promise((r) => setTimeout(r, 10)); } };
const rate = (scope = 'minute') => { const e = new AiError('slow down', { kind: 'rate', status: 429, retryable: true }); e.refusal = limitsLib.readRefusal(429, scope === 'day' ? 'requests per day (RPD)' : 'requests per minute (RPM)', {}); return e; };
const states = (db) => Object.fromEntries(db.prepare('SELECT state, COUNT(*) n FROM ai_jobs GROUP BY state').all().map((r) => [r.state, r.n]));

test('when every provider is resting the queue waits, nothing is failed, and it resumes on time', async (t) => {
  const h = harness(t, async () => ({}));
  h.limits.rest('test', null, 300, 'out of quota');                 // the only provider, resting for 0.3 s
  const started = Date.now();
  await h.runner.run({ indexOnly: true });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.runner.status().phase, 'waiting');
  assert.match(h.runner.status().message, /Waiting for free AI quota — test is back around/);
  assert.equal(h.calls.length, 0, 'nothing is asked while resting');
  await idle(h.runner);
  assert.ok(Date.now() - started >= 280, 'it waited for the rest to end');
  assert.equal(h.calls.length, 3, 'then every item was done');
  assert.deepEqual(states(h.db), { done: 3 });
});

test('a refusal mid-run rests that model and the next model of the same provider carries on', async (t) => {
  const h = harness(t, async (cfg) => { if (cfg.model === 'first') throw rate('day'); return {}; });
  await h.runner.run({ indexOnly: true });
  await idle(h.runner);
  assert.deepEqual(h.calls, ['test:first:a', 'test:second:a', 'test:second:b', 'test:second:c']);
  assert.deepEqual(states(h.db), { done: 3 });
  assert.ok(h.limits.restingUntil('test', 'first') > Date.now(), 'the spent model rests');
  assert.equal(h.limits.restingUntil('test', 'second'), 0, 'its sibling does not');
});

test('the chain moves on to the next provider when a whole provider is out', async (t) => {
  const h = harness(t, async (cfg) => { if (cfg.provider === 'test') { const e = new AiError('no credit', { kind: 'billing', status: 402 }); e.refusal = limitsLib.readRefusal(402, 'insufficient credits', {}); throw e; } return {}; }, { chain: ['spare'] });
  await h.runner.run({ indexOnly: true });
  await idle(h.runner);
  assert.deepEqual(h.calls, ['test:first:a', 'spare:spare-model:a', 'spare:spare-model:b', 'spare:spare-model:c'], 'no credit rests every model of that provider at once');
  assert.deepEqual(states(h.db), { done: 3 });
});

test('a pause during a wait stops cleanly and keeps the queue', async (t) => {
  const h = harness(t, async () => ({}));
  h.limits.rest('test', null, 60000, 'out of quota');
  await h.runner.run({ indexOnly: true });
  await new Promise((r) => setTimeout(r, 50));
  h.runner.cancel();
  await idle(h.runner);
  assert.equal(h.calls.length, 0);
  assert.equal(h.ledger.jobCounts().queued, 3, 'all three are still queued');
});

test('items the old runner failed for "no provider" are put back once, other failures are left alone', async (t) => {
  const h = harness(t, async () => ({}));
  h.ledger.enqueue('label_image', 'a'); h.ledger.enqueue('label_image', 'b'); h.ledger.enqueue('label_image', 'c');
  const ids = h.db.prepare('SELECT id, ref_id FROM ai_jobs ORDER BY id').all();
  h.db.prepare("UPDATE ai_jobs SET state = 'error', attempts = 3, error = 'No provider is available — every one is out of quota or missing a key.' WHERE id = ?").run(ids[0].id);
  h.db.prepare("UPDATE ai_jobs SET state = 'error', attempts = 3, error = 'The file is corrupt.' WHERE id = ?").run(ids[1].id);
  assert.equal(h.runner.requeueStranded(), 1);
  assert.equal(h.db.prepare('SELECT state FROM ai_jobs WHERE id = ?').get(ids[0].id).state, 'queued');
  assert.equal(h.db.prepare('SELECT attempts FROM ai_jobs WHERE id = ?').get(ids[0].id).attempts, 0);
  assert.equal(h.db.prepare('SELECT state FROM ai_jobs WHERE id = ?').get(ids[1].id).state, 'error', 'a real failure stays a failure');
  assert.equal(h.runner.requeueStranded(), 0, 'once per start');
});

test('a new key clears its provider’s rests; the same key handed over again keeps them', async (t) => {
  const h = harness(t, async () => ({}));
  h.runner.setKeys({ test: 'key-one' });
  h.limits.rest('test', null, 60000, 'the key was refused');
  h.runner.setKeys({ test: 'key-one' });
  assert.ok(h.limits.restingUntil('test', 'first') > Date.now(), 'same key: still resting');
  h.runner.setKeys({ test: 'key-two' });
  assert.equal(h.limits.restingUntil('test', 'first'), 0, 'new key: clean');
});

test('a model name that belongs to another provider is not sent to this one', async (t) => {
  const h = harness(t, async () => ({}));
  h.prefs.aiChainModels = { anthropic: 'google/gemma-4-31b-it:free' };
  assert.equal(h.runner.configFor('anthropic').model, 'claude-haiku-4-5', 'the stray OpenRouter name is ignored');
  h.prefs.aiChainModels = { anthropic: 'claude-sonnet-5' };
  assert.equal(h.runner.configFor('anthropic').model, 'claude-sonnet-5', 'a real Anthropic model is kept');
});

// The connection test decides whether photos may go to a model at all, so it
// must not call a model blind because its quota ran out on the image request.
test('the connection test calls a model blind only when it refuses the image itself', async () => {
  const run = async (third) => {
    let n = 0;
    const probe = load('probe.js', { './provider': { AiError, complete: async () => {
      n++;
      if (n === 1) return { text: 'READY', usage: {} };
      if (n === 2) return { json: { ok: true }, usage: {} };
      return third();
    } } }).probe;
    return probe({ provider: 'gemini', model: 'gemini-2.5-flash' });
  };
  const quota = await run(() => { const e = new AiError("today's free allowance is used up", { kind: 'rate', status: 429 }); throw e; });
  assert.equal(quota.visionVerdict, 'unknown', 'out of quota says nothing about eyes');
  assert.ok(quota.visionError, 'and the refusal is handed back so the model can rest');
  const refused = await run(() => { throw new AiError('image input not supported', { kind: 'error', status: 400 }); });
  assert.equal(refused.visionVerdict, 'no');
  const red = await run(() => ({ json: { colour: 'red' }, usage: {} }));
  assert.equal(red.visionVerdict, 'yes');
  const wrong = await run(() => ({ json: { colour: 'blue' }, usage: {} }));
  assert.equal(wrong.visionVerdict, 'no');
});

test('a model that is too slow rests a few minutes and the next model takes the item', async (t) => {
  const h = harness(t, async (cfg) => { if (cfg.model === 'first') throw new AiError('took too long to answer', { kind: 'timeout', retryable: true }); return {}; }, { ids: ['a', 'b'] });
  await h.runner.run({ indexOnly: true });
  await idle(h.runner);
  assert.deepEqual(h.calls, ['test:first:a', 'test:second:a', 'test:second:b'], 'one timeout, then the spare for everything');
  assert.deepEqual(states(h.db), { done: 2 });
  const rest = h.limits.restOf('test', 'first');
  assert.equal(rest.why, 'too slow to answer');
  assert.ok(rest.until - Date.now() <= 5 * 60 * 1000 + 1000, 'only a few minutes');
});
