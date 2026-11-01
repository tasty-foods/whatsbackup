'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, describePlan, MODELS } = require('../src/ai/auto-router');

const catalog = (...ids) => ids.map(id => ({ id, selectable: true, retired: false, category: 'chat' }));
const current = catalog('gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol');
const choose = input => plan({ models: current, budgetRemaining: 10, ...input });

test('routine image, chat, topics and assignment work starts with Luna', () => {
  for (const task of ['label_image', 'label_chat', 'topics_chat', 'assignment', 'assign', 'arrange', 'unknown-task']) {
    const candidates = choose({ task, needs: { needsVision: task === 'label_image' } });
    assert.equal(candidates[0].model, 'gpt-6-luna', task);
    assert.equal(candidates[0].role, 'routine');
    assert.match(candidates[0].reason, /lower-cost/);
  }
});

test('video, multiple images and scanned pages start with Terra', () => {
  for (const input of [
    { task: 'label_video' },
    { task: 'label_image', record: { kind: 'video' } },
    { task: 'label_image', request: { images: [{}, {}] } },
    { task: 'label_video', request: { images: Array.from({ length: 12 }, () => ({})) } },
    { task: 'label_document', record: { scanned: true } },
    { task: 'label_document', needs: { needsVision: true } },
    { task: 'ocr' },
  ]) {
    const candidates = choose(input);
    assert.equal(candidates[0].model, 'gpt-6.1-terra', JSON.stringify(input));
    assert.equal(candidates[0].role, 'visual');
  }
});

test('final comparisons, difficult documents, complex archive questions and long text start with Sol', () => {
  for (const input of [
    { task: 'finals_set', request: { images: [{}, {}] } },
    { task: 'label_document', record: { pageCount: 30, scanned: true } },
    { task: 'label_document', needs: { difficult: true } },
    { task: 'archive_question', request: { question: 'Compare the invoices across suppliers and explain the differences.' } },
    { task: 'label_chat', request: { user: 'Long source text '.repeat(1100) } },
    { task: 'ask', needs: { estimatedInputTokens: 9000 } },
  ]) {
    const candidates = choose(input);
    assert.equal(candidates[0].model, 'gpt-6.1-sol', JSON.stringify({ task: input.task }));
    assert.equal(candidates[0].role, 'complex');
  }
  assert.equal(choose({ task: 'archive_question', request: { question: 'Find the closed cupboard photo.' } })[0].model, 'gpt-6-luna');
});

test('only models present, selectable and not retired in the account catalogue are considered', () => {
  const models = [
    ...catalog('gpt-6-luna'),
    { id: 'gpt-6.1-terra', selectable: false },
    { id: 'gpt-6.1-sol', selectable: true, retired: true },
    { id: 'gpt-5', selectable: true, shutdown_date: '2000-01-01' },
  ];
  assert.deepEqual(choose({ task: 'finals_set', models }).map(c => c.model), ['gpt-6-luna']);
  assert.deepEqual(choose({ models: [] }), []);
  assert.deepEqual(choose({ models: undefined }), []);
  assert.deepEqual(choose({ models: [{ id: 'gpt-6-luna' }] }), [], 'record selections require explicit selectability');
  assert.equal(choose({ models: ['gpt-6-luna'] })[0].model, 'gpt-6-luna', 'plain IDs are supported for known aliases');
  assert.match(describePlan({ models: [], budgetRemaining: 10 }).reason, /catalogue/);
});

test('Astra, other providers, fine-tuned and unknown or unpriced snapshots never enter Auto', () => {
  const forbidden = [
    'gpt-6-astra', 'gpt-6-astra-pro', 'ft:gpt-6-luna:org:mine:123',
    'gpt-6-luna-2099-01-01', 'gpt-6-sol', 'gpt-6.2-sol', 'gpt-6-luna-premium',
    'openai/gpt-6-luna', 'claude-sonnet-5', 'gemini-3.8-flash', 'gpt-image-1',
  ];
  for (const manualModel of forbidden) {
    const candidates = choose({ models: [...current, ...catalog(...forbidden)], manualModel, task: 'complex' });
    assert.ok(!candidates.some(candidate => forbidden.includes(candidate.model)));
  }
  assert.deepEqual(choose({ models: [{ id: 'gpt-6-luna', selectable: true, provider: 'openrouter' }] }), []);
  assert.deepEqual(choose({ models: catalog(...forbidden), manualModel: 'gpt-6-astra' }), []);
});

