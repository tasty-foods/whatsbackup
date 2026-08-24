'use strict';
// Every provider is one of two shapes: Anthropic's own API, or an
// OpenAI-compatible /chat/completions endpoint — which is what OpenAI, Gemini,
// Ollama, LM Studio, OpenRouter and Groq all speak. So there are two adapters
// and a table of endpoints, not a driver per vendor.
//
// `vision` and `jsonSchema` here are only defaults for the UI. What a given
// model actually honours is decided by probing it (see probe.js) — every
// OpenAI-compatible endpoint lies about at least one of them.

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
  },
  openrouter: {
    label: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    keyHint: 'openrouter.ai/keys — one key, many models',
    models: [],
    defaultModel: '',
    vision: true,
    jsonSchema: true,
  },
  groq: {
    label: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    keyHint: 'console.groq.com',
    models: [],
    defaultModel: '',
    vision: true,
    jsonSchema: true,
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

module.exports = { PRESETS, PRICES, priceFor, costOf, capCostOf };
