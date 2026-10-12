'use strict';
// The engine-facing surface: configuration, the job runner, and the passes.
//
// Work is a queue of small jobs — label this photo, read this document,
// transcribe this voice note, read the next stretch of this chat into topics,
// embed these labels, judge this set of versions — drained a few at a time
// against a chain of providers. Then the arrange passes group what was
// learned into albums, projects and themes. Everything is cached by content,
// so a second run over the same library costs nothing. A run can be paused
// and resumed, narrowed to one file, and throttled to leave the PC alone.
const settings = require('../settings');
const store = require('../store');
const messages = require('../messages');
const ai = require('./store');
const label = require('./label');
const arrange = require('./arrange');
const { probe } = require('./probe');
const { PRESETS, costOf, audioCapCostOf } = require('./presets');
const { AiError } = require('./provider');
// Who is resting, for how long, and how fast to ask: see limits.js.
const limits = require('./limits');
const appConfig = require('../config');
try { limits.configure({ file: appConfig && appConfig.DATA_DIR ? appConfig.DATA_DIR + '/ai-rest.json' : null }); } catch (_) {}

// Loaded when first needed, so the runner's own dependencies stay the few
// above and the passes that build on it can be swapped under test.
const topics = () => require('./topics');
const finals = () => require('./finals');
const embedMod = () => require('./embed');
const documents = () => require('../content/documents');

const CONCURRENCY = 3;
// A model on this machine is already using every core for a single request,
// so asking it for three at once splits the same cores and adds contention
// rather than throughput. Remote providers are waiting on a network round
// trip and still want the parallelism.
const LOCAL_CONCURRENCY = 1;
const MAX_ATTEMPTS = 3;

// provider -> key. The shell decrypts and hands these over in memory; the
// plaintext never lands in settings.json, a log, or this repo.
let apiKeys = {};
const setKeys = (map) => {
  const next = map && typeof map === 'object' ? { ...map } : {};
  // A provider whose key changed starts clean: a refused or exhausted key's
  // rests say nothing about the new one. The same key, handed over again at
  // every start, keeps its rests (limits.noteKey compares fingerprints).
  for (const who of new Set([...Object.keys(apiKeys), ...Object.keys(next)])) {
    try { if (limits.noteKey(who, next[who] || '')) console.log(`[ai] ${who}: new key — its rests are cleared`); } catch (_) {}
  }
  apiKeys = next;
};
// An older shell sends one key with no provider; attribute it to the configured one.
const setKey = (k) => { const who = settings.read().aiProvider; apiKeys = k && who ? { [who]: k } : {}; };
const keyFor = (who) => apiKeys[who] || '';
const hasKey = (who) => !!keyFor(who || settings.read().aiProvider);

let state = {
  running: false,
  phase: 'idle',          // idle | labelling | arranging | finals
  done: 0, total: 0, failed: 0, skipped: 0,
  cost: 0, costCap: 0, tokensIn: 0, tokensOut: 0,
  message: '',
  error: null,
  startedAt: null,
  runId: null,
  current: '',            // what the runner is on, for the progress line
};
let cancelRequested = false;

// What the last "Test connection" learned, and what a run learns the hard way.
// Keyed by the exact endpoint, because the answer changes with the model name.
// One entry per endpoint and model: with fallback models in the chain, more
// than one of them can be found blind.
const visionOff = new Set();
const visionKey = (c) => `${c.baseUrl}|${c.model}`;
const visionIsOff = (c) => visionOff.has(visionKey(c));
const noteVisionOff = (c) => { visionOff.add(visionKey(c)); };
const noteVisionOk = (c) => { visionOff.delete(visionKey(c)); imageRejects = 0; };
let imageRejects = 0;                                 // consecutive image rejections, reset by any success
// The same for speech and vectors: a provider that answered 404 to its
// audio or embeddings endpoint is not asked again this session.
const capOff = new Set();                             // "provider|audio" / "provider|embed"

// The chain: the configured provider first, then each fallback that has a
// key, and within each provider its chosen model first, then the preset's
// other models that can do the job. A model or provider that just refused work
// rests for as long as the refusal says (limits.js), so the runner walks past
// it instead of asking again every single item.

function chainProviders() {
  const s = settings.read();
  const first = s.aiProvider;
  if (!s.aiChainEnabled) return [first];
  const rest = (s.aiChain || []).filter((x) => x && x !== first);
  return [first, ...rest];
}

// The next provider that could actually do this job: has a key if it needs one,
// isn't benched, and has the ability the job needs — eyes for a photograph,
// ears for a voice note, an embeddings model for vectors.
//
// Free tiers count per model at Gemini and Groq, so a second model of the same
// provider is a second allowance, not a second try at the same one.
function candidates(needs = {}) {
  const out = [];
  for (const who of chainProviders()) {
    if (!who) continue;
    const base = configFor(who);
    if (base.keyRequired && !hasKey(who)) continue;
    const fb = (PRESETS[who] && PRESETS[who].fallbacks) || {};
    const extra = (needs.needsAudio || needs.needsEmbed) ? []
      : needs.needsVision ? (fb.vision || []) : (fb.text || fb.vision || []);
    const models = [base.model, ...extra].filter((m, i, a) => m && a.indexOf(m) === i);
    for (const model of models) out.push(model === base.model ? base : { ...base, model, fallback: true });
  }
  return out;
}
// Embeddings and speech have their own model; that is the one that rests.
const restModelOf = (c, needs) => (needs.needsEmbed ? c.embedModel : needs.needsAudio ? c.audioModel : c.model);
function able(c, needs) {
  if (needs.needsVision && visionIsOff(c)) return false;
  if (needs.needsAudio && (!c.audioModel || capOff.has(c.provider + '|audio'))) return false;
  if (needs.needsEmbed && (!c.embedModel || capOff.has(c.provider + '|embed'))) return false;
  return true;
}
function pickProvider(needs = {}) {
  const now = Date.now();
  for (const c of candidates(needs)) {
    if (!able(c, needs)) continue;
    if (limits.restingUntil(c.provider, restModelOf(c, needs)) > now) continue;
    return { ...c, restModel: restModelOf(c, needs) };
  }
  return null;
}
// When nothing can take a job right now: the soonest something will, or null
// when nothing in the chain could do it even then (no key, no such ability).
function nextAvailable(needs = {}) {
  let best = null;
  for (const c of candidates(needs)) {
    if (!able(c, needs)) continue;
    const m = restModelOf(c, needs);
    const r = limits.restOf(c.provider, m);
    if (!best || r.until < best.until) best = { until: r.until, provider: c.provider, model: m, why: r.why };
  }
  return best;
}
const clock = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
function waitMessage(next) {
  if (!next) return 'No provider in the AI chain has a working key yet. Add one in AI settings; the queue is kept.';
  const tomorrow = new Date(next.until).toDateString() !== new Date().toDateString();
  return `Waiting for free AI quota — ${next.provider} is back around ${clock(next.until)}${tomorrow ? ' tomorrow' : ''} (${next.why}). Nothing is lost; the queue resumes by itself.`;
}
function waitError(next) {
  const e = new AiError(waitMessage(next), { kind: 'wait', retryable: true });
  e.until = next ? next.until : Date.now() + 15 * 60 * 1000;
  return e;
}
// A model name saved for one provider that plainly belongs to another (an
// OpenRouter "vendor/model:free" under Anthropic, say) would fail every call;
// such a name is ignored in favour of the provider's own default.
function foreignModel(who, m) {
  if (!m) return false;
  if (who === 'anthropic') return !/^claude/i.test(m);
  if (who === 'gemini') return !/^(models\/)?(gemini|gemma|learnlm)/i.test(m);
  if (who === 'openai') return /[/:]/.test(m);
  return false;
}

