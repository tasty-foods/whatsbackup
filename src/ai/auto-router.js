'use strict';

// Local task selection only: no API calls, keys, saved settings or queue work.
// Exact aliases and standard prices verified against official model pages:
// https://developers.openai.com/api/docs/guides/model-selection
// https://developers.openai.com/api/docs/models
// An ordered plan is NOT permission to replay a paid/incomplete/refused answer.
const { priceFor, capCostOf } = require('./presets');

const MODELS = Object.freeze({
  'gpt-6-luna': { role: 'routine', label: 'Luna' },
  'gpt-6.1-terra': { role: 'visual', label: 'Terra' },
  'gpt-6.1-sol': { role: 'complex', label: 'Sol' },
  'gpt-5-mini': { role: 'routine', label: 'GPT-5 Mini' },
  'gpt-5': { role: 'complex', label: 'GPT-5' },
});
const NOTICE = 'Auto uses local task rules and known-price models available to this account. Cost headroom is an estimate, not a provider-enforced dollar limit. Do not retry paid failures on a stronger model.';

function number(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function metadata(options) {
  const needs = options.needs && typeof options.needs === 'object' ? options.needs : {};
  const request = options.request && typeof options.request === 'object' ? options.request : {};
  const record = options.record && typeof options.record === 'object' ? options.record : {};
  const task = String(typeof options.task === 'object' ? options.task?.type || options.task?.kind || '' : options.task || '').toLowerCase().replace(/[\s-]+/g, '_');
  const text = [request.system, request.user, request.prompt, request.question, request.input, request.text]
    .filter(value => typeof value === 'string');
  const textLength = text.reduce((sum, value) => sum + value.length, 0);
  const imageCount = Math.max(Array.isArray(request.images) ? request.images.length : 0,
    number(needs.imageCount), number(needs.frameCount), number(record.frameCount), number(request.imageCount));
  const pages = Math.max(number(needs.pageCount), number(needs.pages), number(record.pageCount), number(record.pages), number(request.pageCount));
  const estimatedTextTokens = Math.max(number(needs.estimatedInputTokens), number(request.estimatedInputTokens), number(request.tokensIn), Math.ceil(textLength / 3), 256);
  const inputTokens = estimatedTextTokens + imageCount * 2048;
  const outputTokens = Math.max(16, number(request.maxTokens) || number(request.max_output_tokens) || 512);
  const document = /document|invoice|contract|pdf/.test(task) || record.kind === 'document';
  const scanned = !!(needs.scanned || needs.scan || needs.ocr || needs.needsOcr || needs.needsOCR || record.scanned || record.isScanned || record.documentImage || number(record.scannedPages))
    || /(?:^|_)(?:ocr|scan|scanned)(?:_|$)/.test(task)
    || document && !!needs.needsVision;
  const complexQuestion = /(?:^|_)(?:ask|question|search|answer|archive)(?:_|$)/.test(task)
    && /\b(?:compare|reconcile|contradict\w*|conflict\w*|relationships?|patterns?|trends?|timeline|across|explain why|what changed|differences?|summari[sz]e all)\b/i.test(String(request.question || request.user || ''));
  const complex = !!(needs.complex || needs.difficult || request.complex || record.difficult || record.complex)
    || /(?:^|_)(?:finals?|judge|complex|difficult|reconcile)(?:_|$)/.test(task)
    || textLength >= 16000 || estimatedTextTokens >= 6000 || document && pages >= 8 || complexQuestion;
  const visual = scanned || imageCount > 1 || record.kind === 'video' || /(?:^|_)(?:video|frames?|visual)(?:_|$)/.test(task);
  const specialised = !!(needs.needsAudio || needs.needsEmbeddings || needs.audio || needs.embeddings)
    || /^(?:transcribe_audio|transcription|embed|embeddings?)$/.test(task);
  const role = complex ? 'complex' : visual ? 'visual' : 'routine';
  const why = complex ? complexQuestion ? 'This archive question compares or connects evidence.'
    : /final|judge/.test(task) ? 'Comparing final versions needs more careful reasoning.'
      : 'Long text or a difficult document needs more careful reasoning.'
    : visual ? scanned ? 'Scanned pages need accurate visual reading.' : 'Multiple images or video frames need visual reasoning.'
      : 'Routine extraction, summaries, topics and assignments favour the lower-cost model.';
  return { task, role, why, specialised, inputTokens, outputTokens };
}

function availableModels(models) {
  const available = new Set();
  const today = new Date().toISOString().slice(0, 10);
  for (const item of Array.isArray(models) ? models : []) {
    const id = typeof item === 'string' ? item : item?.id;
    if (!Object.hasOwn(MODELS, id)) continue;
    if (typeof item === 'object' && (item.selectable !== true || item.retired || item.fineTuned
      || item.provider && item.provider !== 'openai'
      || item.shutdown_date && item.shutdown_date < today)) continue;
    const price = priceFor('openai', id);
    if (!price || !Number.isFinite(price.in) || !Number.isFinite(price.out) || price.in < 0 || price.out < 0) continue;
    available.add(id);
  }
  return available;
}

function describePlan(options = {}) {
  const meta = metadata(options);
  const available = availableModels(options.models);
  const suppliedBudget = options.budgetRemaining;
  const remaining = suppliedBudget == null || suppliedBudget === Infinity ? Infinity : Number(suppliedBudget);
  const budgetMode = !Number.isFinite(remaining) && remaining !== Infinity ? 'unknown'
    : remaining <= 0 ? 'exhausted' : remaining < 0.50 ? 'tight' : remaining < 2 ? 'careful' : 'normal';
  const result = { primary: null, role: meta.role, budgetMode, reason: '', candidates: [], notice: NOTICE };
  if (meta.specialised) {
    result.reason = 'Transcription and embeddings use their own specialised model settings; this Auto selector routes chat and image understanding only.';
    return result;
  }
  if (budgetMode === 'exhausted' || budgetMode === 'unknown') {
    result.reason = budgetMode === 'exhausted' ? 'The monthly budget has no remaining headroom. Wait for a reset or change the budget.' : 'The remaining budget is unavailable. Check budget tracking before starting Auto work.';
    return result;
  }
  if (!Array.isArray(options.models) || options.models.length === 0) {
    result.reason = 'No current account catalogue is available. Refresh the OpenAI model list; Auto will not guess access or silently use an unverified model.';
    return result;
  }
  // Legacy alternatives are used only when their preferred family is absent.
  // Snapshots and fine-tuned IDs are deliberately excluded until their own
  // price and compatibility have been verified, even if an alias looks similar.
  const routine = available.has('gpt-6-luna') ? ['gpt-6-luna'] : ['gpt-5-mini'];
  const visual = ['gpt-6.1-terra'];
  const complex = available.has('gpt-6.1-sol') ? ['gpt-6.1-sol'] : ['gpt-5'];
  const ordered = meta.role === 'complex' ? [...complex, ...visual, ...routine]
    : meta.role === 'visual' ? [...visual, ...routine, ...complex] : [...routine, ...visual, ...complex];
  const legacySuppressed = options.manualModel === 'gpt-5-mini' && available.has('gpt-6-luna')
    || options.manualModel === 'gpt-5' && available.has('gpt-6.1-sol');
  if (!legacySuppressed && Object.hasOwn(MODELS, options.manualModel) && available.has(options.manualModel)) ordered.push(options.manualModel);
  for (const id of [...new Set(ordered)]) {
    if (!available.has(id)) continue;
    const model = MODELS[id];
    if (budgetMode === 'tight' && model.role !== 'routine') continue;
    const reasoningRoom = model.role === 'complex' ? 4096 : model.role === 'visual' ? 1024 : id === 'gpt-5-mini' ? 1536 : 256;
    const estimated = capCostOf('openai', id, meta.inputTokens, meta.outputTokens + reasoningRoom);
    // Keep slack for tokenisation, reasoning, image billing and in-flight work.
    // The runner also checks the application ledger before starting work.
    const reserve = Math.max(0.005, estimated * 2);
    if (!Number.isFinite(estimated) || reserve > remaining) continue;
    if (budgetMode === 'careful' && model.role === 'complex' && reserve > remaining * 0.15) continue;
    let reason = model.role === meta.role ? meta.why : `An available ${model.label} alternative for this ${meta.role} task.`;
    if (id === 'gpt-5-mini') reason += ' Luna is unavailable; GPT-5 Mini is the known-price lower-cost alternative.';
    if (id === 'gpt-5') reason += ' Sol is unavailable; GPT-5 is the known-price reasoning alternative.';
    if (budgetMode === 'tight') reason += ' Low remaining budget keeps Auto on a lower-cost model.';
    else if (budgetMode === 'careful') reason += ' Remaining budget headroom is checked before choosing this model.';
    result.candidates.push({ model: id, role: model.role, reason });
  }
  result.primary = result.candidates[0]?.model || null;
  result.reason = result.candidates[0]?.reason || (available.size
    ? 'No available Auto model has enough estimated budget headroom for this request. Reduce the input or wait for a budget reset.'
    : 'This account has no available, selectable model with a verified Auto price. Manual model selection remains separate.');
  return result;
}

function plan(options) { return describePlan(options).candidates; }

module.exports = { plan, describePlan, summary: describePlan, MODELS, NOTICE };
