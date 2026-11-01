'use strict';
// One function, provider-specific transports. Everything above this file asks for
// `complete({...})` and gets back parsed JSON plus token counts; it never
// learns which vendor answered.
const { PRESETS, costOf, capCostOf } = require('./presets');
const limits = require('./limits');

const TIMEOUT_MS = 90000;

// The thinking setting each Gemini model accepts, learned from its refusals.
// Google's compatibility table says the 3-series Flash models take "minimal";
// on 2026-10-12 gemini-3.8-flash answered "Thinking level MINIMAL is not
// supported for this model" and failed every photo it was given. So each
// model starts at its smallest setting and steps up once when refused, and
// remembers the step for the rest of the session.
const effortLadder = (model) => (/^gemini-2\.5-flash/i.test(model) ? ['none', 'low', null]
  : /^gemini-3[\d.]*-flash/i.test(model) ? ['minimal', 'low', null] : [null]);
const effortStep = new Map();                 // model -> index into its ladder
// Thinking is paid out of the same token allowance as the answer. When it
// cannot be switched off, room is added on top, so a 400-token answer is not
// cut short by 600 tokens of thought. Free tiers do not charge per token.
const THINKING_ROOM = 1536;

class AiError extends Error {
  constructor(message, { kind = 'error', status = 0, retryable = false } = {}) {
    super(message);
    this.kind = kind;           // auth | billing | rate | busy | timeout | network | cert | model | schema | length | error | wait
    this.status = status;
    this.retryable = retryable;
  }
}
const redact = (value, cfg) => cfg.apiKey ? String(value || '').split(cfg.apiKey).join('[redacted]') : String(value || '');

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
  // Told outright that nothing is there. Distinct from a slow or flaky answer:
  // there is no point retrying this item against this provider, and the chain
  // should step past it instead. Most likely a local model that isn't running.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(String(code))) {
    return new AiError(`Nothing is listening at ${label}. If this is a local AI, start it first.`, { kind: 'down' });
  }
  if (/ABORT_ERR|AbortError/i.test(String(e && e.name) + code)) {
    return new AiError(`${label} took too long to answer.`, { kind: 'timeout', retryable: true });
  }
  return new AiError(`Could not reach ${label}: ${(e && e.message) || code || 'unknown error'}`, { kind: 'network', retryable: true });
}

// Turn a JSON Schema into an example of what an answer looks like. Each
// placeholder carries that property's own description, so the model is told
// what belongs in the slot at the point it has to write it.
function skeletonFor(schema) {
  if (!schema || typeof schema !== 'object') return '<text>';
  if (schema.type === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties || {})) out[k] = skeletonFor(v);
    return out;
  }
  // The description of a list lives on the list, not on its items, so pass it
  // down or every array slot reads a uselessly generic <text>.
  if (schema.type === 'array') {
    const items = schema.items || {};
    return [skeletonFor(items.description ? items : Object.assign({}, items, { description: schema.description }))];
  }
  if (schema.type === 'boolean') return true;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  const hint = String(schema.description || 'text').replace(/\s+/g, ' ').replace(/\.$/, '');
  return '<' + hint + '>';
}