function configFor(who) {
  const s = settings.read();
  const preset = PRESETS[who] || PRESETS.custom;
  // Model and address follow the provider: the fields the user typed belong to
  // the provider they were typed for, and a fallback uses its own preset.
  const isCurrent = who === s.aiProvider;
  let model = isCurrent
    ? (s.aiModel || preset.defaultModel)
    : ((s.aiChainModels || {})[who] || preset.defaultModel || '');
  if (foreignModel(who, model)) model = preset.defaultModel || '';
  return {
    provider: who,
    model,
    baseUrl: ((isCurrent && s.aiBaseUrl) || preset.baseUrl || '').trim(),
    apiKey: keyFor(who),
    jsonSchema: s.aiJsonSchema !== false,
    keyRequired: preset.keyRequired,
    local: !!preset.local,
    audioModel: preset.audio ? preset.audio.model : '',
    embedModel: preset.embeddings ? preset.embeddings.model : '',
    embedDims: preset.embeddings ? preset.embeddings.dims : 0,
    embedInputType: !!(preset.embeddings && preset.embeddings.inputType),
  };
}

function config() {
  const s = settings.read();
  return configFor(s.aiProvider);
}

// What the chain can do, all told — the settings pane says it in words.
function capabilities() {
  const out = { vision: false, audio: false, embeddings: false, audioBy: null, embeddingsBy: null };
  for (const who of chainProviders()) {
    if (!who) continue;
    const c = configFor(who);
    if (c.keyRequired && !hasKey(who)) continue;
    if (!visionIsOff(c)) out.vision = true;
    if (c.audioModel && !capOff.has(who + '|audio') && !out.audio) { out.audio = true; out.audioBy = who; }
    if (c.embedModel && !capOff.has(who + '|embed') && !out.embeddings) { out.embeddings = true; out.embeddingsBy = who; }
  }
  return out;
}

function status() {
  const s = settings.read();
  const counts = ai.jobCounts();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const cap = capabilities();
  let localDocuments = { running: false };
  try { localDocuments = documents().status(); } catch (_) {}
  return {
    enabled: !!s.aiEnabled,
    configured: !!(s.aiProvider && (!config().keyRequired || hasKey())),
    provider: s.aiProvider,
    model: config().model,
    consent: !!s.aiConsent,
    mode: s.aiMode || 'assist',
    paused: !!s.aiPaused,
    localDocuments,
    coverage: census(),
    analyseImages: s.aiAnalyseImages !== false,
    analyseChats: s.aiAnalyseChats !== false,
    analyseVideos: s.aiAnalyseVideos !== false,
    analyseDocuments: s.aiAnalyseDocuments !== false,
    transcribeAudio: !!s.aiTranscribeAudio,
    topics: s.aiTopics !== false,
    embeddings: s.aiEmbeddings !== false,
    finals: s.aiFinals !== false,
    capabilities: cap,
    ...state,
    jobs: counts,
    queuedByType: ai.queuedByType(),
    spendThisMonth: ai.spendSince(monthStart.getTime()),
    // What the cap is actually counting — the same number unless a model with
    // no published price was used, in which case it is the dearest-rate guess.
    budgetUsed: ai.spendCapSince(monthStart.getTime()),
    budget: s.aiMonthlyBudget || 0,
    groups: { media: ai.listGroups('media').length, chat: ai.listGroups('chat').length, topic: ai.listGroups('topic').length },
    counts: {
      labels: { image: ai.labelCount('image'), video: ai.labelCount('video'), document: ai.labelCount('document'), audio: ai.labelCount('audio'), chat: ai.labelCount('chat') },
      topics: ai.topicCount(),
      embeddings: ai.embeddingCount(),
      finalsSuggested: ai.listFinalSets('suggested').length,
      finalsKept: ai.allFinalMarks().length,
    },
    lastRun: ai.lastRun(),
    chainEnabled: !!s.aiChainEnabled,
    chain: chainProviders().filter(Boolean).map((who) => {
      const c = configFor(who);
      const rest = limits.restOf(who, c.model);
      const until = rest.until;
      const fb = (PRESETS[who] && PRESETS[who].fallbacks) || {};
      const models = [c.model, ...(fb.vision || []), ...(fb.text || [])].filter((m, i, a) => m && a.indexOf(m) === i).map((m) => {
        const r = limits.restOf(who, m);
        return { model: m, restingUntil: r.until > Date.now() ? r.until : null, why: r.until > Date.now() ? r.why : '' };
      });
      return {
        restWhy: until > Date.now() ? rest.why : '',
        models,
        provider: who,
        model: c.model,
        hasKey: !hasKey(who) ? false : true,
        keyRequired: !!c.keyRequired,
        needsModel: !c.model,
        editableModel: who !== s.aiProvider,
        restingUntil: until > Date.now() ? until : null,
        blind: visionIsOff(c),
        audio: !!c.audioModel && !capOff.has(who + '|audio'),
        audioModel: c.audioModel || '',
        embeddings: !!c.embedModel && !capOff.has(who + '|embed'),
        embedModel: c.embedModel || '',
      };
    }),
  };
}