test('known older alternatives are used only when their current family is unavailable', () => {
  const all = [...current, ...catalog('gpt-5-mini', 'gpt-5')];
  assert.ok(!choose({ models: all }).some(candidate => /^gpt-5/.test(candidate.model)));
  assert.ok(!choose({ models: all, manualModel: 'gpt-5-mini' }).some(candidate => /^gpt-5/.test(candidate.model)));
  assert.ok(!choose({ models: all, manualModel: 'gpt-5' }).some(candidate => /^gpt-5/.test(candidate.model)));
  assert.equal(choose({ models: catalog('gpt-5-mini', 'gpt-6.1-terra'), task: 'label_image' })[0].model, 'gpt-5-mini');
  assert.equal(choose({ models: catalog('gpt-5-mini', 'gpt-5'), task: 'finals_set' })[0].model, 'gpt-5');
  const retiredSol = { id: 'gpt-6.1-sol', selectable: false, retired: true };
  assert.equal(choose({ models: [...catalog('gpt-5-mini', 'gpt-5'), retiredSol], task: 'finals_set' })[0].model, 'gpt-5');
});

test('near budget exhaustion complex and visual work stay on the available low-cost choice', () => {
  for (const task of ['finals_set', 'label_video', 'label_document']) {
    const candidates = choose({ task, needs: { complex: true }, budgetRemaining: 0.25 });
    assert.deepEqual(candidates.map(candidate => candidate.model), ['gpt-6-luna']);
    assert.match(candidates[0].reason, /Low remaining budget/);
  }
  for (const budgetRemaining of [0, -1, NaN, 'bad', 0.001]) assert.deepEqual(choose({ budgetRemaining }), []);
  assert.deepEqual(choose({ budgetRemaining: 0.25, models: catalog('gpt-6.1-sol', 'gpt-6.1-terra') }), []);
  const summary = describePlan({ models: current, budgetRemaining: 0 });
  assert.equal(summary.budgetMode, 'exhausted');
  assert.match(summary.reason, /monthly budget/);
});

test('large requests require more estimated headroom and can defer rather than guess the cap', () => {
  const small = choose({ task: 'finals_set', budgetRemaining: 0.75 });
  assert.equal(small[0].model, 'gpt-6.1-sol');
  const large = choose({ task: 'finals_set', budgetRemaining: 0.75, request: { estimatedInputTokens: 500000, maxTokens: 10000 } });
  assert.ok(!large.some(candidate => candidate.model === 'gpt-6.1-sol'));
  assert.ok(!large.some(candidate => candidate.model === 'gpt-6.1-terra'));
  assert.match(describePlan({ models: current, request: { estimatedInputTokens: 1000000 }, budgetRemaining: 0.01 }).reason, /headroom/);
});

test('audio and embeddings retain specialised model handling instead of a chat route', () => {
  for (const input of [{ task: 'transcribe_audio' }, { task: 'embedding' }, { task: 'label_image', needs: { needsAudio: true } }, { needs: { needsEmbeddings: true } }]) {
    assert.deepEqual(choose(input), []);
    assert.match(describePlan({ ...input, models: current }).reason, /specialised/);
  }
});

test('planning is local and leaves manual settings, request and account models unchanged', () => {
  const options = { task: 'label_video', models: current, budgetRemaining: 10, manualModel: 'gpt-6-astra', request: { user: 'Synthetic fixture', images: [{ data: 'synthetic' }] }, record: { kind: 'video' } };
  const before = JSON.stringify(options);
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('No routing network calls allowed'); };
  try {
    const first = plan(options), second = plan(options);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(options), before);
    first[0].model = 'tampered';
    assert.equal(plan(options)[0].model, 'gpt-6.1-terra');
    const info = describePlan(options);
    assert.equal(info.primary, 'gpt-6.1-terra');
    assert.equal(info.role, 'visual');
    assert.match(info.notice, /not a provider-enforced dollar limit/);
    assert.match(info.notice, /Do not retry paid failures/);
    assert.equal(options.manualModel, 'gpt-6-astra', 'manual selection remains the caller\'s choice');
    assert.ok(Object.isFrozen(MODELS));
  } finally { global.fetch = originalFetch; }
});
