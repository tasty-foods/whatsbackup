'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createCatalog, classifyModel, MODELS_URL, CACHE_TTL_MS, MAX_JSON_BYTES,
} = require('../src/ai/models');

const key = 'sk-test-fake-model-catalogue';
const options = (extra = {}) => ({ provider: 'openai', apiKey: key, ...extra });
const response = (data, init) => new Response(JSON.stringify(data), init);
const list = (...ids) => ({ object: 'list', data: ids.map(id => ({ id, object: 'model', created: 42, owned_by: 'openai' })) });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('identifier categories separate chat from specialised models without capability claims', () => {
  const examples = [
    ['gpt-6-astra', 'chat', true], ['gpt-6-luna', 'chat', true],
    ['o4-mini', 'chat', true], ['chatgpt-4o-latest', 'chat', true],
    ['text-embedding-3-large', 'embeddings', false], ['text-search-ada-doc-001', 'embeddings', false],
    ['whisper-1', 'transcription', false], ['gpt-4o-mini-transcribe', 'transcription', false],
    ['gpt-4o-transcribe-diarize', 'transcription', false],
    ['gpt-image-1', 'image-generation', false], ['dall-e-3', 'image-generation', false],
    ['gpt-6-image-preview', 'image-generation', false],
    ['gpt-realtime-mini', 'audio/realtime', false], ['tts-1-hd', 'audio/realtime', false],
    ['gpt-audio', 'audio/realtime', false], ['gpt-4o-audio-preview', 'audio/realtime', false],
    ['omni-moderation-latest', 'moderation', false], ['sora-2', 'video', false],
    ['babbage-002', 'other', false], ['text-davinci-003', 'other', false],
    ['gpt-4o-search-preview', 'other', false],
  ];
  for (const [id, category, selectable] of examples) {
    const record = classifyModel(id);
    assert.equal(record.category, category, id);
    assert.equal(record.selectable, selectable, id);
    assert.ok(record.reason.length > 20, id);
    assert.equal(record.vision, undefined, 'list does not prove image understanding');
    assert.equal(record.price, undefined, 'list does not return pricing');
    assert.equal(record.classification, 'inferred');
  }
});

test('unknown and fine-tuned models allow manual compatibility testing', () => {
  for (const id of ['new-family-v42', 'ft:gpt-4o-mini-2024-07-18:my-org:archive:abc123', 'ft:future-chat:my-org:mine:123']) {
    const record = classifyModel(id);
    assert.equal(record.selectable, true);
    assert.equal(record.classification, 'unknown');
    assert.match(record.reason, /test.*manually/i);
  }
  assert.equal(classifyModel('ft:gpt-image-1:org:custom:123').selectable, false);
  assert.equal(classifyModel('ft:whisper-1:org:custom:123').category, 'transcription');
  assert.equal(classifyModel('ft:gpt-4o-mini:org:suffix:123').fineTuned, true);
  for (const invalid of ['', null, {}, { id: 'bad id' }, { id: 'bad\nkey' }, { id: 'x'.repeat(1025) }]) {
    assert.equal(classifyModel(invalid), null);
  }
});

test('catalogue returns the full live list, metadata and only an official authenticated request', async () => {
  const calls = [];
  const records = list(...Array.from({ length: 150 }, (_, i) => `future-model-${i}`));
  records.data.push({ id: 'gpt-6-sol', created: 0, owned_by: 'owner', shutdown_date: '2027-01-03', arbitrary: key });
  const C = createCatalog({ now: () => 100, fetchImpl: async (...args) => { calls.push(args); return response(records); } });
  const result = await C.getModels(options({ baseUrl: 'https://api.openai.com/v1/' }));
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 151, 'no preset shortlist filters the catalogue');
  assert.equal(result.fetchedAt, 100);
  assert.equal(result.expiresAt, 100 + CACHE_TTL_MS);
  assert.equal(result.cached, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], MODELS_URL);
  assert.deepEqual(calls[0][1].headers, { Authorization: `Bearer ${key}`, Accept: 'application/json' });
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].redirect, 'error');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  const model = result.models.find(m => m.id === 'gpt-6-sol');
  assert.equal(model.created, 0);
  assert.equal(model.owned_by, 'owner');
  assert.equal(model.shutdown_date, '2027-01-03');
  assert.equal(model.arbitrary, undefined);
  assert.ok(!JSON.stringify(result).includes(key));
});

