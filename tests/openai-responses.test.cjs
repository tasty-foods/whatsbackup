'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const presets = require('../src/ai/presets');
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const json = value => JSON.parse(JSON.stringify(value));
const reply = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload) });
const response = (text = '{"ok":true}', extra = {}) => ({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 20, output_tokens: 10, output_tokens_details: { reasoning_tokens: 3 } }, ...extra });
function fixture(handler) {
  const calls = [], usage = [];
  const limits = { pace: async () => {}, slower() {}, faster() {}, noteSuccess() {}, noteHeaders() {}, onFreePlan: () => false, readRefusal: () => ({}) };
  const sandbox = { module: { exports: {} }, console, URL, Buffer, AbortController, FormData, Blob, setTimeout, clearTimeout,
    fetch: async (url, options) => { const call = { url, options, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body }; calls.push(call); return handler(call, calls.length); },
    require: name => name === './presets' ? presets : name === './limits' ? limits : require(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/ai/provider.js'), 'utf8'), sandbox);
  const cfg = { provider: 'openai', apiKey: 'fixture-only-key', model: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1', onUsage: result => usage.push(json(result)) };
  return { calls, usage, cfg, api: sandbox.module.exports, request: { system: 'Return grounded data.', user: 'Return ok.', schema, schemaName: 'fixture', maxTokens: 400 } };
}

test('official Responses sends image/text inputs and strict text.format with storage disabled', async () => {
  const f = fixture(() => reply(response()));
  const out = await f.api.complete(f.cfg, { ...f.request, images: [{ mediaType: 'image/png', data: 'fixture-image' }], imageDetail: 'high' });
  assert.equal(f.calls.length, 1); const { url, body, options } = f.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error'); assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'none'); assert.equal(body.max_output_tokens, 400);
  assert.equal(body.input[0].content[0].type, 'input_text'); assert.equal(body.input[0].content[1].type, 'input_image');
  assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,fixture-image'); assert.equal(body.input[0].content[1].detail, 'high');
  assert.deepEqual(body.text.format, { type: 'json_schema', name: 'fixture', strict: true, schema });
  assert.equal(body.response_format, undefined); assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, undefined);
  assert.deepEqual(json(out.json), { ok: true }); assert.equal(out.transport, 'responses'); assert.deepEqual(json(out.usage), { in: 20, out: 10, reasoning: 3 });
  assert.equal(f.usage.length, 1); assert.equal(f.usage[0].usage.out, 10, 'reasoning tokens are already included in output, never added twice');
});

test('GPT-6 Astra and reasoning-only families have bounded reasoning headroom; unknown new IDs retain Responses compatibility', async () => {
  const f = fixture(() => reply(response()));
  await f.api.complete({ ...f.cfg, model: 'gpt-6-astra' }, { ...f.request, maxTokens: 128 });
  assert.equal(f.calls[0].body.reasoning.effort, 'low'); assert.equal(f.calls[0].body.max_output_tokens, 4224);
  await f.api.complete({ ...f.cfg, model: 'o3' }, f.request); assert.equal(f.calls[1].body.reasoning.effort, 'low'); assert.ok(f.calls[1].body.max_output_tokens > 400);
  await f.api.complete({ ...f.cfg, model: 'gpt-future-fixture-model' }, f.request);
  assert.equal(f.calls[2].url, 'https://api.openai.com/v1/responses'); assert.equal(f.calls[2].body.reasoning, undefined);
  await f.api.complete({ ...f.cfg, model: 'gpt-6.1-sol', openaiReasoningEffort: 'max' }, f.request);
  assert.equal(f.calls[3].body.reasoning.effort, 'max'); assert.ok(f.calls[3].body.max_output_tokens <= 128000);
});

test('older Chat models keep max_tokens while the selected fine-tuned model ID is preserved', async () => {
  const f = fixture(() => reply({ choices: [{ finish_reason: 'stop', message: { content: 'READY' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
  const model = 'ft:gpt-3.5-turbo:fixture:label:123';
  const out = await f.api.complete({ ...f.cfg, model }, { system: 'One word.', user: 'Say READY.', maxTokens: 128 });
  assert.equal(out.transport, 'chat'); assert.equal(f.calls[0].body.model, model); assert.equal(f.calls[0].body.max_tokens, 128);
  assert.equal(f.calls[0].body.max_completion_tokens, undefined); assert.equal(f.calls[0].body.store, false); assert.equal(f.calls[0].body.reasoning_effort, undefined);
});

test('auto learns a definite unsupported endpoint once, with compatible legacy token-field negotiation', async () => {
  const f = fixture(call => {
    if (call.url.endsWith('/responses')) return reply({ error: { message: 'This model is not supported in the Responses API. Use Chat Completions.' } }, 400);
    if (call.body.max_completion_tokens) return reply({ error: { message: "Unsupported parameter: 'max_completion_tokens'. Use max_tokens." } }, 400);
    return reply({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
  });
  const cfg = { ...f.cfg, model: 'legacy-fixture-model' };
  assert.equal((await f.api.complete(cfg, f.request)).transport, 'chat'); assert.equal(f.calls.length, 3); assert.equal(f.usage.length, 1);
  await f.api.complete(cfg, f.request); assert.equal(f.calls.length, 4); assert.equal(f.calls[3].body.max_tokens, 400);
});

test('an explicit Responses selection does not silently switch to Chat', async () => {
  const f = fixture(() => reply({ error: { message: 'This model is not supported in the Responses API. Use Chat Completions.' } }, 400));
  await assert.rejects(f.api.complete({ ...f.cfg, openaiApiMode: 'responses' }, f.request)); assert.equal(f.calls.length, 1); assert.equal(f.usage.length, 0);
});

test('unsupported structured-output modes fall back only on rejected requests and remember a working JSON shape', async () => {
  const f = fixture(call => call.body.text?.format ? reply({ error: { message: 'Unsupported parameter: text.format is not supported for this model.' } }, 400) : reply(response()));
  const out = await f.api.complete(f.cfg, f.request); assert.equal(out.jsonMode, 'text'); assert.equal(f.calls.length, 3); assert.equal(f.usage.length, 1);
  assert.match(f.calls[2].body.instructions, /Reply with JSON only/);
  await f.api.complete(f.cfg, f.request); assert.equal(f.calls.length, 4); assert.equal(f.calls[3].body.text, undefined);
});

test('invalid JSON schemas are surfaced rather than silently weakening the output contract', async () => {
  const f = fixture(() => reply({ error: { message: 'Invalid schema for text.format: additionalProperties is required.' } }, 400));
  await assert.rejects(f.api.complete(f.cfg, f.request)); assert.equal(f.calls.length, 1); assert.equal(f.usage.length, 0);
});

test('authentication, billing, missing models, quota and server errors never trigger endpoint retries', async () => {
  for (const status of [401, 402, 403, 404, 429, 503]) {
    const f = fixture(() => reply({ error: { message: 'Request rejected for this model.', type: 'fixture_error' } }, status));
    await assert.rejects(f.api.complete(f.cfg, f.request)); assert.equal(f.calls.length, 1, String(status)); assert.equal(f.usage.length, 0);
  }
});

test('incomplete paid reasoning is booked once and reported as length, never accepted or retried', async () => {
  const f = fixture(() => reply(response('', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning' }], usage: { input_tokens: 50, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 1000 } } })));
  await assert.rejects(f.api.complete(f.cfg, f.request), error => error.kind === 'length' && error.retryable === false && error.usageCharged === true && error.paidResponse === true);
  assert.equal(f.calls.length, 1); assert.equal(f.usage.length, 1); assert.equal(f.usage[0].usage.out, 1000);
  assert.equal(f.usage[0].cost, presets.costOf('openai', f.cfg.model, 50, 1000));
});

test('refusals, reasoning-only output, and invalid JSON cannot become successful indexing results', async () => {
  const cases = [
    ['refusal', response('', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help.' }, { type: 'output_text', text: '{"ok":true}' }] }] })],
    ['schema', response('', { output: [{ type: 'reasoning', summary: [] }] })],
    ['schema', response('not json')],
  ];
  for (const [kind, payload] of cases) {
    const f = fixture(() => reply(payload));
    await assert.rejects(f.api.complete(f.cfg, f.request), error => error.kind === kind && error.retryable === false && error.usageCharged === true);
    assert.equal(f.calls.length, 1); assert.equal(f.usage.length, 1);
  }
});

test('Chat Completions length/refusal results are likewise charged and rejected', async () => {
  for (const [finish_reason, message, kind] of [['length', { content: '{"ok":true}' }, 'length'], ['stop', { refusal: 'No.', content: '' }, 'refusal']]) {
    const f = fixture(() => reply({ choices: [{ finish_reason, message }], usage: { prompt_tokens: 10, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 20 } } }));
    await assert.rejects(f.api.complete({ ...f.cfg, openaiApiMode: 'chat' }, f.request), error => error.kind === kind && error.usageCharged === true);
    assert.equal(f.usage[0].usage.out, 40); assert.equal(f.usage[0].usage.reasoning, 20); assert.equal(f.calls.length, 1);
  }
});

test('API key echoes are redacted before error truncation and never appear in serialized error details', async () => {
  const key = 'fixture-not-a-real-key-' + 'secret'.repeat(25);
  const f = fixture(() => reply({ error: { message: 'x'.repeat(240) + key + ' unsupported setting' } }, 400));
  await assert.rejects(f.api.complete({ ...f.cfg, apiKey: key }, f.request), error => {
    const displayed = error.message + JSON.stringify(error) + String(error.apiDetail || '');
    assert.equal(displayed.includes(key), false); assert.equal(displayed.includes(key.slice(0, 35)), false); assert.equal(Object.keys(error).includes('apiDetail'), false);
    return true;
  });
});

test('official API keys are not sent to arbitrary URLs or forwarded by redirects', async () => {
  const f = fixture(() => reply({}, 302));
  for (const baseUrl of ['https://api.openai.com.evil.invalid/v1', 'http://api.openai.com/v1', 'https://api.openai.com/v1?key=unsafe', 'https://username:password@api.openai.com/v1']) {
    await assert.rejects(f.api.complete({ ...f.cfg, baseUrl }, f.request));
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.api.complete(f.cfg, f.request), error => error.status === 302);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.redirect, 'error');
});

test('compatible cloud providers and local providers retain their Chat Completions request dialect', async () => {
  for (const cfg of [
    { provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    { provider: 'nvidia', model: 'fixture/nemotron', baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { provider: 'ollama', model: 'fixture-local', baseUrl: 'http://127.0.0.1:11434/v1' },
  ]) {
    const f = fixture(() => reply({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
    const out = await f.api.complete({ ...f.cfg, ...cfg }, f.request);
    assert.deepEqual(json(out.json), { ok: true }); assert.ok(f.calls[0].url.endsWith('/chat/completions')); assert.equal(f.calls[0].body.max_tokens, 400);
    assert.equal(f.calls[0].body.response_format.type, cfg.provider === 'ollama' ? 'json_object' : 'json_schema');
    assert.equal(f.calls[0].body.max_output_tokens, undefined); assert.equal(f.calls[0].body.input, undefined);
    if (cfg.provider === 'ollama') assert.equal(f.calls[0].options.headers.authorization, undefined);
  }
});

test('the synthetic capability probe uses meaningful output room and does not mark a reasoning-setting error as blindness', async () => {
  const observed = [], fake = { AiError: Error, complete: async (_cfg, req) => {
    observed.push(req);
    if (observed.length === 1) return { text: 'READY', usage: { in: 1, out: 2 }, transport: 'responses', ms: 1 };
    if (observed.length === 2) return { json: { ok: true }, usage: { in: 1, out: 3 } };
    throw Object.assign(Error('reasoning effort none is not supported'), { kind: 'error', status: 400 });
  } };
  const sandbox = { module: { exports: {} }, require: () => fake };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/ai/probe.js'), 'utf8'), sandbox);
  const out = await sandbox.module.exports.probe({ provider: 'openai', model: 'gpt-6-astra' });
  assert.equal(observed.length, 3); assert.ok(observed[0].maxTokens >= 128); assert.equal(observed[2].images.length, 1);
  assert.equal(out.transport, 'responses'); assert.equal(out.visionVerdict, 'unknown'); assert.equal(out.reachable.ok, true);
});

test('unknown model prices remain unknown while the budget cap exceeds verified standard Astra rates', () => {
  assert.equal(presets.costOf('openai', 'unlisted-fixture-model', 1000, 1000), null);
  assert.ok(presets.capCostOf('openai', 'unlisted-fixture-model', 1000, 1000) >= presets.costOf('openai', 'gpt-6-astra', 1000, 1000));
  assert.ok(Math.abs(presets.costOf('openai', 'gpt-6-luna', 1000, 1000) - 0.0006) < 1e-12);
  assert.equal(presets.costOf('openai', 'gpt-6-luna', 1e6, 1e6), 0.95);
  const longCost = presets.costOf('openai', 'gpt-6-astra', 300000, 1000);
  assert.equal(longCost, 6.075);
  assert.ok(presets.capCostOf('openai', 'gpt-6-astra', 300000, 1000) >= longCost);
});