// What a full pass would cost, before a penny is spent. Token figures come from
// measured shapes: ~1.6k in / 800 out per detailed photo, ~1.1k in per video
// frame, ~1.6k in per scanned page plus ~2.5k for a document's facts, ~1.6k
// in / 150 out per chat, ~3.2k in / 450 out per stretch of conversation.
function estimate() {
  const s = settings.read();
  const c = census();
  const cfg = config();
  const cap = capabilities();
  const imgTodo = c.images.todo;
  const vidTodo = c.videos.todo;
  const docTodo = c.documents.todo;
  const audTodo = c.audio ? c.audio.todo : 0;
  const chatTodo = c.chats.todo;

  let topicWindows = 0;
  if (s.aiTopics !== false) {
    try {
      const withText = messages.chatsWithText();
      for (const ch of messages.listChats()) if (withText.has(ch.chatId)) topicWindows += topics().pendingWindows(ch.chatId);
    } catch (_) {}
  }
  let embedTodo = 0;
  if (s.aiEmbeddings !== false && cap.embeddings) {
    const e = configFor(cap.embeddingsBy);
    try { embedTodo = embedMod().pending(e.embedModel).length; } catch (_) {}
  }
  let finalsTodo = 0;
  try { finalsTodo = s.aiFinals !== false ? ai.listFinalSets('pending').length : 0; } catch (_) {}

  const frames = s.aiVideoFrames || 6, ocr = s.aiOcrPages || 4;
  const tokensIn = imgTodo * 1600 + vidTodo * frames * 1100 + docTodo * (ocr * 1600 + 2500) + chatTodo * 1600
    + topicWindows * 3200 + embedTodo * 250 + finalsTodo * 2800 + 14000;   // + the arrange calls
  const tokensOut = imgTodo * 800 + vidTodo * 1600 + docTodo * (ocr * 1600 + 300) + chatTodo * 150
    + topicWindows * 450 + finalsTodo * 120 + 5000;
  const cost = costOf(cfg.provider, cfg.model, tokensIn, tokensOut);
  // Audio is by the minute, on the provider that transcribes, and only when
  // asked for. The bytes say roughly how long it is.
  let audioSeconds = 0, audioCost = null;
  if (s.aiTranscribeAudio && cap.audio && c.audio) {
    audioSeconds = Math.round((c.audio.bytes || 0) / 2500 * (audTodo / Math.max(1, c.audio.count)));
    const a = configFor(cap.audioBy);
    audioCost = require('./presets').audioCostOf(a.provider, a.audioModel, audioSeconds);
    if (audioCost == null) audioCost = audioCapCostOf(a.provider, a.audioModel, audioSeconds);
  }

  return {
    census: c,
    todo: { images: imgTodo, videos: vidTodo, documents: docTodo, audio: s.aiTranscribeAudio ? audTodo : 0, chats: chatTodo, topicWindows, embeddings: embedTodo, finals: finalsTodo },
    tokensIn, tokensOut,
    cost,
    costKnown: cost !== null,
    audioSeconds, audioCost, audioBy: cap.audioBy, embeddingsBy: cap.embeddingsBy,
    model: cfg.model,
    provider: cfg.provider,
    analyseImages: s.aiAnalyseImages !== false,
    analyseChats: s.aiAnalyseChats !== false,
    analyseVideos: s.aiAnalyseVideos !== false,
    analyseDocuments: s.aiAnalyseDocuments !== false,
    transcribeAudio: !!s.aiTranscribeAudio && cap.audio,
    audioUnavailable: !!s.aiTranscribeAudio && !cap.audio,
    embeddingsUnavailable: s.aiEmbeddings !== false && !cap.embeddings,
  };
}

// The census walks every record and every label; the dashboard asks for it
// every few seconds. Cached until a label changes or the library grows.
let censusCache = null;
const census = () => {
  const s = settings.read();
  const options = { analyseImages: s.aiAnalyseImages !== false, analyseVideos: s.aiAnalyseVideos !== false, analyseDocuments: s.aiAnalyseDocuments !== false, analyseChats: s.aiAnalyseChats !== false, transcribeAudio: !!s.aiTranscribeAudio };
  const key = `${ai.revision()}:${store.listRecords({}).length}:${JSON.stringify(options)}:${s.aiVideoFrames}:${s.aiDocumentPages}:${s.aiOcrPages}`;
  if (!censusCache || censusCache.key !== key || Date.now() - censusCache.at > 10000) censusCache = { key, at: Date.now(), value: label.census(options) };
  return censusCache.value;
};

/* ---------------- queueing ---------------- */
const JOB_FOR_KIND = { image: 'label_image', video: 'label_video', document: 'label_document', audio: 'transcribe_audio' };
const MEDIA_JOBS = ['label_image', 'label_video', 'label_document', 'transcribe_audio'];
const kindOn = (s, kind) => kind === 'image' ? s.aiAnalyseImages !== false : kind === 'video' ? s.aiAnalyseVideos !== false : kind === 'document' ? s.aiAnalyseDocuments !== false : kind === 'audio' ? !!s.aiTranscribeAudio : true;

function queueBacklog(ids, { includeChats = true } = {}) {
  const s = settings.read();
  const jobs = [];
  // Same walk the estimate uses, so what gets queued is exactly what was priced.
  label.eachCandidate((rec, kind, reason) => {
    if (reason) return;
    if (ids && !ids.has(rec.id)) return;
    if (!kindOn(s, kind)) return;
    if (label.currentLabel(ai.getLabel(kind, rec.id), s)) return;
    jobs.push({ type: JOB_FOR_KIND[kind], refId: rec.id });
  });
  if (!ids && includeChats && (s.aiAnalyseChats !== false || s.aiTopics !== false)) {
    const withText = messages.chatsWithText();
    for (const c of messages.listChats()) {
      if (!withText.has(c.chatId)) continue;      // nothing to read, nothing to charge for
      if (s.aiAnalyseChats !== false && !ai.getLabel('chat', c.chatId)) jobs.push({ type: 'label_chat', refId: c.chatId });
      if (s.aiTopics !== false) { try { if (topics().pendingWindows(c.chatId) > 0) jobs.push({ type: 'topics_chat', refId: c.chatId }); } catch (_) {} }
    }
  }
  ai.enqueueMany(jobs);
  return jobs.length;
}