test('unsupported providers, missing keys and custom URLs never receive an HTTP request', async () => {
  let requests = 0;
  const C = createCatalog({ fetchImpl: async () => { requests++; throw new Error('must not call'); } });
  for (const provider of ['custom', 'gemini', 'OpenAI', undefined]) {
    assert.equal((await C.getModels(options({ provider }))).kind, 'unsupported');
  }
  for (const apiKey of ['', undefined, '  ', 'bad\nsecret', 'two words', 'x'.repeat(4097)]) {
    assert.equal((await C.getModels(options({ apiKey }))).kind, 'key');
  }
  for (const baseUrl of [
    'http://api.openai.com/v1', 'https://evil.test/v1', 'https://api.openai.com.evil.test/v1',
    'https://api.openai.com@evil.test/v1', 'https://evil.test@api.openai.com/v1',
    'https://api.openai.com/v1?token=x', 'https://api.openai.com/v1#x',
    'https://api.openai.com/v1/models', 'https://api.openai.com:444/v1', {},
  ]) {
    const result = await C.getModels(options({ baseUrl }));
    assert.equal(result.kind, 'endpoint', String(baseUrl));
    assert.ok(!JSON.stringify(result).includes(key));
  }
  assert.equal(requests, 0);
});

test('cache lasts 15 minutes, force refreshes, and callers cannot mutate cached records', async () => {
  let at = 1000, requests = 0;
  const C = createCatalog({ now: () => at, fetchImpl: async () => response(list(`gpt-${++requests}`)) });
  const first = await C.getModels(options());
  first.models[0].id = 'tampered';
  first.models.push({ id: 'injected' });
  at += CACHE_TTL_MS - 1;
  const cached = await C.getModels(options());
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.models.map(m => m.id), ['gpt-1']);
  assert.equal(requests, 1);
  at++;
  assert.equal((await C.getModels(options())).models[0].id, 'gpt-2');
  assert.equal((await C.getModels(options({ force: true }))).models[0].id, 'gpt-3');
  assert.equal(requests, 3);
});

test('simultaneous refreshes coalesce and never mix keys, including out-of-order replies', async () => {
  const A = deferred(), B = deferred();
  const calls = [];
  const C = createCatalog({ fetchImpl: (url, init) => {
    calls.push(init.headers.Authorization);
    return init.headers.Authorization === `Bearer ${key}` ? A.promise : B.promise;
  } });
  const first = C.getModels(options());
  const second = C.getModels(options({ force: true }));
  const other = C.getModels(options({ apiKey: 'sk-other-fake-key' }));
  assert.equal(calls.length, 2);
  B.resolve(response(list('gpt-other')));
  assert.equal((await other).models[0].id, 'gpt-other');
  A.resolve(response(list('gpt-original')));
  assert.equal((await first).models[0].id, 'gpt-original');
  assert.equal((await second).models[0].id, 'gpt-original');
  assert.equal((await C.getModels(options())).models[0].id, 'gpt-original');
  assert.equal((await C.getModels(options({ apiKey: 'sk-other-fake-key' }))).models[0].id, 'gpt-other');
  assert.equal(calls.length, 2);
});

test('failed forced refresh clears the old result and never returns a stale catalogue', async () => {
  let requests = 0;
  const C = createCatalog({ fetchImpl: async () => ++requests === 1
    ? response(list('gpt-old')) : response({ error: { message: `Invalid API key: ${key}` } }, { status: 401 }) });
  assert.equal((await C.getModels(options())).ok, true);
  const failed = await C.getModels(options({ force: true }));
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, 'auth');
  assert.deepEqual(failed.models, []);
  assert.ok(!JSON.stringify(failed).includes(key));
  assert.equal((await C.getModels(options())).ok, false);
  assert.equal(requests, 3, 'failure was not cached and previous success is not reused');
});

test('API errors and thrown errors cannot expose keys or server-supplied private details', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const C = createCatalog({ fetchImpl: async () => response({ error: { message: `secret ${key} private-account@example.test` } }, { status }) });
    const result = await C.getModels(options());
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes(key));
    assert.ok(!JSON.stringify(result).includes('private-account'));
  }
  const C = createCatalog({ fetchImpl: async () => { throw new Error(`fetch failed with Authorization: Bearer ${key}`); } });
  const result = await C.getModels(options());
  assert.equal(result.kind, 'network');
  assert.ok(!JSON.stringify(result).includes(key));
});

test('redirects are refused rather than following them with credentials', async () => {
  let calls = 0;
  const C = createCatalog({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    return new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } });
  } });
  assert.equal((await C.getModels(options())).kind, 'redirect');
  assert.equal(calls, 1);
  const D = createCatalog({ fetchImpl: async () => ({
    ok: true, status: 200, url: 'https://evil.test/models', body: new ReadableStream(),
  }) });
  assert.equal((await D.getModels(options())).kind, 'redirect');
});

test('malformed model lists are rejected without caching a partial result', async () => {
  for (const payload of [null, {}, { data: 'bad' }, { data: [{ id: 'gpt-good' }, { id: '' }] }, { data: [{ id: 'x'.repeat(1025) }] }]) {
    let calls = 0;
    const C = createCatalog({ fetchImpl: async () => { calls++; return response(payload); } });
    const result = await C.getModels(options());
    assert.equal(result.kind, 'response');
    assert.deepEqual(result.models, []);
    await C.getModels(options());
    assert.equal(calls, 2);
  }
  const C = createCatalog({ fetchImpl: async () => new Response('not json') });
  assert.equal((await C.getModels(options())).kind, 'response');
});

