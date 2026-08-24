'use strict';
// One function, two implementations. Everything above this file asks for
// `complete({...})` and gets back parsed JSON plus token counts; it never
// learns which vendor answered.
const { PRESETS, costOf, capCostOf } = require('./presets');

const TIMEOUT_MS = 90000;

class AiError extends Error {
  constructor(message, { kind = 'error', status = 0, retryable = false } = {}) {
    super(message);
    this.kind = kind;           // auth | rate | network | cert | model | schema | error
    this.status = status;
    this.retryable = retryable;
  }
}

// Turn whatever the network threw at us into something a person can act on.
// The cert case matters: on a network that inspects TLS, Node's bundled roots
// reject the proxy's certificate and the raw message is just "fetch failed".
function wrapNetworkError(e, label) {
  const code = (e && e.cause && (e.cause.code || e.cause.message)) || e.code || '';
  const certish = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_|DEPTH_ZERO/i.test(String(code));
  if (certish) {
    return new AiError(
      `Could not verify the secure connection to ${label}. A company firewall or filtering software on this network is inspecting HTTPS traffic. (${code})`,
      { kind: 'cert' }
    );
  }
  if (/ECONNREFUSED/i.test(String(code))) {
    return new AiError(`Nothing is listening at ${label}. If this is a local AI, start it first.`, { kind: 'network' });
  }
  if (/ABORT_ERR|AbortError/i.test(String(e && e.name) + code)) {
    return new AiError(`${label} took too long to answer.`, { kind: 'network', retryable: true });
  }
  return new AiError(`Could not reach ${label}: ${(e && e.message) || code || 'unknown error'}`, { kind: 'network', retryable: true });
}

function statusToError(status, body, label) {
  const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body || {}).slice(0, 300);
  if (status === 401 || status === 403) return new AiError(`${label} rejected the API key.`, { kind: 'auth', status });
  if (status === 404) return new AiError(`${label} doesn't know that model name.`, { kind: 'model', status });
  if (status === 429) return new AiError(`${label} is rate-limiting this key — slowing down.`, { kind: 'rate', status, retryable: true });
  if (status >= 500) return new AiError(`${label} had a server error.`, { kind: 'network', status, retryable: true });
  return new AiError(`${label} refused the request (${status}). ${detail}`, { kind: 'error', status });
}

// Models disagree about how much JSON chatter they wrap around an answer.
function parseJson(text) {
  if (!text) throw new AiError('The model returned an empty response.', { kind: 'schema' });
  try { return JSON.parse(text); } catch (_) {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch (_) {} }
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first >= 0 && last > first) { try { return JSON.parse(text.slice(first, last + 1)); } catch (_) {} }
  throw new AiError('The model did not return valid JSON.', { kind: 'schema', retryable: true });
}

/* ---------------- Anthropic ---------------- */
async function completeAnthropic(cfg, req) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0, timeout: TIMEOUT_MS });

  const content = [];
  for (const img of req.images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  content.push({ type: 'text', text: req.user });

  let res;
  try {
    res = await client.messages.create({
      model: cfg.model,
      max_tokens: req.maxTokens || 512,
      system: req.system,
      messages: [{ role: 'user', content }],
      ...(req.schema ? { output_config: { format: { type: 'json_schema', schema: req.schema } } } : {}),
    }, { signal: req.signal });
  } catch (e) {
    if (e && typeof e.status === 'number') throw statusToError(e.status, e.message, 'Anthropic');
    throw wrapNetworkError(e, 'Anthropic');
  }

  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    json: req.schema ? parseJson(text) : null,
    text,
    usage: { in: res.usage.input_tokens || 0, out: res.usage.output_tokens || 0 },
  };
}