// After the labels: what can only be queued once something is known — sets
// of versions, and vectors for search by meaning.
async function queueSecondPass() {
  const s = settings.read();
  const cap = capabilities();
  let queued = 0;
  if (s.aiFinals !== false) {
    try {
      const sets = await finals().detectSets({ onlyNew: true });
      for (const set of sets) {
        ai.putFinalSet({ ...set, status: 'pending' });
        ai.enqueue('finals_set', set.setKey); queued++;
      }
      // Sets found earlier and never judged (a run that stopped) come back too.
      for (const set of ai.listFinalSets('pending')) ai.enqueue('finals_set', set.setKey);
    } catch (e) { console.warn('[ai] finals detection failed:', e.message); }
  }
  if (s.aiEmbeddings !== false && cap.embeddings) {
    const e = configFor(cap.embeddingsBy);
    try { for (const p of embedMod().pending(e.embedModel)) { ai.enqueue('embed', p.kind + ':' + p.refId); queued++; } } catch (err) { console.warn('[ai] embedding census failed:', err.message); }
  }
  return queued;
}

// Called by the capture path when something new arrives.
function noteNewMedia(rec) {
  const s = settings.read();
  if (!s.aiEnabled || !s.aiConsent || s.aiPaused || s.aiMode === 'manual') return;
  const kind = label.kindOf(rec);
  if (!kindOn(s, kind)) return;
  if (kind === 'image' && label.skipReason(rec)) return;
  ai.enqueue(JOB_FOR_KIND[kind], rec.id);
  kick();
}

function noteNewMessages(chatId) {
  const s = settings.read();
  if (!s.aiEnabled || !s.aiConsent || s.aiPaused || s.aiMode === 'manual') return;
  if (s.aiAnalyseChats !== false) ai.enqueue('label_chat', chatId);
  if (s.aiTopics !== false) ai.enqueue('topics_chat', chatId);
  kick();                     // as noteNewMedia does; otherwise it waits for the 60s timer
}

/* ---------------- the runner ---------------- */
const recordById = (id) => store.get(id);

const needsOf = (job) => {
  if (job.type === 'label_image' || job.type === 'label_video' || job.type === 'label_document') return { needsVision: true };
  if (job.type === 'transcribe_audio') return { needsAudio: true };
  if (job.type === 'embed') return { needsEmbed: true };
  if (job.type === 'finals_set') { const set = ai.getFinalSet(job.ref_id); return { needsVision: !!set && set.kind === 'image' }; }
  return {};
};

// Runs one job against the chain: the first provider that can take it, then
// the next if that one refuses for a reason another provider might not share.
// Errors that are about the item rather than the provider (a corrupt file, a
// reply that isn't JSON) are not worth walking the chain for, and are thrown.
async function runJobOnChain(job) {
  const needs = needsOf(job);
  const tried = [];
  let slow = 0, lastSlow = null;
  for (;;) {
    const cfg = pickProvider(needs);
    if (!cfg) {
      // Nothing can take it right now. If something could later — a quota
      // that resets, a model that is only busy — that is a wait, not a
      // failure: the job goes back in the queue untouched. Only a job nothing
      // in the chain could ever do is skipped.
      const next = nextAvailable(needs);
      if (!next) {
        if (needs.needsAudio) return { skipped: 'no provider in the chain can transcribe audio (OpenAI or Groq can)' };
        if (needs.needsEmbed) return { skipped: 'no provider in the chain makes embeddings (Gemini or OpenAI can)' };
      }
      throw waitError(next);
    }
    const lane = cfg.provider + '|' + cfg.restModel;
    if (tried.includes(lane)) throw waitError(nextAvailable(needs));
    tried.push(lane);
    // Each timeout costs up to 90 s; after two models have been too slow for
    // this item, it is the item (a long document, say) and it takes its normal
    // retries instead of waiting through every model in the chain.
    if (slow >= 2 && lastSlow) { try { lastSlow.provider = lastSlow.provider || cfg.provider; } catch (_) {} throw lastSlow; }
    try {
      const r = await runOneJob({ ...cfg, onUsage: recordUsage }, job);
      return { ...r, provider: cfg.provider };
    } catch (e) {
      const status = e instanceof AiError ? e.status : 0;
      const kind = e instanceof AiError ? e.kind : '';
      // A missing audio or embeddings endpoint is that provider's gap, not
      // the chain's: note it and let the next one take the job.
      if ((kind === 'model' || status === 404 || status === 400) && (needs.needsAudio || needs.needsEmbed)) {
        capOff.add(cfg.provider + (needs.needsAudio ? '|audio' : '|embed'));
        console.warn(`[ai] ${cfg.provider} cannot ${needs.needsAudio ? 'transcribe audio' : 'make embeddings'} (${e.message}); trying the next provider`);
        continue;
      }
      // Quota, a refused key, no credit, a busy or missing model, answers cut
      // off, nothing listening: the provider's problem, not the item's. It
      // rests for as long as its refusal says, and the next one is asked.
      if (kind === 'timeout') { slow++; lastSlow = e; }
      if (limits.restAfter(e, cfg)) continue;
      // About the item rather than the provider. Say who was asked, so a
      // refusal can be pinned on the right one further up.
      try { e.provider = cfg.provider; e.cfgUsed = cfg; } catch (_) {}
      throw e;
    }
  }
}