// The refusal is read in full (limits.js), because "429" alone cannot say
// whether to wait a minute or until tomorrow, and a 400 can be a bad key or an
// empty account rather than anything wrong with the item.
function statusToError(status, body, label, headers) {
  const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body || {}).slice(0, 300);
  const refusal = limits.readRefusal(status, body, headers);
  const make = (message, opts) => { const e = new AiError(message, { status, ...opts }); e.refusal = refusal; return e; };
  if (refusal.billing) return make(`${label} says this account has no credit left.`, { kind: 'billing' });
  if (status === 401 || refusal.badKey) return make(`${label} rejected the API key.`, { kind: 'auth' });
  if (status === 403) return make(/model/i.test(detail) ? `${label} does not let this key use that model.` : `${label} rejected the API key.`, { kind: 'auth' });
  if (status === 404) return make(`${label} doesn't know that model name.`, { kind: 'model' });
  if (status === 429) {
    const when = refusal.scope === 'day' ? " today's free allowance is used up" : refusal.scope === 'minute' ? ' too many requests this minute' : ' asked to slow down';
    return make(`${label}:${when}.`, { kind: 'rate', retryable: true });
  }
  if (refusal.busy) return make(`${label} is overloaded right now.`, { kind: 'busy', retryable: true });
  if (status >= 500) return make(`${label} had a server error.`, { kind: 'network', retryable: true });
  return make(`${label} refused the request (${status}). ${detail}`, { kind: 'error' });
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
    if (e && typeof e.status === 'number') throw statusToError(e.status, (e.error ? JSON.stringify(e.error) + ' ' : '') + (e.message || ''), 'Anthropic', e.headers);
    throw wrapNetworkError(e, 'Anthropic');
  }

  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  // A reply that ran out of room is not a reply in the wrong shape, and saying
  // so sends the reader to the wrong problem. The half that arrived is real
  // JSON up to the point it stops, which is exactly what makes it unparseable.
  if (res.stop_reason === 'max_tokens') {
    throw new AiError('Anthropic ran out of room mid-answer (' + (res.usage && res.usage.output_tokens)
      + ' tokens) — the reply was cut off, not malformed.', { kind: 'length', retryable: false });
  }
  return {
    json: req.schema ? parseJson(text) : null,
    text,
    usage: { in: res.usage.input_tokens || 0, out: res.usage.output_tokens || 0 },
  };
}

