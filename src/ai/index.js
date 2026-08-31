'use strict';
// The engine-facing surface: configuration, the job runner, and the two passes.
const settings = require('../settings');
const store = require('../store');
const messages = require('../messages');
const cfgApp = require('../config');
const ai = require('./store');
const label = require('./label');
const arrange = require('./arrange');
const { probe } = require('./probe');
const { PRESETS, costOf } = require('./presets');
const { AiError } = require('./provider');

const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

// The key never touches settings.json in the clear and never lands in a log —
// the shell decrypts it and hands it over in memory.
// provider -> key. The shell decrypts and hands these over in memory; the
// plaintext never lands in settings.json, a log, or this repo.
let apiKeys = {};
const setKeys = (map) => { apiKeys = map && typeof map === 'object' ? { ...map } : {}; };
// An older shell sends one key with no provider; attribute it to the configured one.
const setKey = (k) => { const who = settings.read().aiProvider; apiKeys = k && who ? { [who]: k } : {}; };
const keyFor = (who) => apiKeys[who] || '';
const hasKey = (who) => !!keyFor(who || settings.read().aiProvider);

let state = {
  running: false,
  phase: 'idle',          // idle | labelling | arranging
  done: 0, total: 0, failed: 0, skipped: 0,
  cost: 0, costCap: 0, tokensIn: 0, tokensOut: 0,
  message: '',
  error: null,
  startedAt: null,
  runId: null,
};
let cancelRequested = false;

// What the last "Test connection" learned, and what a run learns the hard way.
// Keyed by the exact endpoint, because the answer changes with the model name.
let visionOff = null;                                  // the key it applies to, or null
const visionKey = (c) => `${c.baseUrl}|${c.model}`;
const visionIsOff = (c) => visionOff === visionKey(c);
const noteVisionOff = (c) => { visionOff = visionKey(c); };
const noteVisionOk = (c) => { if (visionIsOff(c)) visionOff = null; imageRejects = 0; };
let imageRejects = 0;                                 // consecutive image rejections, reset by any success

// The chain: the configured provider first, then each fallback that has a key.
// A provider that just refused work is benched, so the runner walks past it
// instead of asking again every single item.
const benched = new Map();                 // provider -> ms timestamp it may be used again
const REST_AFTER_LIMIT = 45 * 60 * 1000;   // a quota usually frees up long before this
const REST_AFTER_REFUSAL = 6 * 60 * 60 * 1000;
const REST_AFTER_DOWN = 3 * 60 * 1000;      // long enough to finish on someone else, short enough to come back

const benchProvider = (who, ms, why) => {
  if (!who) return;
  benched.set(who, Date.now() + ms);
  console.warn(`[ai] ${who} set aside for ${Math.round(ms / 60000)} min — ${why}`);
};
const isBenched = (who) => (benched.get(who) || 0) > Date.now();

function chainProviders() {
  const s = settings.read();
  const first = s.aiProvider;
  if (!s.aiChainEnabled) return [first];
  const rest = (s.aiChain || []).filter((x) => x && x !== first);
  return [first, ...rest];
}

// The next provider that could actually do this job: has a key if it needs one,
// isn't benched, and — for a photograph — hasn't already told us it can't see.
function pickProvider({ needsVision } = {}) {
  const order = chainProviders();
  for (const who of order) {
    if (!who) continue;
    const c = configFor(who);
    if (c.keyRequired && !hasKey(who)) continue;
    if (!c.model) continue;                 // nothing to ask for
    if (isBenched(who)) continue;
    if (needsVision && visionIsOff(c)) continue;
    return c;
  }
  return null;
}

function configFor(who) {
  const s = settings.read();
  const preset = PRESETS[who] || PRESETS.custom;
  // Model and address follow the provider: the fields the user typed belong to
  // the provider they were typed for, and a fallback uses its own preset.
  const isCurrent = who === s.aiProvider;
  // A fallback uses its own model: the name typed above belongs to the provider
  // it was typed for, and handing "gemini-2.5-flash" to Groq only earns a 404
  // and a benched provider. Presets without a default need one set explicitly.
  const model = isCurrent
    ? (s.aiModel || preset.defaultModel)
    : ((s.aiChainModels || {})[who] || preset.defaultModel || '');
  return {
    provider: who,
    model,
    baseUrl: ((isCurrent && s.aiBaseUrl) || preset.baseUrl || '').trim(),
    apiKey: keyFor(who),
    jsonSchema: s.aiJsonSchema !== false,
    keyRequired: preset.keyRequired,
    local: !!preset.local,
  };
}