async function runOneJob(cfg, job) {
  const s = settings.read();
  const off = { label_image: 'image', label_video: 'video', label_document: 'document', transcribe_audio: 'audio' }[job.type];
  if (off && !kindOn(s, off)) return { skipped: 'This content type is switched off in AI settings.' };
  if (job.type === 'label_chat' && s.aiAnalyseChats === false) return { skipped: 'This content type is switched off in AI settings.' };
  if (job.type === 'topics_chat' && s.aiTopics === false) return { skipped: 'Topics are switched off in AI settings.' };
  if (job.type === 'label_image') {
    if (visionIsOff(cfg)) return { skipped: 'this model cannot read images' };
    const rec = recordById(job.ref_id);
    if (!rec) return { skipped: 'record no longer exists' };
    state.current = 'photo from ' + (rec.chat || '');
    return label.labelImage(cfg, rec);
  }
  if (job.type === 'label_video') {
    const rec = recordById(job.ref_id);
    if (!rec) return { skipped: 'record no longer exists' };
    state.current = 'video from ' + (rec.chat || '');
    return label.labelVideo(cfg, rec);
  }
  if (job.type === 'label_document') {
    const rec = recordById(job.ref_id);
    if (!rec) return { skipped: 'record no longer exists' };
    state.current = 'document ' + (rec.docName || '');
    return label.labelDocument(cfg, rec);
  }
  if (job.type === 'transcribe_audio') {
    const rec = recordById(job.ref_id);
    if (!rec) return { skipped: 'record no longer exists' };
    state.current = 'voice note from ' + (rec.chat || '');
    return label.labelAudio(cfg, rec);
  }
  if (job.type === 'label_chat') {
    const chat = messages.listChats().find((c) => c.chatId === job.ref_id);
    if (!chat) return { skipped: 'chat no longer exists' };
    state.current = 'chat ' + (chat.chatName || '');
    return label.labelChat(cfg, chat);
  }
  if (job.type === 'topics_chat') {
    const chat = messages.listChats().find((c) => c.chatId === job.ref_id);
    if (!chat) return { skipped: 'chat no longer exists' };
    state.current = 'topics in ' + (chat.chatName || '');
    return topics().extractTopics(cfg, job.ref_id, { chatName: chat.chatName });
  }
  if (job.type === 'finals_set') {
    const set = ai.getFinalSet(job.ref_id);
    if (!set) return { skipped: 'set no longer exists' };
    if (set.status !== 'pending') return { cached: true };
    state.current = 'versions in ' + (set.chat || '');
    return finals().judgeSet(cfg, set);
  }
  return { skipped: 'unknown job type' };
}

// Each paid response is booked as it arrives — including the pages of a
// document that later fails — so a restart cannot reset the budget.
function recordUsage(r) {
  if (r.usage) { state.tokensIn += r.usage.in || 0; state.tokensOut += r.usage.out || 0; }
  state.cost += r.cost || 0;
  state.costCap += r.costCap || 0;
  if (state.runId) ai.updateRun(state.runId, { tokens_in: state.tokensIn, tokens_out: state.tokensOut, cost_usd: state.cost, cost_cap_usd: state.costCap });
}

// The cap has to bite even when the model has no published price, or picking an
// unlisted model would quietly buy an unlimited budget. Unpriced work is
// charged against the cap at the dearest rate we know; what gets *reported* as
// spent stays honest and only counts what we can actually price.
function budgetExceeded() {
  const s = settings.read();
  if (!s.aiMonthlyBudget) return false;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  return ai.spendCapSince(monthStart.getTime(), state.running ? state.runId : -1) + Math.max(state.cost, state.costCap) >= s.aiMonthlyBudget;
}

const persistRun = () => { if (state.runId) ai.updateRun(state.runId, { items: state.done + state.failed + state.skipped, ok: state.done, failed: state.failed, skipped: state.skipped, tokens_in: state.tokensIn, tokens_out: state.tokensOut, cost_usd: state.cost, cost_cap_usd: state.costCap }); };
const stopAsked = () => cancelRequested || settings.read().aiPaused || !settings.read().aiEnabled || !settings.read().aiConsent;

// Everyone is resting: keep the queue, say when work resumes, and sleep in
// short steps so Pause still works. Returns false if a stop was asked for.
async function waitForQuota(until, message) {
  state.phase = 'waiting';
  state.waitingUntil = until;
  state.message = message;
  state.current = '';
  console.log('[ai] ' + message);
  persistRun();
  const seen = limits.changes();
  while (Date.now() < until) {
    if (stopAsked()) { state.waitingUntil = null; return false; }
    if (limits.changes() !== seen) break;          // a rest was lifted (a new key, say): look again now
    await new Promise((r) => setTimeout(r, Math.max(50, Math.min(1000, until - Date.now()))));
  }
  state.phase = 'labelling';
  state.waitingUntil = null;
  state.message = '';
  return true;
}