/* ---------------- official OpenAI Responses ---------------- */
const openaiModes = new Map(), openaiFormats = new Map(), openaiTokenKeys = new Map();
const modelBase = model => String(model || '').replace(/^ft:/, '').split(':')[0].toLowerCase();
const isReasoningModel = model => /^(?:gpt-(?:[5-9]|\d{2})(?:[.-]|$)|o\d(?:[.-]|$))/.test(modelBase(model));
const isLegacyChatModel = model => /^(?:gpt-3\.5(?:-|$)|gpt-4(?:$|-(?:turbo|vision|\d))|chatgpt-4o-latest|gpt-\d+(?:\.\d+)?-chat-latest|o1-(?:mini|preview)(?:-|$))/.test(modelBase(model));
function openaiEffort(cfg) {
  const model = modelBase(cfg.model);
  if (!isReasoningModel(model) || /^o1-(?:mini|preview)(?:-|$)/.test(model)) return null;
  const chosen = cfg.openaiReasoningEffort;
  if (chosen && chosen !== 'auto') return chosen;
  // Lowest documented efforts preserve this app's extraction/labeling role.
  // Unknown future models keep their own default instead of receiving an
  // assumed parameter value. Their output limit still leaves reasoning room.
  if (/^gpt-(?:6-astra|6\.1-sol)(?:-|$)/.test(model)) return 'low';
  if (/^gpt-(?:6(?:\.1)?-(?:luna|terra|sol)|5\.6(?:-(?:sol|terra|luna))?)(?:-|$)/.test(model)) return 'none';
  if (/^gpt-5(?:-(?:mini|nano))?(?:-\d|$)/.test(model)) return 'minimal';
  if (/^o\d(?:-|$)/.test(model)) return 'low';
  return null;
}
function openaiOutputLimit(cfg, req) {
  const answer = Math.max(16, Math.min(128000, Number(req.maxTokens) || 512));
  if (!isReasoningModel(cfg.model)) return answer;
  const effort = openaiEffort(cfg);
  const room = effort === 'none' ? 0 : effort === 'minimal' ? 1536 : ['max', 'xhigh'].includes(effort) ? 24576 : effort === 'high' ? 12288 : effort === 'medium' ? 8192 : 4096;
  return Math.min(128000, answer + room);
}
function openaiBase(cfg) {
  let url;
  try { url = new URL(cfg.baseUrl || PRESETS.openai.baseUrl); } catch (_) { throw new AiError('The OpenAI server address is invalid.', { kind: 'error' }); }
  const official = url.hostname === 'api.openai.com' || url.hostname.endsWith('.api.openai.com');
  if (!official) {
    if (cfg.provider === 'openai') throw new AiError('Use the official OpenAI API address, or choose an OpenAI-compatible provider for a different server.', { kind: 'auth' });
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new AiError('OpenAI requires a secure API address without credentials or query parameters.', { kind: 'auth' });
  const route = url.pathname.replace(/\/+$/, '').replace(/\/(?:responses|chat\/completions)$/, '');
  if (route !== '/v1') throw new AiError('The OpenAI API base address must end in /v1.', { kind: 'error' });
  return url.origin + '/v1';
}
const openaiUsage = usage => ({ in: Number(usage?.input_tokens ?? usage?.prompt_tokens) || 0, out: Number(usage?.output_tokens ?? usage?.completion_tokens) || 0,
  reasoning: Number(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens) || 0 });
function answeredError(error, usage, headers, transport) { error.usage = usage; error.headers = headers; error.transport = transport; error.paidResponse = true; return error; }
async function postOpenai(base, route, cfg, req, body) {
  const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
  const abort = () => timer.abort(); req.signal?.addEventListener('abort', abort, { once: true });
  if (req.signal?.aborted) timer.abort();
  try {
    const response = await fetch(base + route, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) }, body: JSON.stringify(body), signal: timer.signal });
    const raw = await response.text();
    if (response.status >= 300 && response.status < 400) throw new AiError('OpenAI redirected the request. Check the configured API address.', { kind: 'auth', status: response.status });
    if (!response.ok) {
      const safe = redact(raw, cfg), error = statusToError(response.status, safe, new URL(base).host, response.headers);
      Object.defineProperty(error, 'apiDetail', { value: safe, enumerable: false }); throw error;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { throw new AiError('OpenAI returned an invalid API response.', { kind: 'schema' }); }
    return { payload, headers: response.headers };
  } catch (error) { const safe = error instanceof AiError ? error : wrapNetworkError(error, new URL(base).host); safe.message = redact(safe.message, cfg); throw safe; }
  finally { clearTimeout(timeout); req.signal?.removeEventListener('abort', abort); }
}
function unsupportedOpenai(error, type) {
  if (![400, 404, 405, 422].includes(error.status) || ['auth', 'billing', 'rate'].includes(error.kind)) return false;
  const detail = String(error.apiDetail || '');
  if (type === 'transport') return /(?:responses|chat.?completions).{0,100}(?:not supported|unsupported|not available|only supported)|(?:not supported|unsupported|only supported|only available).{0,100}(?:responses|chat.?completions)|(?:unknown|unrecognized|invalid) (?:request )?(?:url|endpoint).{0,100}responses/i.test(detail);
  if (/invalid (?:json )?schema|schema.*(?:required|additionalProperties|properties|items)/i.test(detail)) return false;
  return /(?:unsupported|not supported|does not support).{0,100}(?:response_format|text\.format|json_schema|json_object)|(?:response_format|text\.format|json_schema|json_object).{0,100}(?:unsupported|not supported|does not support)/i.test(detail);
}
function formatInstructions(req) { return String(req.system || '') + (req.schema ? '\n\nReply with JSON only in this shape, replacing placeholders with real values:\n' + JSON.stringify(skeletonFor(req.schema)) : ''); }
async function completeOfficialOpenai(cfg, req, base) {
  const key = base + '|' + cfg.model;
  const mode = ['responses', 'chat'].includes(cfg.openaiApiMode) ? cfg.openaiApiMode : 'auto';
  let transport = mode === 'auto' ? openaiModes.get(key) || (isLegacyChatModel(cfg.model) ? 'chat' : 'responses') : mode;
  let format = req.schema ? (cfg.jsonSchema === false ? (openaiFormats.get(key) === 'text' ? 'text' : 'json_object') : openaiFormats.get(key) || 'json_schema') : 'text';
  let switched = false, tokenSwitched = false, chatTokenKey = openaiTokenKeys.get(key);
  for (;;) {
    const limit = openaiOutputLimit(cfg, req), effort = openaiEffort(cfg);
    let body;
    if (transport === 'responses') {
      const content = [{ type: 'input_text', text: String(req.user || '') }, ...(req.images || []).map(image => ({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}`, detail: req.imageDetail || 'low' }))];
      body = { model: cfg.model, store: false, instructions: format === 'json_schema' || !req.schema ? String(req.system || '') : formatInstructions(req), input: [{ role: 'user', content }], max_output_tokens: limit,
        ...(effort ? { reasoning: { effort } } : {}),
        ...(req.schema && format !== 'text' ? { text: { format: format === 'json_schema' ? { type: 'json_schema', name: req.schemaName || 'result', strict: true, schema: req.schema } : { type: 'json_object' } } } : {}) };
    } else {
      const legacyReasoning = /^o1-(?:mini|preview)(?:-|$)/.test(modelBase(cfg.model));
      const content = [{ type: 'text', text: (legacyReasoning ? formatInstructions(req) + '\n\n' : '') + String(req.user || '') }, ...(req.images || []).map(image => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}`, detail: req.imageDetail || 'low' } }))];
      const oldTokens = /^(?:gpt-3\.5|gpt-4(?:$|-(?:\d|turbo|vision)))/.test(modelBase(cfg.model));
      body = { model: cfg.model, store: false, [chatTokenKey || (oldTokens ? 'max_tokens' : 'max_completion_tokens')]: limit, messages: [...(legacyReasoning ? [] : [{ role: 'system', content: format === 'json_schema' || !req.schema ? String(req.system || '') : formatInstructions(req) }]), { role: 'user', content }],
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(req.schema && format !== 'text' ? { response_format: format === 'json_schema' ? { type: 'json_schema', json_schema: { name: req.schemaName || 'result', strict: true, schema: req.schema } } : { type: 'json_object' } } : {}) };
    }
    let payload, headers;
    try { ({ payload, headers } = await postOpenai(base, transport === 'responses' ? '/responses' : '/chat/completions', cfg, req, body)); }
    catch (error) {
      // Retry only requests rejected before generation for a specific unsupported
      // endpoint/format. Never replay paid refusals, incomplete output or billing.
      if (transport === 'chat' && !tokenSwitched && error.status === 400 && !['auth', 'billing', 'rate'].includes(error.kind)) {
        const detail = String(error.apiDetail || '');
        const parameter = body.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens';
        if (detail.includes(parameter) && /unsupported parameter|not supported/i.test(detail)) {
          chatTokenKey = parameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'; tokenSwitched = true; continue;
        }
      }
      if (req.schema && format !== 'text' && unsupportedOpenai(error, 'format')) { format = format === 'json_schema' ? 'json_object' : 'text'; continue; }
      if (mode === 'auto' && !switched && unsupportedOpenai(error, 'transport')) { transport = transport === 'responses' ? 'chat' : 'responses'; switched = true; continue; }
      throw error;
    }
    const usage = openaiUsage(payload.usage);
    try {
      let text = '';
      if (transport === 'responses') {
        if (payload.error) throw statusToError(400, redact(JSON.stringify(payload.error), cfg), 'OpenAI', headers);
        if (payload.status === 'incomplete') throw new AiError(payload.incomplete_details?.reason === 'max_output_tokens' ? 'OpenAI ran out of output room, including reasoning tokens. Increase the output allowance or lower reasoning effort.' : 'OpenAI did not finish this response (' + String(payload.incomplete_details?.reason || 'unknown reason') + ').', { kind: payload.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'refusal', retryable: false });
        if (payload.status && payload.status !== 'completed') throw new AiError('OpenAI did not complete this response (' + payload.status + ').', { kind: 'error', retryable: false });
        const messages = (Array.isArray(payload.output) ? payload.output : []).filter(item => item.type === 'message');
        const content = messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
        if (content.some(item => item.type === 'refusal')) throw new AiError('OpenAI declined this request. Review the file or query before trying again.', { kind: 'refusal', retryable: false });
        if (messages.some(item => item.status === 'incomplete')) throw new AiError('OpenAI returned an incomplete message.', { kind: 'length', retryable: false });
        text = content.filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('');
        if (!text && typeof payload.output_text === 'string') text = payload.output_text;
      } else {
        const choice = payload.choices?.[0], message = choice?.message;
        if (choice?.finish_reason === 'length') throw new AiError('OpenAI ran out of completion room, including reasoning tokens.', { kind: 'length', retryable: false });
        if (message?.refusal || choice?.finish_reason === 'content_filter') throw new AiError('OpenAI declined this request. Review the file or query before trying again.', { kind: 'refusal', retryable: false });
        text = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.filter(part => ['text', 'output_text'].includes(part.type)).map(part => part.text || '').join('') : '';
      }
      if (!text.trim()) throw new AiError('OpenAI returned no answer text. Reasoning or tool output alone cannot index this file.', { kind: 'schema', retryable: false });
      const json = req.schema ? parseJson(text) : null;
      if (mode === 'auto') openaiModes.set(key, transport);
      if (req.schema) openaiFormats.set(key, format);
      if (transport === 'chat' && chatTokenKey) openaiTokenKeys.set(key, chatTokenKey);
      return { json, text, usage, headers, transport, jsonMode: format };
    } catch (error) { error.retryable = false; throw answeredError(error, usage, headers, transport); }
  }
}