function config() {
  const s = settings.read();
  // An unknown or blank provider used to fall back to the demo preset, while
  // provider.js fell back to `custom` for the same value. The two disagreeing
  // was quietly destructive: demo is marked local and needs no key, so the app
  // reported itself configured with no key set, called itself a local model,
  // and sent hundreds of real requests to a real endpoint under that
  // misapprehension. Same fallback as the dispatcher, so both agree.
  const preset = PRESETS[s.aiProvider] || PRESETS.custom;
  return {
    provider: s.aiProvider,
    model: s.aiModel || preset.defaultModel,
    baseUrl: (s.aiBaseUrl || preset.baseUrl || '').trim(),
    apiKey: keyFor(s.aiProvider),
    jsonSchema: s.aiJsonSchema !== false,
    keyRequired: preset.keyRequired,
    local: !!preset.local,
  };
}

function status() {
  const s = settings.read();
  const counts = ai.jobCounts();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  return {
    enabled: !!s.aiEnabled,
    configured: !!(s.aiProvider && (!config().keyRequired || hasKey())),
    provider: s.aiProvider,
    model: config().model,
    consent: !!s.aiConsent,
    mode: s.aiMode || 'assist',
    analyseImages: s.aiAnalyseImages !== false,
    analyseChats: s.aiAnalyseChats !== false,
    ...state,
    jobs: counts,
    spendThisMonth: ai.spendSince(monthStart.getTime()),
    // What the cap is actually counting — the same number unless a model with
    // no published price was used, in which case it is the dearest-rate guess.
    budgetUsed: ai.spendCapSince(monthStart.getTime()),
    budget: s.aiMonthlyBudget || 0,
    groups: { media: ai.listGroups('media').length, chat: ai.listGroups('chat').length },
    lastRun: ai.lastRun(),
    chainEnabled: !!s.aiChainEnabled,
    chain: chainProviders().filter(Boolean).map((who) => {
      const c = configFor(who);
      const until = benched.get(who) || 0;
      return {
        provider: who,
        model: c.model,
        hasKey: !hasKey(who) ? false : true,
        keyRequired: !!c.keyRequired,
        needsModel: !c.model,
        editableModel: who !== s.aiProvider,
        restingUntil: until > Date.now() ? until : null,
        blind: visionIsOff(c),
      };
    }),
  };
}

// What a full pass would cost, before a penny is spent. Token figures come from
// measured shapes: ~1.1k in / 200 out per image, ~1.6k in / 150 out per chat.
function estimate() {
  const s = settings.read();
  const c = census();
  const cfg = config();
  const imgTodo = c.images.todo;
  const vidTodo = c.videos.todo;
  const chatTodo = c.chats.todo;

  const tokensIn = imgTodo * 1100 + vidTodo * 300 + chatTodo * 1600 + 14000;   // + the arrange calls
  const tokensOut = imgTodo * 200 + vidTodo * 150 + chatTodo * 150 + 5000;
  const cost = costOf(cfg.provider, cfg.model, tokensIn, tokensOut);

  return {
    census: c,
    todo: { images: imgTodo, videos: vidTodo, chats: chatTodo },
    tokensIn, tokensOut,
    cost,
    costKnown: cost !== null,
    model: cfg.model,
    provider: cfg.provider,
    analyseImages: s.aiAnalyseImages !== false,
    analyseChats: s.aiAnalyseChats !== false,
  };
}

const census = () => label.census({
  analyseImages: settings.read().aiAnalyseImages !== false,
  analyseChats: settings.read().aiAnalyseChats !== false,
});

/* ---------------- queueing ---------------- */
function queueBacklog() {
  const s = settings.read();
  let queued = 0;
  if (s.aiAnalyseImages !== false) {
    // Same walk the estimate uses, so what gets queued is exactly what was priced.
    label.eachCandidate((rec, kind, reason) => {
      if (reason) return;
      if (ai.getLabel(kind, rec.id)) return;
      ai.enqueue(kind === 'video' ? 'label_video' : 'label_image', rec.id);
      queued++;
    });
  }
  if (s.aiAnalyseChats !== false) {
    const withText = messages.chatsWithText();
    for (const c of messages.listChats()) {
      if (!withText.has(c.chatId)) continue;      // nothing to read, nothing to charge for
      if (ai.getLabel('chat', c.chatId)) continue;
      ai.enqueue('label_chat', c.chatId);
      queued++;
    }
  }
  return queued;
}

