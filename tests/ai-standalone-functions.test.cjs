'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const meterModule = require('../src/ai/request-meter');

function load(file, deps) {
  const context = { module: { exports: {} }, require: name => {
    assert.ok(name in deps, `Unexpected dependency: ${name}`); return deps[name];
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), context);
  return context.module.exports;
}
function ledger() {
  const rows = [];
  return { rows, startRun(kind, model, provider) { rows.push({ kind, model, provider }); return rows.length; },
    updateRun(id, patch) { Object.assign(rows[id - 1], patch); } };
}
const paid = () => ({ usage: { in: 20, out: 10 }, cost: 0.001, costCap: 0.002 });

function askFixture(work, { empty = false } = {}) {
  const store = ledger(), calls = [], searches = [];
  const found = { messages: empty ? [] : [{ id: 'synthetic-message', chatId: 'synthetic-chat', chatName: 'Fixture supplier', ts: 1700000000000, snippet: 'Delivery is Tuesday.' }], topics: [], media: [], chats: [], counts: { messages: empty ? 0 : 1 } };
  const api = load('src/ai/ask.js', {
    '../messages': {}, '../store': {}, './store': store,
    '../search': { searchAll: async (...args) => { searches.push(args); return found; } },
    './provider': { complete: async (cfg, req) => { calls.push({ cfg, req }); return work(cfg, req); } },
    './request-meter': meterModule,
  });
  return { api, store, calls, searches };
}

test('archive answers keep the supplied manual model, sources and response cost, booking one receipt once', async () => {
  const h = askFixture(async cfg => { const r = { ...paid(), json: { answer: 'Tuesday.', sources: [1] } }; cfg.onUsage(r); return r; });
  const cfg = { provider: 'openai', model: 'fixture-manual-model' }, semanticCfg = { embedModel: 'fixture-embedding' };
  const out = await h.api.ask(cfg, 'When is delivery?', { semanticCfg });
  assert.equal(h.calls[0].cfg.model, cfg.model); assert.equal(h.calls[0].req.schemaName, 'answer');
  assert.equal(h.searches[0][1].semanticCfg, semanticCfg);
  assert.equal(out.answer, 'Tuesday.'); assert.equal(out.sources[0].ref.id, 'synthetic-message'); assert.equal(out.cost, 0.001);
  assert.equal(h.store.rows.length, 1); assert.equal(h.store.rows[0].kind, 'ask');
  assert.equal(h.store.rows[0].cost_usd, 0.001); assert.equal(h.store.rows[0].cost_cap_usd, 0.002); assert.equal(h.store.rows[0].ok, 1);
  assert.equal(cfg.onUsage, undefined);
});

test('a paid archive-answer failure remains recorded and the original actionable error is preserved', async () => {
  const error = Error('OpenAI ran out of output room.');
  const h = askFixture(async cfg => { cfg.onUsage(paid()); throw error; });
  await assert.rejects(h.api.ask({ provider: 'openai', model: 'fixture' }, 'When is delivery?'), e => e === error);
  assert.equal(h.store.rows.length, 1); assert.equal(h.store.rows[0].cost_usd, 0.001);
  assert.equal(h.store.rows[0].failed, 1); assert.ok(h.store.rows[0].finished_at);
});

test('an archive question without matching sources does not call a provider or create a usage row', async () => {
  const h = askFixture(() => { throw Error('Must not call'); }, { empty: true });
  const out = await h.api.ask({ provider: 'openai', model: 'fixture' }, 'Where is the cupboard?');
  assert.equal(out.sources.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.store.rows.length, 0);
});

function statusFixture(work, options = {}) {
  const store = ledger(), calls = [], routeCalls = [], keyCalls = [], events = [];
  let digests = 0;
  const prefs = { statusAiPrompt: 'Write a simple update.', statusAiChatAware: false, aiConsent: true, ...options.prefs };
  const chosen = options.unavailable ? null : { provider: 'openai', model: 'gpt-6-luna', keyRequired: true };
  const api = load('src/status/ai.js', {
    '../settings': { read: () => ({ ...prefs }) },
    '../messages': { recentDigest: () => { digests++; return 'Synthetic recent activity.'; } },
    '../ai': { store, status: () => ({ budget: 10, budgetUsed: options.used || 0 }),
      config: () => { throw Error('The fixed manual configuration must not bypass routing.'); },
      prepareAutoRouting: async () => { events.push('prepared'); },
      pickProvider: needs => { events.push('picked'); routeCalls.push(needs); return chosen; },
      hasKey: provider => { keyCalls.push(provider); return true; } },
    '../ai/provider': { complete: async (cfg, req) => { calls.push({ cfg, req }); return work(cfg, req); } },
    '../ai/request-meter': meterModule,
  });
  return { api, store, calls, routeCalls, keyCalls, events, digests: () => digests };
}
const statusAnswer = async cfg => { const r = { ...paid(), json: { text: 'A useful update.' } }; cfg.onUsage(r); return r; };

test('Status Studio prepares Auto routing and uses its chosen provider, keeping text and provider cost', async () => {
  const h = statusFixture(statusAnswer), out = await h.api.composeStatus();
  assert.deepEqual(h.events, ['prepared', 'picked']); assert.equal(h.routeCalls[0].task, 'status');
  assert.equal(h.keyCalls[0], 'openai'); assert.equal(h.calls[0].cfg.model, 'gpt-6-luna');
  assert.equal(out.text, 'A useful update.'); assert.equal(out.cost, 0.001);
  assert.equal(h.store.rows.length, 1); assert.equal(h.store.rows[0].kind, 'status'); assert.equal(h.store.rows[0].ok, 1);
  assert.equal(h.store.rows[0].cost_usd, 0.001); assert.equal(h.digests(), 0);
});

test('Status Studio refuses exhausted budgets and unavailable providers before making a paid call', async () => {
  const blocked = statusFixture(statusAnswer, { used: 10 });
  await assert.rejects(blocked.api.composeStatus(), /monthly AI budget is used up/);
  assert.equal(blocked.calls.length, 0); assert.equal(blocked.events.length, 0); assert.equal(blocked.store.rows.length, 0);
  const absent = statusFixture(statusAnswer, { unavailable: true });
  await assert.rejects(absent.api.composeStatus(), /No configured AI provider is available/);
  assert.equal(absent.calls.length, 0); assert.equal(absent.store.rows.length, 0);
});

test('status chat context remains opt-in and requires the existing consent', async () => {
  for (const [aware, consent, expected] of [[false, true, 0], [true, false, 0], [true, true, 1]]) {
    const h = statusFixture(statusAnswer, { prefs: { statusAiChatAware: aware, aiConsent: consent } });
    await h.api.composeStatus(); assert.equal(h.digests(), expected);
    assert.equal(h.calls[0].req.user.includes('Synthetic recent activity'), !!expected);
  }
});

test('paid Status Studio failures and unusable answers are recorded without swallowing their errors', async () => {
  const error = Error('Lower reasoning effort or increase output room.');
  const h = statusFixture(async cfg => { cfg.onUsage(paid()); throw error; });
  await assert.rejects(h.api.composeStatus(), e => e === error);
  assert.equal(h.store.rows[0].failed, 1); assert.equal(h.store.rows[0].cost_usd, 0.001);
  const blank = statusFixture(async cfg => { const r = { ...paid(), json: { text: '' } }; cfg.onUsage(r); return r; });
  await assert.rejects(blank.api.composeStatus(), /nothing usable/);
  assert.equal(blank.store.rows[0].failed, 1); assert.equal(blank.store.rows[0].cost_usd, 0.001);
});
