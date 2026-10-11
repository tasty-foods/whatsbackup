'use strict';
// Every provider is one of two shapes: Anthropic's own API, or an
// OpenAI-compatible /chat/completions endpoint — which is what OpenAI, Gemini,
// Ollama, LM Studio, OpenRouter and Groq all speak. So there are two adapters
// and a table of endpoints, not a driver per vendor.
//
// `vision` and `jsonSchema` here are only defaults for the UI. What a given
// model actually honours is decided by probing it (see probe.js) — every
// OpenAI-compatible endpoint lies about at least one of them.
//
// `audio` names the speech-to-text model a provider offers on its
// /audio/transcriptions endpoint; `embeddings` the model on /embeddings.
// Neither is a chat model, so each is its own field, and a provider without
// one simply never gets that kind of job — the chain hands it to one that has.

const PRESETS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    api: 'anthropic',
    keyRequired: true,
    keyHint: 'Starts with sk-ant- · console.anthropic.com',
    models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
    defaultModel: 'claude-haiku-4-5',
    vision: true,
    jsonSchema: true,
  },
  openai: {
    label: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    keyHint: 'Starts with sk- · platform.openai.com',
    models: ['gpt-5-mini', 'gpt-5'],
    defaultModel: 'gpt-5-mini',
    vision: true,
    jsonSchema: true,
    audio: { model: 'whisper-1' },
    embeddings: { model: 'text-embedding-3-small', dims: 1536 },
  },
  gemini: {
    label: 'Google Gemini',
    api: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyRequired: true,
    keyHint: 'aistudio.google.com → Get API key',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.5-flash',
    vision: true,
    jsonSchema: true,
    embeddings: { model: 'gemini-embedding-001', dims: 768 },
  },
  nvidia: {
    label: 'NVIDIA (build.nvidia.com)',
    api: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyRequired: true,
    keyHint: 'Starts with nvapi- · build.nvidia.com',
    // The catalogue is large and changes often, so the name is typed rather
    // than picked from a list that would rot. This one is the text-only V4
    // Flash: vision is a separate model, so photographs are skipped unless the
    // model name is changed to a multimodal one — which the probe will detect.
    models: ['deepseek-ai/deepseek-v4-flash-0731'],
    defaultModel: 'deepseek-ai/deepseek-v4-flash-0731',
    vision: false,
    jsonSchema: true,
    embeddings: { model: 'nvidia/nv-embedqa-e5-v5', dims: 1024, inputType: true },
  },
  openrouter: {
    label: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    keyHint: 'openrouter.ai/keys — one key, many models',
    // Checked against the live catalogue on 2026-09-09: of 431 models, these
    // are free and take images. Names go stale — an id that no longer exists
    // is a 404 the chain reads as "wrong model" and benches the provider for
    // six hours, so the menu is worth more than a single hard-coded default.
    models: ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'],
    defaultModel: 'google/gemma-4-31b-it:free',
    vision: true,
    jsonSchema: true,
  },
  groq: {
    label: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    keyHint: 'console.groq.com — 1,000 requests a day',
    // Groq's catalogue lost its vision models and has them back: checked
    // 2026-09-10, the qwen3 pair reads images, the llamas do not. The reading
    // one leads, so a chain that reaches Groq can still sort photographs; the
    // llamas stay on the list because they are quicker on conversations.
    models: ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
    defaultModel: 'qwen/qwen3.8-27b',
    vision: true,
    jsonSchema: true,
    // Whisper on Groq is on the free tier: the one place in the chain that
    // turns a voice note into words at no cost.
    audio: { model: 'whisper-large-v3-turbo' },
  },
  ollama: {
    label: 'Ollama (on this PC)',
    api: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyRequired: false,
    keyHint: 'No key needed — nothing leaves this computer',
    models: [],
    defaultModel: 'llama3.2-vision',
    vision: true,
    jsonSchema: false,
    local: true,
  },
  lmstudio: {
    label: 'LM Studio (on this PC)',
    api: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
    keyHint: 'No key needed — nothing leaves this computer',
    models: [],
    defaultModel: '',
    vision: true,
    jsonSchema: false,
    local: true,
  },
  demo: {
    label: 'Demo mode (no AI, no key, no cost)',
    api: 'demo',
    keyRequired: false,
    keyHint: 'Makes up plausible labels locally so you can see how sorting looks before paying for anything.',
    models: ['demo'],
    defaultModel: 'demo',
    vision: true,
    jsonSchema: true,
    local: true,
    audio: { model: 'demo' },
    embeddings: { model: 'demo', dims: 64 },
  },
  custom: {
    label: 'Anything OpenAI-compatible…',
    api: 'openai',
    baseUrl: '',
    keyRequired: false,
    keyHint: 'Paste the base URL ending in /v1',
    models: [],
    defaultModel: '',
    vision: true,
    jsonSchema: true,
  },
};

// Prices in USD per million tokens. Only what we can state accurately — an
// unknown model reports "cost unknown" rather than a confident wrong number.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus-5': { in: 5, out: 25 },
  'gemini-2.5-flash': { in: 0.30, out: 2.50 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },     // the ≤200k-prompt tier; our calls never exceed it
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5': { in: 1.25, out: 10 },
  'text-embedding-3-small': { in: 0.02, out: 0 },
  'gemini-embedding-001': { in: 0.15, out: 0 },
};

// Speech to text is billed by the minute, not the token.
const AUDIO_PRICES_PER_MIN = {
  'whisper-1': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-large-v3-turbo': 0.000667,    // Groq: $0.04 per hour on the paid tier, free below the daily cap
  'whisper-large-v3': 0.00185,
};

function priceFor(provider, model) {
  if (PRESETS[provider] && PRESETS[provider].local) return { in: 0, out: 0, local: true };
  return PRICES[model] || null;
}

// Cost of one call, or null when the model's pricing isn't known to us.
function costOf(provider, model, tokensIn, tokensOut) {
  const p = priceFor(provider, model);
  if (!p) return null;
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
}

// Used only by the spending cap. Reporting an unknown price as $0 is honest;
// letting the cap treat it as free is not — that would make "unlisted model"
// a way to buy an unlimited budget. Unknown work is counted at the dearest
// rate we know of, so the cap errs towards stopping too early.
const CAP_FALLBACK = { in: 5, out: 25 };

function capCostOf(provider, model, tokensIn, tokensOut) {
  if (PRESETS[provider] && PRESETS[provider].local) return 0;
  const p = PRICES[model] || CAP_FALLBACK;
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
}

function audioCostOf(provider, model, seconds) {
  if (PRESETS[provider] && PRESETS[provider].local) return 0;
  const perMin = AUDIO_PRICES_PER_MIN[model];
  if (perMin == null) return null;
  return (seconds / 60) * perMin;
}
const AUDIO_CAP_PER_MIN = 0.006;
function audioCapCostOf(provider, model, seconds) {
  if (PRESETS[provider] && PRESETS[provider].local) return 0;
  return (seconds / 60) * (AUDIO_PRICES_PER_MIN[model] != null ? AUDIO_PRICES_PER_MIN[model] : AUDIO_CAP_PER_MIN);
}

module.exports = { PRESETS, PRICES, AUDIO_PRICES_PER_MIN, priceFor, costOf, capCostOf, audioCostOf, audioCapCostOf };