async function drainQueue(cfg, selection = {}) {
  state.phase = 'labelling';
  for (;;) {
    if (stopAsked()) return 'cancelled';
    if (budgetExceeded()) return 'budget';
    const profile = settings.read().performanceMode;
    const width = cfg && cfg.local ? LOCAL_CONCURRENCY : profile === 'fast' ? CONCURRENCY : profile === 'balanced' ? 2 : 1;
    let batch = ai.claim(width, selection);
    if (!batch.length) return 'done';

    // Vectors go in one call for many items; take the whole run of them and
    // hand back anything else that was claimed alongside.
    if (batch[0].type === 'embed') {
      ai.releaseJobs(batch.filter((j) => j.type !== 'embed').map((j) => j.id));
      batch = batch.filter((j) => j.type === 'embed');
      batch = batch.concat(ai.claimType('embed', embedMod().BATCH - batch.length));
      state.current = 'embedding ' + batch.length + ' items';
      const who = pickProvider({ needsEmbed: true });
      const later = who ? null : nextAvailable({ needsEmbed: true });
      if (!who && later) {
        ai.releaseJobs(batch.map((j) => j.id));
        if (!(await waitForQuota(later.until, waitMessage(later)))) return 'cancelled';
        continue;
      }
      if (!who) {
        for (const j of batch) { ai.finishJob(j.id, 'skipped', 'no provider in the chain makes embeddings'); state.skipped++; }
      } else {
        try {
          const r = await embedMod().embedBatch({ ...who, onUsage: recordUsage }, batch);
          for (const j of batch) {
            const out = r.results.get(j.id) || { skipped: 'nothing to embed' };
            if (out.skipped) { ai.finishJob(j.id, 'skipped', out.skipped); state.skipped++; }
            else { ai.finishJob(j.id, 'done'); state.done++; }
          }
        } catch (e) {
          const kind = e instanceof AiError ? e.kind : '';
          if (kind === 'model' || e.status === 404 || e.status === 400) capOff.add(who.provider + '|embed');
          else if (limits.restAfter(e, who)) { ai.releaseJobs(batch.map((j) => j.id)); continue; }
          for (const j of batch) {
            if ((e instanceof AiError ? e.retryable : true) && j.attempts + 1 < MAX_ATTEMPTS) ai.retryJob(j.id, e.message);
            else { ai.finishJob(j.id, 'error', e.message); state.failed++; }
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      state.total = state.done + state.failed + state.skipped + ai.jobCounts().queued;
      persistRun();
      continue;
    }

    let waitUntil = 0, waitWhy = '';
    await Promise.all(batch.map(async (job) => {
      try {
        const r = await runJobOnChain(job);
        if (r.skipped) { ai.finishJob(job.id, 'skipped', r.skipped); state.skipped++; }
        else {
          ai.finishJob(job.id, 'done');
          state.done++;
          if (job.type === 'label_image') imageRejects = 0;
        }
      } catch (e) {
        // Everyone resting: back in the queue as it was, no attempt spent.
        if (e instanceof AiError && e.kind === 'wait') {
          ai.releaseJobs([job.id]);
          if (!waitUntil || e.until < waitUntil) { waitUntil = e.until; waitWhy = e.message; }
          return;
        }
        const retryable = e instanceof AiError ? e.retryable : true;
        if (retryable && job.attempts + 1 < MAX_ATTEMPTS) {
          ai.retryJob(job.id, e.message);
          await new Promise((r) => setTimeout(r, 1500 * (job.attempts + 1)));
        } else {
          ai.finishJob(job.id, 'error', e.message);
          state.failed++;
          // An auth problem, a certificate problem or a model name the service
          // doesn't recognise will fail every remaining item the same way —
          // stop rather than burn the queue down. With a chain, a single
          // provider refusing is not the end of the run: runJobOnChain has
          // already benched it and moved on, and only reaches here when every
          // provider has been tried.
          if (e instanceof AiError && (e.kind === 'auth' || e.kind === 'cert' || e.kind === 'model')) {
            state.error = e.message;
            if (chainProviders().length <= 1) cancelRequested = true;
          }
          // A model that refuses one image refuses all of them. Only a
          // rejection of the request itself counts — a wrong model name is a
          // 404 and is handled above. One rejected request may be one bad
          // file, so two in a row, or an error that names the problem, is
          // what counts as "cannot see".
          if ((job.type === 'label_image' || job.type === 'label_video') && e instanceof AiError && [400, 413, 415, 422].includes(e.status)) {
            imageRejects++;
            if (imageRejects >= 2 || /image|vision|multimodal|media/i.test(e.message || '')) {
              noteVisionOff(e.cfgUsed || (e.provider ? configFor(e.provider) : cfg));
              state.message = 'A model in the chain cannot read images; photos will go to the next one that can.';
            }
          }
        }
      }
      state.total = state.done + state.failed + state.skipped + ai.jobCounts().queued;
    }));
    // Persist completed work during long runs; a restart must not reset the budget.
    persistRun();
    if (waitUntil) {
      if (!(await waitForQuota(waitUntil, waitWhy))) return 'cancelled';
      continue;
    }
    // Give capture, search and UI requests a turn between batches.
    await new Promise((resolve) => setTimeout(resolve, settings.read().performanceMode === 'quiet' ? 250 : 20));
  }
}

function entriesFor(kind) {
  const out = [];
  if (kind === 'media') {
    const byId = new Map(store.listRecords({}).map((r) => [r.id, r]));
    for (const e of ai.labelsOfKinds(['image', 'video', 'document', 'audio'])) {
      const rec = byId.get(e.refId);
      if (!rec) continue;
      out.push({ kind: e.kind, refId: e.refId, label: e.label, chat: rec.chat, when: new Date(rec.ts).toISOString().slice(0, 7) });
    }
  } else if (kind === 'topic') {
    return topics().entries();
  } else {
    const names = new Map(messages.listChats().map((c) => [c.chatId, c.chatName]));
    for (const e of ai.labelsOfKinds(['chat'])) {
      out.push({ kind: 'chat', refId: e.refId, label: e.label, chat: names.get(e.refId) || '', when: '' });
    }
  }
  return out;
}

async function arrangeAll(cfg, s) {
  const notes = [];
  const passes = [
    ['media', s.aiAnalyseImages !== false || s.aiAnalyseDocuments !== false || s.aiAnalyseVideos !== false, 'albums'],
    ['chat', s.aiAnalyseChats !== false, 'projects'],
    ['topic', s.aiTopics !== false, 'themes'],
  ];
  for (const [kind, on, word] of passes) {
    if (!on || stopAsked()) continue;
    // Each arrange is among the largest calls of the run; the cap is checked
    // before every one, not only before the first.
    if (budgetExceeded()) { state.message = 'Stopped: the monthly budget cap was reached.'; break; }
    state.phase = 'arranging';
    state.current = word;
    const r = await arrange.arrange({ ...cfg, onUsage: recordUsage }, kind, entriesFor(kind));
    console.log(`[ai] ${word}: ${r.groups} groups, ${r.coverage || 0}% of items placed${r.note ? ' — ' + r.note : ''}`);
    notes.push(r.note || `${r.groups} ${word}`);
  }
  return notes.join(' · ');
}

async function run({ arrangeOnly = false, indexOnly = false, ids = null } = {}) {
  requeueStranded();
  try { if (documents().status().running) return { ok: false, message: 'Local document indexing is finishing. Please try again when it completes.' }; } catch (_) {}
  if (state.running) return { ok: false, message: 'Already running.' };
  const s = settings.read();
  if (!s.aiEnabled) return { ok: false, message: 'AI sorting is switched off.' };
  if (!s.aiConsent) return { ok: false, message: 'The AI notice has not been accepted yet.' };
  const cfg = config();
  if (cfg.keyRequired && !hasKey()) return { ok: false, message: 'No API key has been set.' };
  const selection = { ids: ids ? new Set(ids) : null, types: indexOnly || ids ? MEDIA_JOBS : null };

  cancelRequested = false;
  settings.write({ aiPaused: false });
  state = {
    running: true, phase: 'labelling', done: 0, total: 0, failed: 0, skipped: 0,
    cost: 0, costCap: 0, tokensIn: 0, tokensOut: 0, message: '', error: null, startedAt: Date.now(), runId: null, current: '',
  };
  state.runId = ai.startRun('full', cfg.model, cfg.provider);

  (async () => {
    try {
      if (!arrangeOnly) {
        const queued = queueBacklog(selection.ids, { includeChats: !indexOnly });
        state.total = ai.jobCounts().queued;
        console.log(`[ai] reading ${state.total} items (${queued} newly queued) with ${cfg.provider}/${cfg.model}`);
        let why = await drainQueue(cfg, selection);
        if (why === 'done' && !indexOnly && !ids) {
          // What can only be known once the labels are in: sets of versions,
          // and vectors for search by meaning.
          state.phase = 'finals';
          state.current = 'looking for versions of the same thing';
          const more = await queueSecondPass();
          if (more) {
            state.total += more;
            console.log(`[ai] second pass: ${more} items (versions to judge, vectors to make)`);
            why = await drainQueue(cfg, selection);
          }
        }
        if (why === 'budget') state.message = 'Stopped: the monthly budget cap was reached.';
        if (why === 'cancelled') state.message = state.error || 'Paused. Queued work is saved for Resume.';
      }
      if (!indexOnly && !ids) {
        if (!stopAsked() && !budgetExceeded()) state.message = await arrangeAll(cfg, s);
        else if (budgetExceeded()) state.message = 'Stopped: the monthly budget cap was reached.';
      }
    } catch (e) {
      state.error = e.message;
      console.error('[ai] run failed:', e.message);
    } finally {
      ai.updateRun(state.runId, {
        items: state.done + state.failed + state.skipped,
        ok: state.done, failed: state.failed, skipped: state.skipped,
        tokens_in: state.tokensIn, tokens_out: state.tokensOut,
        cost_usd: state.cost, cost_cap_usd: state.costCap,
        finished_at: Date.now(), error: state.error,
      });
      // Clear the run's spend from shared state, exactly as kick() does. Left
      // set, budgetExceeded() would add this run's cost on top of the ledger row
      // it just wrote — double-counting it and wedging the next background kick.
      state.cost = 0; state.costCap = 0; state.tokensIn = 0; state.tokensOut = 0;
      state.running = false;
      state.phase = 'idle';
      state.current = '';
      if (ids && s.aiPaused) settings.write({ aiPaused: true });
    }
  })();

  return { ok: true, started: true };
}

// Pausing finishes the item in hand and keeps the queue for Resume.
const cancel = () => { cancelRequested = true; settings.write({ aiPaused: true }); state.message = 'Paused. The current item finishes; queued work is kept for Resume.'; return { ok: true }; };

// Background trickle for newly captured items in assist/auto mode.
//
// It takes the same `state.running` lock a manual run does. Without that, a
// drain started by the 60-second timer and a run started by the Sort now button
// would both be reading the queue, and both would rewrite the albums — the
// second one snapshotting the user's manual placements after the first had
// already overwritten them.
// "Test every provider": each one in the chain with its own saved key, at its
// own saved address (the same rule as the single test: a key never travels
// anywhere it was not saved for). A pass lifts that provider's rests; a
// refusal is read like any other and rests it for as long as it says.
async function probeChain() {
  const out = [];
  for (const who of chainProviders()) {
    if (!who) continue;
    const base = configFor(who);
    if (base.keyRequired && !hasKey(who)) { out.push({ provider: who, model: base.model, missingKey: true }); continue; }
    // Its first model that is not resting: a spent daily quota is already
    // known, and testing the spare says whether this provider still has work in it.
    // Walk its models the way the runner does: past a spent or missing one to
    // the next, until one answers and reads a photo, or none is left.
    const mine = candidates({ needsVision: true }).filter((x) => x.provider === who);
    let best = null, tried = 0;
    for (const c of mine) {
      if (limits.restingUntil(who, c.model) > Date.now()) continue;
      if (tried++ >= 6) break;
      let r;
      try { r = await probe(c); } catch (e) { r = { reachable: { ok: false, detail: e.message } }; Object.defineProperty(r, 'error', { value: e, enumerable: false }); }
      if (r.visionVerdict === 'yes') noteVisionOk(c); else if (r.visionVerdict === 'no') noteVisionOff(c);
      if (r.reachable && r.reachable.ok) limits.clearWide(who);
      else if (r.error) limits.restAfter(r.error, c);
      if (r.visionError) limits.restAfter(r.visionError, c);
      const rest = limits.restOf(who, c.model);
      const row = {
        provider: who, model: c.model, fallback: !!c.fallback,
        reachable: r.reachable, json: r.json, vision: r.vision, errorKind: r.errorKind || '',
        restingUntil: rest.until > Date.now() ? rest.until : null, why: rest.until > Date.now() ? rest.why : '',
      };
      if (!best || (row.reachable && row.reachable.ok && !(best.reachable && best.reachable.ok))) best = row;
      if (r.visionVerdict === 'yes') { best = row; break; }
      // A refused key or an empty account is the same for every model.
      if (r.error && (r.error.kind === 'auth' || r.error.kind === 'billing')) break;
    }
    if (best) { out.push(best); continue; }
    const soon = mine.map((x) => limits.restOf(who, x.model)).sort((a, b) => a.until - b.until)[0] || { until: 0, why: '' };
    out.push({ provider: who, model: base.model, allResting: true, restingUntil: soon.until || null, why: soon.why });
  }
  return out;
}

let kicking = false;
let secondPassAt = 0;

// Before resting worked, a moment when every provider was out of quota failed
// the whole queue in seconds ("No provider is available…" on 3,288 items on
// 2026-10-12). Those items did nothing wrong; once per start they go back in
// the queue, attempts and all, and now wait properly instead.
let strandedChecked = false;
function requeueStranded() {
  if (strandedChecked) return 0;
  strandedChecked = true;
  try {
    const n = ai.db().prepare(`UPDATE ai_jobs SET state = 'queued', error = NULL, attempts = 0, updated_at = ?
      WHERE state = 'error' AND (error LIKE 'No provider is available%' OR error LIKE 'no provider left%'
        OR error LIKE '%is rate-limiting this key%' OR error LIKE 'Waiting for free AI quota%'
        OR error LIKE '%Thinking level%not supported%')`).run(Date.now()).changes;
    if (n) console.log(`[ai] ${n} item${n === 1 ? '' : 's'} that failed only because every provider was resting ${n === 1 ? 'is' : 'are'} back in the queue`);
    return n;
  } catch (e) { console.warn('[ai] could not requeue stranded items:', e.message); return 0; }
}

async function kick() {
  requeueStranded();
  const s = settings.read();
  let docsBusy = false; try { docsBusy = documents().status().running; } catch (_) {}
  if (kicking || state.running || docsBusy || s.aiPaused || !s.aiEnabled || !s.aiConsent || (s.aiMode === 'manual' && !s.aiResumeOnLaunch)) return;
  // Versions and vectors for what trickled in, at most every ten minutes.
  const wantSecond = s.aiMode !== 'manual' && Date.now() - secondPassAt > 10 * 60 * 1000 && (ai.labelCount('image') + ai.labelCount('document') > 0);
  if (!ai.jobCounts().queued && !wantSecond) return;
  const cfg = config();
  if (cfg.keyRequired && !hasKey()) return;
  if (budgetExceeded()) return;
  kicking = true;
  cancelRequested = false;
  state = {
    running: true, phase: 'labelling', done: 0, total: ai.jobCounts().queued, failed: 0, skipped: 0,
    cost: 0, costCap: 0, tokensIn: 0, tokensOut: 0, message: '', error: null, startedAt: Date.now(), runId: null, current: '',
  };
  // Background work spends real money, so it gets a real row in the ledger.
  const runId = ai.startRun('background', cfg.model, cfg.provider);
  state.runId = runId;
  try {
    let why = await drainQueue(cfg);
    if (why === 'done' && wantSecond) {
      secondPassAt = Date.now();
      const more = await queueSecondPass();
      if (more) { state.total += more; why = await drainQueue(cfg); }
    }
    // New items are placed one at a time; a full re-arrange waits until enough
    // of them have piled up that it is worth the call.
    const unplaced = ai.db().prepare(`SELECT COUNT(*) c FROM ai_labels l
      LEFT JOIN ai_group_members m ON m.kind = l.kind AND m.ref_id = l.ref_id
      WHERE m.ref_id IS NULL`).get().c;
    if (why === 'done' && unplaced >= 25 && s.aiMode === 'auto' && !stopAsked() && !budgetExceeded()) await arrangeAll(cfg, s);
  } catch (e) {
    console.warn('[ai] background pass stopped:', e.message);
  } finally {
    ai.updateRun(runId, {
      items: state.done + state.failed + state.skipped,
      ok: state.done, failed: state.failed, skipped: state.skipped,
      tokens_in: state.tokensIn, tokens_out: state.tokensOut,
      cost_usd: state.cost, cost_cap_usd: state.costCap, finished_at: Date.now(),
    });
    state.cost = 0; state.costCap = 0; state.tokensIn = 0; state.tokensOut = 0;
    kicking = false;
    state.running = false;
    state.phase = 'idle';
    state.current = '';
  }
}

// One text call for the search box ("interpret with AI"), on whichever
// provider will take it, booked on the ledger like everything else.
let searching = false;
async function searchCompletion(request) {
  const s = settings.read();
  if (!s.aiEnabled || !s.aiConsent) throw new Error('Enable AI and accept its notice in Settings to interpret natural language.');
  if (searching) throw new Error('Another AI search is finishing.');
  if (budgetExceeded()) throw new Error('The monthly AI budget is reached.');
  searching = true;
  const tried = new Set();
  try {
    for (;;) {
      const cfg = pickProvider();
      if (!cfg) {
        const next = nextAvailable({});
        throw new Error(next ? `Every AI provider is resting — ${next.provider} is back around ${clock(next.until)} (${next.why}). Searching on this PC still works.` : 'No configured AI provider is available. Check AI settings.');
      }
      const lane = cfg.provider + '|' + cfg.restModel;
      if (tried.has(lane)) throw new Error('No configured AI provider is available. Check AI settings.');
      tried.add(lane);
      try {
        const r = await require('./provider').complete(cfg, request);
        const id = ai.startRun('search', cfg.model, cfg.provider);
        ai.updateRun(id, { items: 1, ok: 1, tokens_in: r.usage.in, tokens_out: r.usage.out, cost_usd: r.cost || 0, cost_cap_usd: r.costCap || 0, finished_at: Date.now() });
        return r;
      } catch (e) {
        if (limits.restAfter(e, cfg)) continue;
        throw e;
      }
    }
  } finally { searching = false; }
}

// A configuration for the provider that can embed, for searches.
function embedConfig() {
  const cap = capabilities();
  if (!cap.embeddings) return null;
  const c = configFor(cap.embeddingsBy);
  // Searches must use the model the library is embedded in.
  const model = embedMod().bestModel();
  if (model && model !== c.embedModel) {
    const who = chainProviders().find((w) => w && configFor(w).embedModel === model && (!configFor(w).keyRequired || hasKey(w)));
    return who ? configFor(who) : null;
  }
  return c;
}

module.exports = {
  setKey, setKeys, hasKey, config, configFor, status, estimate, census, chainProviders, capabilities, embedConfig, pickProvider,
  run, cancel, kick, queueBacklog, queueSecondPass, noteNewMedia, noteNewMessages, requeueStranded, nextAvailable, probeChain, limits,
  // Testing the connection is also how the runner finds out whether it may
  // send photos at all — a probe here saves a queue of doomed calls later.
  //
  // The saved key is only ever sent to the saved address. A caller that wants
  // to test a different endpoint has to supply its own key, so no request can
  // talk this into posting the user's Anthropic key at an address it chose.
  probe: async (override) => {
    const saved = config();
    const o = override || {};
    const elsewhere = (o.baseUrl && o.baseUrl !== saved.baseUrl) || (o.provider && o.provider !== saved.provider);
    const cfg = {
      ...saved,
      ...(o.provider ? { provider: o.provider } : {}),
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      ...(o.model ? { model: o.model } : {}),
      apiKey: elsewhere ? (o.key || '') : saved.apiKey,
    };
    const r = await probe(cfg);
    if (r.visionVerdict === 'yes') noteVisionOk(cfg); else if (r.visionVerdict === 'no') noteVisionOff(cfg);
    if (!elsewhere) {
      if (r.error) limits.restAfter(r.error, cfg); else if (r.visionError) limits.restAfter(r.visionError, cfg);
    }
    return r;
  },
  entriesFor, searchCompletion,
  store: ai, arrange, PRESETS,
  get topics() { return topics(); }, get finals() { return finals(); }, get embed() { return embedMod(); },
};