test('bounded reader refuses both declared and streamed oversized bodies and cancels the stream', async () => {
  let cancelled = false;
  const C = createCatalog({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-length': String(MAX_JSON_BYTES + 1) },
  }) });
  assert.equal((await C.getModels(options())).kind, 'response');
  assert.equal(cancelled, true);
  let streamedCancel = false, sent = 0;
  const D = createCatalog({ fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) {
      sent++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { streamedCancel = true; },
  })) });
  assert.equal((await D.getModels(options())).kind, 'response');
  assert.equal(streamedCancel, true);
  assert.ok(sent <= 6, 'reader stops after a bounded number of chunks');
});

test('timeout bounds stalled HTTP and body reads, aborts and permits a fresh request', async () => {
  let aborted = false, calls = 0;
  const C = createCatalog({ timeoutMs: 15, fetchImpl: async (url, init) => {
    calls++;
    if (calls > 1) return response(list('gpt-recovered'));
    init.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  const result = await C.getModels(options());
  assert.equal(result.kind, 'timeout');
  assert.equal(aborted, true);
  assert.equal((await C.getModels(options())).models[0].id, 'gpt-recovered');
  let bodyCancelled = false;
  const D = createCatalog({ timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })) });
  assert.equal((await D.getModels(options())).kind, 'timeout');
  assert.equal(bodyCancelled, true);
});

test('metadata is parsed conservatively and duplicate IDs do not multiply list entries', async () => {
  const C = createCatalog({ fetchImpl: async () => response({ data: [
    { id: 'gpt-one', created: '123', owned_by: {}, shutdown_date: 'tomorrow' },
    { id: 'gpt-two', created: 123, owned_by: 'openai', shutdown_date: null },
    { id: 'gpt-two', created: 456, owned_by: 'openai', shutdown_date: '2027-02-01' },
  ] }) });
  const result = await C.getModels(options());
  assert.equal(result.models.length, 2);
  assert.deepEqual(result.models.map(({ id, created, owned_by, shutdown_date }) => ({ id, created, owned_by, shutdown_date })), [
    { id: 'gpt-one', created: null, owned_by: null, shutdown_date: null },
    { id: 'gpt-two', created: 456, owned_by: 'openai', shutdown_date: '2027-02-01' },
  ]);
  assert.equal(classifyModel({ id: 'gpt-one', shutdown_date: '2027-02-30' }).shutdown_date, null);
  assert.equal(classifyModel({ id: 'gpt-one', shutdown_date: '2028-02-29' }).shutdown_date, '2028-02-29');
});

test('declared past shutdown dates stay visible but cannot be selected, including fine-tuned models', async () => {
  const at = Date.parse('2026-11-01T12:00:00Z');
  for (const id of ['gpt-6-sol', 'ft:gpt-4o-mini:org:mine:123', 'future-family']) {
    const retired = classifyModel({ id, shutdown_date: '2026-10-31' }, at);
    assert.equal(retired.retired, true);
    assert.equal(retired.selectable, false);
    assert.match(retired.reason, /retired on 2026-10-31/);
    const future = classifyModel({ id, shutdown_date: '2026-11-02' }, at);
    assert.equal(future.retired, false);
    assert.equal(future.selectable, true);
    assert.equal(classifyModel({ id, shutdown_date: '2026-11-01' }, at).retired, false, 'only dates past today are treated as retired');
  }
  const C = createCatalog({ now: () => at, fetchImpl: async () => response({ data: [
    { id: 'gpt-retired', shutdown_date: '2026-10-30' },
    { id: 'gpt-next', shutdown_date: '2026-12-01' },
  ] }) });
  const result = await C.getModels(options());
  assert.equal(result.models.length, 2);
  assert.equal(result.models.find(m => m.id === 'gpt-retired').selectable, false);
  assert.equal(result.models.find(m => m.id === 'gpt-next').selectable, true);
});

test('cached catalogues re-evaluate retirement when UTC today changes', async () => {
  let at = Date.parse('2026-11-01T23:59:59Z'), calls = 0;
  const C = createCatalog({ now: () => at, fetchImpl: async () => {
    calls++;
    return response({ data: [{ id: 'gpt-yesterday', shutdown_date: '2026-11-01' }] });
  } });
  assert.equal((await C.getModels(options())).models[0].selectable, true);
  at += 2000;
  const next = await C.getModels(options());
  assert.equal(next.cached, true);
  assert.equal(next.models[0].selectable, false);
  assert.match(next.models[0].reason, /retired on 2026-11-01/);
  assert.equal(calls, 1);
});