/* ---------------- OpenAI-compatible Chat Completions ---------------- */
async function completeOpenAi(cfg, req) {
  const base = openaiBase(cfg);
  if (base) return completeOfficialOpenai(cfg, req, base);
  return completeChatCompletions(cfg, req);
}
async function completeChatCompletions(cfg, req) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new AiError('No server address is configured for this provider.', { kind: 'error' });
  const label = new URL(base).host;

  const parts = [{ type: 'text', text: req.user }];
  for (const img of req.images || []) {
    // `detail: low` keeps image cost predictable on providers that honour it
    // and is ignored harmlessly by those that don't.
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: req.imageDetail || 'low' } });
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
  const ladder = isGemini ? effortLadder(cfg.model || '') : [null];
  let step = Math.min(effortStep.get(cfg.model) || 0, ladder.length - 1);
  const applyEffort = () => {
    const effort = ladder[step];
    if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort;
    const room = ladder.length > 1 && effort !== 'none' && effort !== 'minimal' ? THINKING_ROOM : 0;
    if (openAiProper) body.max_completion_tokens = limit + room; else body.max_tokens = limit + room;
  };
  applyEffort();

  if (req.schema) {
    body.response_format = cfg.jsonSchema === false
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: req.schemaName || 'result', strict: true, schema: req.schema } };
    // Models without schema enforcement need the shape spelled out to them,
    // and it has to be an example rather than the schema itself. Shown a JSON
    // Schema and told to match it, a small local model answers
    // {"type":"object","properties":{"colour":"Red"}} - it copied the
    // description instead of filling one in. Seen with qwen2.5vl:3b, which had
    // read the picture correctly and still returned nothing usable. A skeleton
    // with the descriptions as placeholders leaves nothing to guess.
    if (cfg.jsonSchema === false) {
      body.messages[0].content += '\n\nReply with JSON only, in exactly this shape, '
        + 'replacing every <...> with a real value:\n'
        + JSON.stringify(skeletonFor(req.schema));
    }
  }

  const headers = { 'content-type': 'application/json' };
  // A model on this machine has no key to check, and handing one over anyway
  // would give a local program a secret it never asked for.
  if (cfg.apiKey && !cfg.local) headers.authorization = `Bearer ${cfg.apiKey}`;

  // The timeout has to cover reading the body as well as getting the headers,
  // and it has to survive a caller passing its own cancel signal — otherwise a
  // server that accepts the connection and then goes quiet hangs the run.
  let res, raw;
  for (;;) {
    const timer = new AbortController();
    const to = setTimeout(() => timer.abort(), TIMEOUT_MS);
    if (req.signal) req.signal.addEventListener('abort', () => timer.abort(), { once: true });
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal: timer.signal,
      });
      raw = await res.text();
    } catch (e) {
      throw wrapNetworkError(e, label);
    } finally { clearTimeout(to); }
    // Refused for the thinking setting, not for the item: one step up, again.
    if (res.status === 400 && step < ladder.length - 1 && /thinking[ _](level|budget|config)|reasoning[_ ]effort/i.test(raw)) {
      step++;
      effortStep.set(cfg.model, step);
      applyEffort();
      continue;
    }
    break;
  }

  if (!res.ok) throw statusToError(res.status, redact(raw, cfg), label, res.headers);

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
    headers: res.headers,
  };
}

