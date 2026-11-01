'use strict';

// /models lists account availability, not prices, modalities or endpoint support.
// Categories below are hints from identifiers; the existing connection probe is
// still needed before using a model for chat, structured replies or image input.
const { createHash } = require('node:crypto');

const MODELS_URL = 'https://api.openai.com/v1/models';
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 20000;
const MAX_CACHED_KEYS = 8;
const TIMEOUT_MS = 15000;

function modelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !/[\s\x00-\x1f\x7f]/.test(value) ? value : null;
}

function classifyModel(input, at = Date.now()) {
  const raw = typeof input === 'string' ? { id: input } : (input || {});
  const id = modelId(raw.id);
  if (!id) return null;
  const fineTuned = /^ft:/i.test(id);
  const name = (fineTuned ? id.split(':')[1] || '' : id).toLowerCase();
  let category = 'other', selectable = true, classification = 'unknown';
  let reason = 'Capabilities are not listed by the models API. You can test this model manually for chat, structured replies and image input.';
  const specialized = (kind, explanation) => {
    category = kind; selectable = false; classification = 'inferred'; reason = explanation;
  };
  if (/embedding|(?:^|[-/])embed(?:[-/]|$)|^text-(?:search|similarity)-/.test(name)) {
    specialized('embeddings', 'Embedding model: creates search vectors; it is not a chat model.');
  } else if (/whisper|transcrib|speech-to-text/.test(name)) {
    specialized('transcription', 'Speech transcription model: use it for audio transcription, not chat.');
  } else if (/dall-e|(?:^|[-/])(?:image|imagegen)(?:[-/]|$)/.test(name)) {
    specialized('image-generation', 'Image generation model: creates or edits images; it is not an image-understanding chat model.');
  } else if (/moderation/.test(name)) {
    specialized('moderation', 'Moderation model: classifies content safety; it does not answer chat requests.');
  } else if (/(?:^|[-/])sora(?:[-/]|$)|(?:^|[-/])video(?:[-/]|$)/.test(name)) {
    specialized('video', 'Video generation model: use its video API, not the chat connection.');
  } else if (/realtime|(?:^|[-/])audio(?:[-/]|$)|(?:^|[-/])tts(?:[-/]|$)|text-to-speech/.test(name)) {
    specialized('audio/realtime', 'Audio or realtime model: requires a specialised audio/realtime workflow. Chat compatibility is not assumed.');
  } else if (/^(?:text-)?(?:ada|babbage|curie|davinci)(?:[-:]|$)|(?:^|[-/])(?:search|rerank|similarity|reward)(?:[-/]|$)/.test(name)) {
    specialized('other', 'Specialised or legacy completion model: compatibility with this app\'s chat workflow is not established.');
  } else if (/^(?:gpt-|chatgpt-|o\d+(?:[-.]|$))/.test(name)) {
    category = 'chat'; classification = 'inferred';
    reason = 'Chat-family identifier. Test the connection to verify this account, chat endpoint, structured replies and image input.';
  }
  if (fineTuned && selectable) {
    classification = 'unknown';
    reason = 'Fine-tuned model: endpoint and input support depend on its base model and training. You can test it manually; capabilities are not verified.';
  }
  const created = Number.isSafeInteger(raw.created) && raw.created >= 0 ? raw.created : null;
  const owned_by = typeof raw.owned_by === 'string' ? raw.owned_by.slice(0, 256) : null;
  // Keep a declared date separate from our identifier-based classification.
  let shutdown_date = null;
  if (typeof raw.shutdown_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.shutdown_date)) {
    const date = new Date(raw.shutdown_date);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw.shutdown_date) shutdown_date = raw.shutdown_date;
  }
  const day = new Date(typeof at === 'function' ? at() : at);
  const today = Number.isFinite(day.getTime()) ? day.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const retired = shutdown_date !== null && shutdown_date < today;
  if (retired) {
    selectable = false;
    reason = `This model retired on ${shutdown_date}, according to the OpenAI model list. Choose an available model instead.`;
  }
  return { id, category, selectable, reason, classification, fineTuned, created, owned_by, shutdown_date, retired };
}

function officialBase(baseUrl) {
  if (baseUrl == null || baseUrl === '') return true;
  if (typeof baseUrl !== 'string') return false;
  try {
    const url = new URL(baseUrl);
    return url.origin === 'https://api.openai.com' && !url.username && !url.password
      && !url.search && !url.hash && /^\/v1\/?$/.test(url.pathname);
  } catch { return false; }
}

function fail(kind, error, status = 0) {
  return { ok: false, provider: 'openai', models: [], source: 'openai-models-api', kind, error, status };
}

