const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const limits = require('../src/ai/limits');
const { SEC, MIN, HOUR } = limits;

// Each test gets its own instance with no file, so nothing reaches disk.
const fresh = () => limits.create({ file: null });
const refused = (status, body, headers = {}, kind) => {
  const e = new Error('refused');
  e.status = status;
  e.kind = kind || (status === 429 ? 'rate' : status === 401 ? 'auth' : status === 404 ? 'model' : 'error');
  e.refusal = limits.readRefusal(status, body, headers);
  return e;
};
const near = (actual, expected, slack = 1500) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} not within ${slack} of ${expected}`);
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

test('durations in the shapes providers write them', () => {
  assert.equal(limits.parseDuration('41s'), 41 * SEC);
  assert.equal(limits.parseDuration('41.2s'), 41200);
  assert.equal(limits.parseDuration('1m26.4s'), 86400);
  assert.equal(limits.parseDuration('2h3m'), 2 * HOUR + 3 * MIN);
  assert.equal(limits.parseDuration('500ms'), 500);
  assert.equal(limits.parseDuration('30'), 30 * SEC);
  assert.equal(limits.parseDuration('soon'), 0);
});

test("Gemini's daily allowance rests that model until midnight Pacific, not 41 seconds", () => {
  const L = fresh();
  const body = '[{"error":{"code":429,"message":"You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 250, model: gemini-2.5-flash. Please retry in 41.2s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"41s"}]}}]';
  const r = quiet(() => L.restAfter(refused(429, body), { provider: 'gemini', model: 'gemini-2.5-flash' }));
  assert.equal(r.why, "today's free allowance is used up");
  assert.equal(r.wide, false);
  assert.ok(r.ms >= limits.msToPacificMidnight() , 'rests at least until the reset');
  assert.ok(L.restingUntil('gemini', 'gemini-2.5-flash') > Date.now());
  assert.equal(L.restingUntil('gemini', 'gemini-3.8-flash'), 0, 'another Gemini model keeps its own allowance');
});

test("Gemini's per-minute limit costs the time it asks for, not 45 minutes", () => {
  const L = fresh();
  const body = '{"error":{"code":429,"message":"Quota exceeded for metric: ...requests_per_model_per_minute, limit: 10","details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"retryDelay":"17s"}]}}';
  const r = quiet(() => L.restAfter(refused(429, body), { provider: 'gemini', model: 'gemini-2.5-flash' }));
  assert.equal(r.why, 'too many requests this minute');
  near(r.ms, 18 * SEC);
});

test('a model with no free allowance at all rests half a day', () => {
  const L = fresh();
  const body = '{"error":{"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro"}}';
  const r = quiet(() => L.restAfter(refused(429, body), { provider: 'gemini', model: 'gemini-2.5-pro' }));
  assert.equal(r.ms, 12 * HOUR);
  assert.match(r.why, /no free allowance/);
});

test("Groq's rolling daily limit is trusted to the second it names", () => {
  const L = fresh();
  const body = '{"error":{"message":"Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26.4s.","type":"requests","code":"rate_limit_exceeded"}}';
  const r = quiet(() => L.restAfter(refused(429, body), { provider: 'groq', model: 'qwen/qwen3.8-27b' }));
  assert.equal(r.why, "today's free allowance is used up");
  near(r.ms, 87400);
  assert.equal(r.wide, false);
});

test('a Retry-After header beats guessing', () => {
  const L = fresh();
  const body = '{"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 6000, Used 5800, Requested 900."}}';
  const r = quiet(() => L.restAfter(refused(429, body, { 'retry-after': '8' }), { provider: 'groq', model: 'llama-3.3-70b-versatile' }));
  near(r.ms, 9 * SEC);
  assert.equal(r.why, 'too many requests this minute');
});

test("OpenRouter's free daily allowance is the account's, so the whole provider rests until its reset", () => {
  const L = fresh();
  const resetAt = Date.now() + 5 * HOUR;
  const body = '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}';
  const r = quiet(() => L.restAfter(refused(429, body, { 'x-ratelimit-reset': String(resetAt) }), { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' }));
  assert.equal(r.wide, true);
  near(L.restingUntil('openrouter', 'google/gemma-4-26b-a4b-it:free'), resetAt, 3000);
});

test('no credit and a refused key rest the whole provider and say what to do', () => {
  const L = fresh();
  const credit = quiet(() => L.restAfter(refused(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { provider: 'anthropic', model: 'claude-haiku-4-5' }));
  assert.equal(credit.wide, true);
  assert.match(credit.why, /no credit/);
  const L2 = fresh();
  const bad = quiet(() => L2.restAfter(refused(400, '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]', {}, 'auth'), { provider: 'gemini', model: 'gemini-2.5-flash' }));
  assert.equal(bad.wide, true);
  assert.match(bad.why, /key was refused/);
  assert.ok(L2.restingUntil('gemini', 'gemini-3.8-flash') > Date.now(), 'every model of that provider waits for a new key');
});

test('a missing model rests only that model; an item-level failure rests nothing', () => {
  const L = fresh();
  const r = quiet(() => L.restAfter(refused(404, '{"error":{"message":"models/gemini-9 is not found"}}'), { provider: 'gemini', model: 'gemini-9' }));
  assert.equal(r.ms, 24 * HOUR);
  assert.equal(L.restingUntil('gemini', 'gemini-2.5-flash'), 0);
  const schema = new Error('not JSON'); schema.kind = 'schema';
  assert.equal(L.restAfter(schema, { provider: 'gemini', model: 'gemini-2.5-flash' }), null);
});

test('unexplained refusals back off two, then four minutes, and a success resets that', () => {
  const L = fresh();
  const cfg = { provider: 'groq', model: 'x' };
  const a = quiet(() => L.restAfter(refused(429, 'slow down'), cfg));
  const b = quiet(() => L.restAfter(refused(429, 'slow down'), cfg));
  assert.equal(a.ms, 2 * MIN);
  assert.equal(b.ms, 4 * MIN);
  L.noteSuccess('groq', 'x'); L.clear('groq', 'x');
  const c = quiet(() => L.restAfter(refused(429, 'slow down'), cfg));
  assert.equal(c.ms, 2 * MIN);
});

test('rests survive a restart, and expired ones are not brought back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-limits-'));
  const file = path.join(dir, 'ai-rest.json');
  try {
    const A = limits.create({ file });
    quiet(() => { A.rest('gemini', 'gemini-2.5-flash', HOUR, 'used up'); A.rest('groq', null, 5, 'gone in a moment'); });
    const B = limits.create({ file });
    assert.ok(B.restingUntil('gemini', 'gemini-2.5-flash') > Date.now() + 59 * MIN);
    assert.equal(B.restOf('gemini', 'gemini-2.5-flash').why, 'used up');
    return new Promise((done) => setTimeout(() => { assert.equal(limits.create({ file }).restingUntil('groq', 'anything'), 0); done(); }, 20));
  } finally { setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 50); }
});

test('a rest is never shortened by a later, shorter one', () => {
  const L = fresh();
  quiet(() => { L.rest('gemini', 'm', HOUR, 'daily'); L.rest('gemini', 'm', MIN, 'minute'); });
  assert.equal(L.restOf('gemini', 'm').why, 'daily');
});

test('pacing spaces requests, widens on "too many", and narrows back', async () => {
  const L = fresh();
  const t0 = Date.now(), at = [];
  await Promise.all([1, 2, 3].map(async () => { await L.pace('p|m', 60); at.push(Date.now() - t0); }));
  at.sort((x, y) => x - y);
  assert.ok(at[1] - at[0] >= 50 && at[2] - at[1] >= 50, 'about 60 ms apart: ' + at.join(','));
  L.slower('p|m');
  assert.equal(L.intervalOf('p|m'), 96);
  for (let i = 0; i < 40; i++) L.faster('p|m');
  assert.equal(L.intervalOf('p|m'), 60, 'never below the base');
});

test('midnight Pacific is always within the next day', () => {
  const ms = limits.msToPacificMidnight();
  assert.ok(ms > 0 && ms <= 24 * HOUR);
});

test('a Gemini model that refuses a thinking level is asked again one step up, and that is remembered', async () => {
  const provider = require('../src/ai/provider');
  const bodies = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (body.reasoning_effort === 'minimal') {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => '[{"error":{"code":400,"message":"Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.","status":"INVALID_ARGUMENT"}}]' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) };
  };
  try {
    const cfg = { provider: 'gemini', model: 'gemini-test-3-flash'.replace('test-3', '3.9'), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k' };
    const r = await provider.complete(cfg, { system: 's', user: 'u', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, maxTokens: 400 });
    assert.deepEqual(r.json, { ok: true });
    assert.equal(bodies[0].reasoning_effort, 'minimal');
    assert.equal(bodies[1].reasoning_effort, 'low');
    assert.equal(bodies[1].max_tokens, 400 + 1536, 'room for the thinking on top of the answer');
    bodies.length = 0;
    await provider.complete(cfg, { system: 's', user: 'u', maxTokens: 400 });
    assert.equal(bodies.length, 1, 'the next request starts at the step that worked');
    assert.equal(bodies[0].reasoning_effort, 'low');
  } finally { global.fetch = realFetch; }
});

test('a free plan is proven by the provider itself, lapses after a week, and a new key forgets it', () => {
  const L = fresh();
  assert.equal(L.onFreePlan('gemini'), false, 'unproven: counted at paid rates');
  quiet(() => L.restAfter(refused(429, '{"error":{"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'), { provider: 'gemini', model: 'gemini-2.5-flash' }));
  assert.equal(L.onFreePlan('gemini'), true, 'a FreeTier quota proves it');
  L.noteKey('gemini', 'old'); L.noteKey('gemini', 'new');
  assert.equal(L.onFreePlan('gemini'), false, 'a different key is unproven again');
  L.noteHeaders('groq', { 'x-ratelimit-limit-requests': '1000' });
  assert.equal(L.onFreePlan('groq'), true, "Groq's free daily limit proves it");
  const P = fresh();
  P.noteHeaders('groq', { 'x-ratelimit-limit-requests': '500000' });
  assert.equal(P.onFreePlan('groq'), false, 'a developer-plan limit does not');
});

test("OpenRouter's :free models cost nothing, even against the cap", () => {
  const presets = require('../src/ai/presets');
  assert.equal(presets.capCostOf('openrouter', 'google/gemma-4-31b-it:free', 1e6, 1e6), 0);
  assert.equal(presets.costOf('openrouter', 'google/gemma-4-31b-it:free', 1e6, 1e6), 0);
  assert.ok(presets.capCostOf('openrouter', 'some/paid-model', 1e6, 0) > 0, 'an unknown paid model is still counted');
  assert.equal(presets.costOf('gemini', 'gemini-3.5-flash-lite', 1e6, 0), 0.30, 'current Gemini prices are known');
});