/* ---------------- speech to text ----------------
   OpenAI's /audio/transcriptions shape, which Groq copies. Multipart, one
   file, the text back. Billed by the minute, so the duration is reported
   rather than tokens. */
async function transcribeOpenAi(cfg, req) {
  const base = openaiBase(cfg) || (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new AiError('No server address is configured for this provider.', { kind: 'error' });
  const label = new URL(base).host;
  const form = new FormData();
  form.append('model', cfg.audioModel);
  form.append('response_format', 'verbose_json');
  if (req.language) form.append('language', req.language);
  if (req.prompt) form.append('prompt', String(req.prompt).slice(0, 600));
  form.append('file', new Blob([req.bytes], { type: req.mimetype || 'application/octet-stream' }), req.filename || 'audio.ogg');

  const headers = {};
  if (cfg.apiKey && !cfg.local) headers.authorization = `Bearer ${cfg.apiKey}`;
  const timer = new AbortController();
  const to = setTimeout(() => timer.abort(), TIMEOUT_MS * 2);
  let res, raw;
  try {
    res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', redirect: 'error', headers, body: form, signal: timer.signal });
    raw = await res.text();
  } catch (e) {
    throw wrapNetworkError(e, label);
  } finally { clearTimeout(to); }
  if (!res.ok) throw statusToError(res.status, redact(raw, cfg), label, res.headers);
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { payload = { text: raw }; }
  const text = String(payload.text || '').trim();
  const seconds = Number(payload.duration) || (req.seconds || 0);
  return { text, language: payload.language || null, seconds, segments: Array.isArray(payload.segments) ? payload.segments.length : 0 };
}

// cfg: { provider, audioModel, apiKey, baseUrl }; req: { bytes, mimetype, filename, language?, prompt?, seconds? }
async function transcribe(cfg, req) {
  const preset = PRESETS[cfg.provider] || PRESETS.custom;
  const started = Date.now();
  let out;
  if (preset.api === 'demo') out = await require('./demo').transcribe(cfg, req);
  else if (preset.api === 'openai') out = await transcribeOpenAi({ ...preset, ...cfg, local: !!preset.local }, req);
  else throw new AiError(`${preset.label} does not transcribe audio.`, { kind: 'model' });
  out.ms = Date.now() - started;
  const { audioCostOf, audioCapCostOf } = require('./presets');
  out.cost = audioCostOf(cfg.provider, cfg.audioModel, out.seconds || 0);
  out.costCap = audioCapCostOf(cfg.provider, cfg.audioModel, out.seconds || 0);
  if (cfg.onUsage) cfg.onUsage(out);
  return out;
}

/* ---------------- embeddings ----------------
   Vectors for "find me the thing that means this", over the same
   OpenAI-compatible shape. Gemini's shim and NVIDIA's gateway both answer
   it; NVIDIA additionally insists on being told query or passage. */
async function embedOpenAi(cfg, texts, { inputType } = {}) {
  const base = openaiBase(cfg) || (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new AiError('No server address is configured for this provider.', { kind: 'error' });
  const label = new URL(base).host;
  const body = { model: cfg.embedModel, input: texts };
  if (cfg.embedDims && !/nvidia|openrouter/i.test(label)) body.dimensions = cfg.embedDims;
  if (cfg.embedInputType) { body.input_type = inputType || 'passage'; body.truncate = 'END'; }
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey && !cfg.local) headers.authorization = `Bearer ${cfg.apiKey}`;
  const timer = new AbortController();
  const to = setTimeout(() => timer.abort(), TIMEOUT_MS);
  let res, raw;
  try {
    res = await fetch(`${base}/embeddings`, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal: timer.signal });
    raw = await res.text();
  } catch (e) {
    throw wrapNetworkError(e, label);
  } finally { clearTimeout(to); }
  if (!res.ok) throw statusToError(res.status, redact(raw, cfg), label, res.headers);
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { throw new AiError(`${label} returned something that isn't an API response.`, { kind: 'error' }); }
  const rows = Array.isArray(payload.data) ? payload.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
  if (rows.length !== texts.length) throw new AiError(`${label} returned ${rows.length} vectors for ${texts.length} texts.`, { kind: 'schema', retryable: true });
  const usage = payload.usage || {};
  return { vectors: rows.map((r) => Float32Array.from(r.embedding || [])), usage: { in: usage.prompt_tokens || usage.total_tokens || 0, out: 0 } };
}