function statusFailure(status) {
  if (status === 401) return fail('auth', 'OpenAI rejected the saved API key. Update the OpenAI key and try again.', status);
  if (status === 403) return fail('auth', 'This OpenAI key is not allowed to list models. Check its permissions and project access.', status);
  if (status === 429) return fail('rate', 'OpenAI asked to slow down or the account has reached its allowance. Try again later and check account usage.', status);
  if (status >= 300 && status < 400) return fail('redirect', 'OpenAI returned a redirect. It was refused to protect the saved API key.', status);
  if (status >= 500) return fail('api', 'OpenAI could not list models right now. Try again later.', status);
  return fail('api', `OpenAI refused the model list request (HTTP ${status}).`, status);
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* The fetch may already be aborted. */ }
}

async function readBoundedJson(response, signal) {
  const declared = response.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_JSON_BYTES) {
    await cancelBody(response);
    throw new Error('catalog-size');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('catalog-json');
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error('catalog-size');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw new Error('catalog-json'); }
}

function cloneResult(result, cached, at) {
  // Retirement is evaluated again even when a cached list crosses midnight.
  return { ...result, ...(result.ok ? { cached } : {}), models: result.models.map(record => classifyModel(record, at)) };
}

function createCatalog({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  // Keys themselves never enter a cache key or an API response, and nothing is
  // persisted. Each credential has its own result and in-flight request.
  const cache = new Map(), pending = new Map();
  const timeout = Math.max(1, Math.min(60000, Number(timeoutMs) || TIMEOUT_MS));

  async function request(apiKey) {
    const controller = new AbortController();
    let timedOut = false, timer;
    const work = (async () => {
      const response = await fetchImpl(MODELS_URL, {
        method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        redirect: 'error', signal: controller.signal,
      });
      if (response.redirected || (response.url && response.url !== MODELS_URL)) {
        await cancelBody(response);
        return fail('redirect', 'The model list returned an unexpected address. It was refused to protect the saved API key.');
      }
      if (!response.ok) {
        // API errors can echo a submitted key. Do not surface any provider body,
        // request headers, fetch error text or causes to the renderer or logs.
        await cancelBody(response);
        return statusFailure(Number(response.status) || 0);
      }
      const json = await readBoundedJson(response, controller.signal);
      if (!json || !Array.isArray(json.data) || json.data.length > MAX_MODELS) throw new Error('catalog-json');
      const records = new Map();
      for (const item of json.data) {
        const record = classifyModel(item, now());
        if (!record) throw new Error('catalog-json');
        records.set(record.id, record);
      }
      const fetchedAt = now();
      return {
        ok: true, provider: 'openai', source: 'openai-models-api',
        models: [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        fetchedAt, expiresAt: fetchedAt + CACHE_TTL_MS,
      };
    })();
    try {
      return await Promise.race([work, new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true; controller.abort();
          resolve(fail('timeout', 'OpenAI took too long to list models. Try again.'));
        }, timeout);
      })]);
    } catch (error) {
      if (timedOut || controller.signal.aborted) return fail('timeout', 'OpenAI took too long to list models. Try again.');
      if (error?.message === 'catalog-size') return fail('response', 'OpenAI returned a model list larger than the supported limit.');
      if (error?.message === 'catalog-json') return fail('response', 'OpenAI returned an invalid model list. Try refreshing it.');
      return fail('network', 'Could not securely reach the OpenAI model list. Check your connection and try again.');
    } finally { clearTimeout(timer); }
  }

  async function getModels({ provider, apiKey, baseUrl, force = false } = {}) {
    if (provider !== 'openai') return fail('unsupported', 'The live catalogue is available for the official OpenAI provider. Enter and test other providers\' model IDs manually.');
    if (!officialBase(baseUrl)) return fail('endpoint', 'The OpenAI catalogue uses only https://api.openai.com/v1. Custom endpoints are not sent the saved OpenAI key.');
    if (typeof apiKey !== 'string' || !apiKey.trim()) return fail('key', 'Save an OpenAI API key before loading available models.');
    const key = apiKey.trim();
    if (key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) return fail('key', 'The saved OpenAI API key has an invalid format. Update it and try again.');
    const fingerprint = createHash('sha256').update(key).digest('hex');
    for (const [id, entry] of cache) if (entry.expiresAt <= now()) cache.delete(id);
    if (pending.has(fingerprint)) return cloneResult(await pending.get(fingerprint), false, now());
    if (!force && cache.has(fingerprint)) return cloneResult(cache.get(fingerprint), true, now());
    // A failed forced refresh must not silently reinstate an older catalogue.
    cache.delete(fingerprint);
    const job = request(key);
    pending.set(fingerprint, job);
    let result;
    try { result = await job; }
    finally { if (pending.get(fingerprint) === job) pending.delete(fingerprint); }
    if (result.ok) {
      cache.set(fingerprint, result);
      while (cache.size > MAX_CACHED_KEYS) cache.delete(cache.keys().next().value);
    }
    return cloneResult(result, false, now());
  }

  return { getModels };
}

let singleton;
module.exports = {
  createCatalog, classifyModel,
  getModels: options => (singleton ||= createCatalog()).getModels(options),
  MODELS_URL, CACHE_TTL_MS, MAX_JSON_BYTES,
};
