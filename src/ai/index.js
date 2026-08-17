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
let apiKey = process.env.WB_AI_KEY || '';
const setKey = (k) => { apiKey = k || ''; };
const hasKey = () => !!apiKey;

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
const noteVisionOk = (c) => { if (visionIsOff(c)) visionOff = null; };

function config() {
  const s = settings.read();
  const preset = PRESETS[s.aiProvider] || PRESETS.demo;
  return {
    provider: s.aiProvider,
    model: s.aiModel || preset.defaultModel,
    baseUrl: (s.aiBaseUrl || preset.baseUrl || '').trim(),
    apiKey,
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
}

/* ---------------- the runner ---------------- */
const recordById = (id) => store.listRecords({}).find((r) => r.id === id) || null;

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
        const r = await runOneJob(cfg, job);
        if (r.skipped) { ai.finishJob(job.id, 'skipped', r.skipped); state.skipped++; }
        else {
          ai.finishJob(job.id, 'done');
          state.done++;
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
          if (e instanceof AiError && (e.kind === 'auth' || e.kind === 'cert' || e.kind === 'model')) {
            state.error = e.message;
            cancelRequested = true;
          }
          // A model that refuses one image refuses all of them. Note it once
          // and let the rest of the photos skip past for free; the chats are
          // text and can still be sorted. Only a rejection of the request
          // itself counts — a wrong model name is a 404 and is handled above,
          // and must not be reported as "this model cannot see".
          if (job.type === 'label_image' && e instanceof AiError && [400, 413, 415, 422].includes(e.status)) {
            noteVisionOff(cfg);
            state.message = 'This model cannot read images — photos were left unsorted. Conversations are unaffected.';
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
          console.log(`[ai] albums: ${r.groups} groups, ${r.coverage}% of items placed${r.note ? ' — ' + r.note : ''}`);
          state.message = r.note || `${r.groups} albums · ${r.coverage}% sorted`;
        }
        if (s.aiAnalyseChats !== false) {
          const r = await arrange.arrange(cfg, 'chat', entriesFor('chat'));
          if (r.cost) state.cost += r.cost;
          if (r.costCap) state.costCap += r.costCap;
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
        const r = await arrange.arrange(cfg, kind, entriesFor(kind));
        if (r.cost) state.cost += r.cost;
        if (r.costCap) state.costCap += r.costCap;
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
  setKey, hasKey, config, status, estimate, census,
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