// cfg: { provider, embedModel, embedDims, embedInputType, apiKey, baseUrl }
async function embed(cfg, texts, opts) {
  const preset = PRESETS[cfg.provider] || PRESETS.custom;
  const started = Date.now();
  let out;
  if (preset.api === 'demo') out = await require('./demo').embed(cfg, texts);
  else if (preset.api === 'openai') out = await embedOpenAi({ ...preset, ...cfg, local: !!preset.local }, texts, opts);
  else throw new AiError(`${preset.label} does not make embeddings.`, { kind: 'model' });
  out.ms = Date.now() - started;
  out.cost = costOf(cfg.provider, cfg.embedModel, out.usage.in, 0);
  out.costCap = capCostOf(cfg.provider, cfg.embedModel, out.usage.in, 0);
  if (cfg.onUsage) cfg.onUsage(out);
  return out;
}

/* ---------------- public ---------------- */
function bookCompletion(cfg, out, started) {
  if (out.headers) { limits.noteHeaders(cfg.provider, out.headers); delete out.headers; }
  out.ms = Date.now() - started;
  const free = limits.onFreePlan(cfg.provider);
  out.cost = free ? 0 : costOf(cfg.provider, cfg.model, out.usage.in, out.usage.out);
  out.costCap = free ? 0 : capCostOf(cfg.provider, cfg.model, out.usage.in, out.usage.out);
  if (free) out.freePlan = true;
  if (cfg.onUsage) cfg.onUsage(out);
  return out;
}
// cfg: { provider, model, apiKey, baseUrl, jsonSchema }
async function complete(cfg, req) {
  const preset = PRESETS[cfg.provider] || PRESETS.custom;
  const api = preset.api;
  if (api === 'anthropic' && !cfg.apiKey) throw new AiError('No API key has been set.', { kind: 'auth' });

  // A steady pace per provider and model, so free per-minute limits are
  // rarely hit at all; told "too many", the gap widens by itself.
  const lane = cfg.provider + '|' + cfg.model;
  if (api !== 'demo' && !preset.local) await limits.pace(lane, preset.minIntervalMs || 0);
  const started = Date.now();
  // `local` is a property of the provider, not of whatever the caller passed —
  // reading it off cfg let an overridden provider look remote and be handed a key.
  let out;
  try {
    out = api === 'demo' ? await require('./demo').complete(cfg, req)
      : api === 'anthropic' ? await completeAnthropic(cfg, req)
        : await completeOpenAi({ ...preset, ...cfg, local: !!preset.local }, req);
  } catch (e) {
    if (e.paidResponse && e.usage) {
      const spent = bookCompletion(cfg, { usage: e.usage, headers: e.headers, transport: e.transport }, started);
      e.cost = spent.cost; e.costCap = spent.costCap; e.ms = spent.ms;
      e.usageCharged = typeof cfg.onUsage === 'function';
      e.retryable = false;
    }
    if (e && e.kind === 'rate' && !(e.refusal && e.refusal.scope === 'day')) limits.slower(lane);
    throw e;
  }
  limits.faster(lane);
  limits.noteSuccess(cfg.provider, cfg.model);
  // Each paid answer is booked as it arrives, so a document whose third page
  // fails still has its first two on the ledger. Paid OpenAI incomplete/refused
  // replies use the same accounting path above before throwing.
  return bookCompletion(cfg, out, started);
}

module.exports = { complete, transcribe, embed, AiError, parseJson };