// Called by the capture path when something new arrives.
function noteNewMedia(rec) {
  const s = settings.read();
  if (!s.aiEnabled || !s.aiConsent || s.aiMode === 'manual') return;
  if (s.aiAnalyseImages === false) return;
  if (rec.kind === 'video') ai.enqueue('label_video', rec.id);
  else if (!label.skipReason(rec, null)) ai.enqueue('label_image', rec.id);
  kick();
}

function noteNewMessages(chatId) {
  const s = settings.read();
  if (!s.aiEnabled || !s.aiConsent || s.aiMode === 'manual') return;
  if (s.aiAnalyseChats === false) return;
  ai.enqueue('label_chat', chatId);
  kick();                     // as noteNewMedia does; otherwise it waits for the 60s timer
}

/* ---------------- the runner ---------------- */
// store keeps an id map; listRecords() copies, filters and re-sorts the whole
// library, and this runs once per queued item.
const recordById = (id) => store.get(id);

// Runs one job against the chain: the first provider that can take it, then
// the next if that one refuses for a reason another provider might not share.
// Errors that are about the item rather than the provider (a corrupt file, a
// reply that isn't JSON) are not worth walking the chain for, and are thrown.
async function runJobOnChain(job) {
  const needsVision = job.type === 'label_image';
  const tried = [];
  for (;;) {
    const cfg = pickProvider({ needsVision });
    if (!cfg) {
      if (!tried.length) throw new AiError('No provider is available — every one is out of quota or missing a key.', { kind: 'auth' });
      return { skipped: 'no provider left that can do this (' + tried.join(', ') + ' unavailable)' };
    }
    if (tried.includes(cfg.provider)) return { skipped: 'no provider left to try' };
    tried.push(cfg.provider);
    try {
      const r = await runOneJob(cfg, job);
      return { ...r, provider: cfg.provider };
    } catch (e) {
      const status = e instanceof AiError ? e.status : 0;
      const kind = e instanceof AiError ? e.kind : '';
      if (status === 429 || kind === 'rate') { benchProvider(cfg.provider, REST_AFTER_LIMIT, 'out of quota'); continue; }
      if (kind === 'auth' || status === 401 || status === 403) { benchProvider(cfg.provider, REST_AFTER_REFUSAL, 'key refused'); continue; }
      if (kind === 'model' || status === 404) { benchProvider(cfg.provider, REST_AFTER_REFUSAL, 'model not found there'); continue; }
      // Nothing answering. A local model that isn't running would otherwise
      // fail every item three times over before anyone noticed, so step past it
      // and look again shortly — it may just be starting up.
      if (kind === 'down') { benchProvider(cfg.provider, REST_AFTER_DOWN, 'not running'); continue; }
      // About the item rather than the provider. Say who was asked, so a
      // refusal can be pinned on the right one further up.
      try { e.provider = cfg.provider; } catch (_) {}
      throw e;
    }
  }
}

async function runOneJob(cfg, job) {
  if (job.type === 'label_image') {
    if (visionIsOff(cfg)) return { skipped: 'this model cannot read images' };
    const rec = recordById(job.ref_id);
    if (!rec) return { skipped: 'record no longer exists' };
    return label.labelImage(cfg, rec);
  }
  if (job.type === 'label_video') {
    const rec = recordById(job.ref_id);
    if (!rec) return { skipped: 'record no longer exists' };
    return label.labelVideo(cfg, rec);
  }
  if (job.type === 'label_chat') {
    const chat = messages.listChats().find((c) => c.chatId === job.ref_id);
    if (!chat) return { skipped: 'chat no longer exists' };
    return label.labelChat(cfg, chat);
  }
  return { skipped: 'unknown job type' };
}

// The cap has to bite even when the model has no published price, or picking an
// unlisted model would quietly buy an unlimited budget. Unpriced work is
// charged against the cap at the dearest rate we know; what gets *reported* as
// spent stays honest and only counts what we can actually price.
function budgetExceeded() {
  const s = settings.read();
  if (!s.aiMonthlyBudget) return false;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  return ai.spendCapSince(monthStart.getTime()) + Math.max(state.cost, state.costCap) >= s.aiMonthlyBudget;
}

