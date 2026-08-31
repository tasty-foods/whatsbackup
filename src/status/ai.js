'use strict';
// The status writer. One call, one short text, through the same provider,
// key and monthly cap as the sorting — a status is not a reason to run a
// second billing system.
//
// Chat-aware context is opt-in and separate from the sorting consent: sorting
// sends chat text to label chats, this would send it to write publicly. The
// two switches are different promises, so they are different settings.
const settings = require('../settings');
const messages = require('../messages');
const aiMod = require('../ai');
const { complete } = require('../ai/provider');
const { costOf, capCostOf } = require('../ai/presets');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', description: 'The status text, ready to post. Plain text.' } },
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fillVars(tpl, now) {
  const d = now || new Date();
  return String(tpl || '')
    .replace(/\{weekday\}/gi, WEEKDAYS[d.getDay()])
    .replace(/\{date\}/gi, d.toLocaleDateString())
    .replace(/\{time\}/gi, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}

// Composes one status text. Throws with a human-readable reason when it can't.
async function composeStatus({ promptOverride } = {}) {
  const s = settings.read();
  const cfg = aiMod.config();
  if (cfg.keyRequired && !aiMod.hasKey()) throw new Error('No AI key is set — add one under Settings → AI sorting.');

  const st = aiMod.status();
  if (st.budget && st.budgetUsed >= st.budget) throw new Error('The monthly AI budget is used up.');

  const userPrompt = fillVars(promptOverride || s.statusAiPrompt || '', new Date()).trim();
  if (!userPrompt) throw new Error('No writing instructions yet — set them in the Status view.');

  let context = '';
  if (s.statusAiChatAware && s.aiConsent) {
    try { context = messages.recentDigest({ hours: 48, limit: 60, chars: 160 }); } catch (_) {}
  }

  const system = 'You write a single WhatsApp status update. Reply with the status text only: '
    + 'plain text, no quotation marks around it, no hashtags unless asked, at most 280 characters. '
    + 'Match the language the instructions are written in.';
  const user = `Instructions:\n${userPrompt}`
    + (context ? `\n\nRecent activity, for context only — never quote a person or name a chat:\n${context}` : '');

  const runId = aiMod.store.startRun('status', cfg.model, cfg.provider);
  let res, err = null;
  try {
    res = await complete(cfg, { system, user, schema: SCHEMA, schemaName: 'status', maxTokens: 400 });
  } catch (e) { err = e; }
  // complete() reports tokens; pricing them is the caller's job, as everywhere.
  const tin = (res && res.usage && res.usage.in) || 0;
  const tout = (res && res.usage && res.usage.out) || 0;
  const cost = costOf(cfg.provider, cfg.model, tin, tout);
  aiMod.store.updateRun(runId, {
    items: 1, ok: err ? 0 : 1, failed: err ? 1 : 0, skipped: 0,
    tokens_in: tin, tokens_out: tout,
    cost_usd: cost == null ? 0 : cost, cost_cap_usd: capCostOf(cfg.provider, cfg.model, tin, tout),
    finished_at: Date.now(), error: err ? err.message : null,
  });
  if (err) throw err;

  const text = (res.json && res.json.text ? String(res.json.text) : String(res.text || '')).trim().slice(0, 300);
  if (!text) throw new Error('The model returned nothing usable.');
  return { text, cost: cost || 0 };
}

module.exports = { composeStatus, fillVars };