/* ---------------- OpenAI-compatible ---------------- */
async function completeOpenAi(cfg, req) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new AiError('No server address is configured for this provider.', { kind: 'error' });
  const label = new URL(base).host;

  const parts = [{ type: 'text', text: req.user }];
  for (const img of req.images || []) {
    // `detail: low` keeps image cost predictable on providers that honour it
    // and is ignored harmlessly by those that don't.
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'low' } });
  }

  // OpenAI's own reasoning models reject `max_tokens` outright and want
  // `max_completion_tokens`; everything else that speaks this dialect —
  // Ollama, LM Studio, Groq, OpenRouter — still expects the older name.
  const openAiProper = /(^|\.)openai\.com$/i.test(label);
  const limit = req.maxTokens || 512;
  const body = {
    model: cfg.model,
    ...(openAiProper ? { max_completion_tokens: limit } : { max_tokens: limit }),
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: parts },
    ],
  };
  // Gemini's 2.5 models think before they answer, and the thinking is spent out
  // of the same token allowance as the reply. Asked for a short JSON answer they
  // reason past the limit and return nothing parseable — which reads exactly
  // like a model that ignores the requested format. Turning thinking off is the
  // documented control on this endpoint, and these are labelling calls: the
  // shape is fixed and there is nothing to reason about. Pro and 3-series models
  // refuse to have it turned off, so they are not asked.
  const isGemini = /(^|\.)generativelanguage\.googleapis\.com$/i.test(label);
  if (isGemini && /^gemini-2\.5-flash/i.test(cfg.model || '')) body.reasoning_effort = 'none';

  if (req.schema) {
    body.response_format = cfg.jsonSchema === false
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: req.schemaName || 'result', strict: true, schema: req.schema } };
    // Models without schema enforcement need the shape spelled out to them.
    if (cfg.jsonSchema === false) {
      body.messages[0].content += `\n\nReply with JSON only, matching exactly this shape:\n${JSON.stringify(req.schema)}`;
    }
  }

  const headers = { 'content-type': 'application/json' };
  // A model on this machine has no key to check, and handing one over anyway
  // would give a local program a secret it never asked for.
  if (cfg.apiKey && !cfg.local) headers.authorization = `Bearer ${cfg.apiKey}`;

  // The timeout has to cover reading the body as well as getting the headers,
  // and it has to survive a caller passing its own cancel signal — otherwise a
  // server that accepts the connection and then goes quiet hangs the run.
  const timer = new AbortController();
  const to = setTimeout(() => timer.abort(), TIMEOUT_MS);
  if (req.signal) req.signal.addEventListener('abort', () => timer.abort(), { once: true });
  let res, raw;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: timer.signal,
    });
    raw = await res.text();
  } catch (e) {
    throw wrapNetworkError(e, label);
  } finally { clearTimeout(to); }

  if (!res.ok) throw statusToError(res.status, raw, label);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) {
    throw new AiError(`${label} returned something that isn't an API response.`, { kind: 'error' });
  }
  const text = payload.choices && payload.choices[0] && payload.choices[0].message
    ? (payload.choices[0].message.content || '') : '';
  const usage = payload.usage || {};
  return {
    json: req.schema ? parseJson(text) : null,
    text,
    usage: { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 },
  };
}

/* ---------------- public ---------------- */
// cfg: { provider, model, apiKey, baseUrl, jsonSchema }
async function complete(cfg, req) {
  const preset = PRESETS[cfg.provider] || PRESETS.custom;
  const api = preset.api;
  if (api === 'anthropic' && !cfg.apiKey) throw new AiError('No API key has been set.', { kind: 'auth' });

  const started = Date.now();
  // `local` is a property of the provider, not of whatever the caller passed —
  // reading it off cfg let an overridden provider look remote and be handed a key.
  const out = api === 'demo' ? await require('./demo').complete(cfg, req)
    : api === 'anthropic' ? await completeAnthropic(cfg, req)
      : await completeOpenAi({ ...preset, ...cfg, local: !!preset.local }, req);
  out.ms = Date.now() - started;
  out.cost = costOf(cfg.provider, cfg.model, out.usage.in, out.usage.out);
  out.costCap = capCostOf(cfg.provider, cfg.model, out.usage.in, out.usage.out);
  return out;
}

module.exports = { complete, AiError, parseJson };