async function drainQueue(cfg) {
  state.phase = 'labelling';
  for (;;) {
    if (cancelRequested) return 'cancelled';
    if (budgetExceeded()) return 'budget';
    const batch = ai.claim(CONCURRENCY);
    if (!batch.length) return 'done';

    await Promise.all(batch.map(async (job) => {
      try {
        const r = await runJobOnChain(job);
        if (r.skipped) { ai.finishJob(job.id, 'skipped', r.skipped); state.skipped++; }
        else {
          ai.finishJob(job.id, 'done');
          state.done++;
          if (job.type === 'label_image') imageRejects = 0;
          if (r.usage) { state.tokensIn += r.usage.in; state.tokensOut += r.usage.out; }
          if (r.cost) state.cost += r.cost;
          if (r.costCap) state.costCap += r.costCap;
        }
      } catch (e) {
        const retryable = e instanceof AiError ? e.retryable : true;
        if (retryable && job.attempts + 1 < MAX_ATTEMPTS) {
          ai.retryJob(job.id, e.message);
          await new Promise((r) => setTimeout(r, 1500 * (job.attempts + 1)));
        } else {
          ai.finishJob(job.id, 'error', e.message);
          state.failed++;
          // An auth problem, a certificate problem or a model name the service
          // doesn't recognise will fail every remaining item the same way —
          // stop rather than burn the queue down.
          // With a chain, a single provider refusing is not the end of the run:
          // runJobOnChain has already benched it and moved on, and only reaches
          // here when every provider has been tried. Without a chain, one auth
          // or model failure really does mean the rest will fail the same way.
          if (e instanceof AiError && (e.kind === 'auth' || e.kind === 'cert' || e.kind === 'model')) {
            state.error = e.message;
            if (chainProviders().length <= 1) cancelRequested = true;
          }
          // A model that refuses one image refuses all of them. Note it once
          // and let the rest of the photos skip past for free; the chats are
          // text and can still be sorted. Only a rejection of the request
          // itself counts — a wrong model name is a 404 and is handled above,
          // and must not be reported as "this model cannot see".
          if (job.type === 'label_image' && e instanceof AiError && [400, 413, 415, 422].includes(e.status)) {
            // One rejected request may be one bad file — an oversized or oddly
            // encoded image — not a blind model, and must not strand every
            // other photo. Only an error that names the problem, or two
            // rejections in a row with no success between, count as "cannot see".
            imageRejects++;
            if (imageRejects >= 2 || /image|vision|multimodal|media/i.test(e.message || '')) {
              // Pin it on the provider that actually refused, never on the run's
              // starting config: one blind model in a chain must not blindfold
              // the sighted ones behind it.
              noteVisionOff(e.provider ? configFor(e.provider) : cfg);
              state.message = 'A model in the chain cannot read images; photos will go to the next one that can.';
            }
          }
        }
      }
      state.total = state.done + state.failed + state.skipped + ai.jobCounts().queued;
    }));
  }
}

function entriesFor(kind) {
  const out = [];
  if (kind === 'media') {
    const byId = new Map(store.listRecords({}).map((r) => [r.id, r]));
    for (const e of ai.labelsOfKinds(['image', 'video'])) {
      const rec = byId.get(e.refId);
      out.push({ kind: e.kind, refId: e.refId, label: e.label, chat: rec && rec.chat, when: rec ? new Date(rec.ts).toISOString().slice(0, 7) : '' });
    }
  } else {
    const names = new Map(messages.listChats().map((c) => [c.chatId, c.chatName]));
    for (const e of ai.labelsOfKinds(['chat'])) {
      out.push({ kind: 'chat', refId: e.refId, label: e.label, chat: names.get(e.refId) || '', when: '' });
    }
  }
  return out;
}

async function run({ arrangeOnly = false } = {}) {
  if (state.running) return { ok: false, message: 'Already running.' };
  const s = settings.read();
  if (!s.aiEnabled) return { ok: false, message: 'AI sorting is switched off.' };
  if (!s.aiConsent) return { ok: false, message: 'The AI notice has not been accepted yet.' };
  const cfg = config();
  if (cfg.keyRequired && !hasKey()) return { ok: false, message: 'No API key has been set.' };

  cancelRequested = false;
  state = {
    running: true, phase: 'labelling', done: 0, total: 0, failed: 0, skipped: 0,
    cost: 0, costCap: 0, tokensIn: 0, tokensOut: 0, message: '', error: null, startedAt: Date.now(), runId: null,
  };
  state.runId = ai.startRun('full', cfg.model, cfg.provider);

  (async () => {
    try {
      if (!arrangeOnly) {
        const queued = queueBacklog();
        state.total = ai.jobCounts().queued;
        console.log(`[ai] labelling ${state.total} items (${queued} newly queued) with ${cfg.provider}/${cfg.model}`);
        const why = await drainQueue(cfg);
        if (why === 'budget') state.message = 'Stopped: the monthly budget cap was reached.';
        if (why === 'cancelled') state.message = state.error || 'Stopped.';
      }

      // The two arrange calls are the largest of the whole run. Announcing that
      // spending has stopped and then making them would be a lie, and the
      // "just re-arrange" button never goes through drainQueue at all — so the
      // cap is checked here too, not only in the labelling loop.
      if (budgetExceeded()) {
        state.message = 'Stopped: the monthly budget cap was reached.';
      } else if (!cancelRequested) {
        state.phase = 'arranging';
        if (s.aiAnalyseImages !== false) {
          const r = await arrange.arrange(cfg, 'media', entriesFor('media'));
          if (r.cost) state.cost += r.cost;
          if (r.costCap) state.costCap += r.costCap;
          if (r.usage) { state.tokensIn += r.usage.in; state.tokensOut += r.usage.out; }
          console.log(`[ai] albums: ${r.groups} groups, ${r.coverage}% of items placed${r.note ? ' — ' + r.note : ''}`);
          state.message = r.note || `${r.groups} albums · ${r.coverage}% sorted`;
        }
        // The media arrange can itself cross the cap — check again before the
        // second-largest call of the run instead of only before the first.
        if (s.aiAnalyseChats !== false && !budgetExceeded()) {
          const r = await arrange.arrange(cfg, 'chat', entriesFor('chat'));
          if (r.cost) state.cost += r.cost;
          if (r.costCap) state.costCap += r.costCap;
          if (r.usage) { state.tokensIn += r.usage.in; state.tokensOut += r.usage.out; }
          console.log(`[ai] projects: ${r.groups} groups, ${r.coverage}% of chats placed${r.note ? ' — ' + r.note : ''}`);
          state.message += `${state.message ? ' · ' : ''}${r.groups} projects`;
        }
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
    }
  })();

  return { ok: true, started: true };
}

const cancel = () => { cancelRequested = true; return { ok: true }; };

// Background trickle for newly captured items in assist/auto mode.
//
// It takes the same `state.running` lock a manual run does. Without that, a
// drain started by the 60-second timer and a run started by the Sort now button
// would both be reading the queue, and both would rewrite the albums — the
// second one snapshotting the user's manual placements after the first had
// already overwritten them.
let kicking = false;
async function kick() {
  const s = settings.read();
  if (kicking || state.running || !s.aiEnabled || !s.aiConsent || s.aiMode === 'manual') return;
  if (!ai.jobCounts().queued) return;
  const cfg = config();
  if (cfg.keyRequired && !hasKey()) return;
  if (budgetExceeded()) return;
  kicking = true;
  cancelRequested = false;
  state = {
    running: true, phase: 'labelling', done: 0, total: ai.jobCounts().queued, failed: 0, skipped: 0,
    cost: 0, costCap: 0, tokensIn: 0, tokensOut: 0, message: '', error: null, startedAt: Date.now(), runId: null,
  };
  // Background work spends real money, so it gets a real row in the ledger.
  // Left out, a week of automatic labelling would be invisible to both the
  // monthly total and the cap, and wiped by the next manual run.
  const runId = ai.startRun('background', cfg.model, cfg.provider);
  state.runId = runId;
  try {
    await drainQueue(cfg);
    // New items are placed one at a time; a full re-arrange waits until enough
    // of them have piled up that it is worth the call.
    const unplaced = ai.db().prepare(`SELECT l.kind, l.ref_id FROM ai_labels l
      LEFT JOIN ai_group_members m ON m.kind = l.kind AND m.ref_id = l.ref_id
      WHERE m.ref_id IS NULL`).all();
    if (unplaced.length >= 25 && s.aiMode === 'auto' && !budgetExceeded()) {
      state.phase = 'arranging';
      for (const kind of ['media', 'chat']) {
        if (kind === 'media' && s.aiAnalyseImages === false) continue;
        if (kind === 'chat' && s.aiAnalyseChats === false) continue;
        if (budgetExceeded()) break;
        const r = await arrange.arrange(cfg, kind, entriesFor(kind));
        if (r.cost) state.cost += r.cost;
        if (r.costCap) state.costCap += r.costCap;
        if (r.usage) { state.tokensIn += r.usage.in; state.tokensOut += r.usage.out; }
      }
    }
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
  }
}

module.exports = {
  setKey, setKeys, hasKey, config, configFor, status, estimate, census, chainProviders,
  run, cancel, kick, queueBacklog, noteNewMedia, noteNewMessages,
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
    if (r.vision && r.vision.ok) noteVisionOk(cfg); else if (r.reachable && r.reachable.ok) noteVisionOff(cfg);
    return r;
  },
  entriesFor,
  store: ai, arrange, PRESETS,
};
