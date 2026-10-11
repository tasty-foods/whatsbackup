'use strict';
// Ask the archive a question.
//
// "What did the supplier say about the delivery date?" is not a search; it is
// a question whose answer is spread over a few messages, a voice note and a
// document. So: search everywhere first, hand the model the best few dozen
// snippets with their source, and have it answer from those alone — naming
// which ones it used, so every claim can be opened and checked.
//
// Only what the search found is sent: no whole chats, no files. The same
// consent that covers the sorting covers this; the same budget counts it.
const messages = require('../messages');
const store = require('../store');
const ai = require('./store');
const search = require('../search');
const { complete } = require('./provider');

const MAX_SNIPPETS = 40;
const SNIPPET_CHARS = 320;

const SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The answer, in plain sentences, in the language of the question. Say plainly when the sources do not settle it.' },
    sources: { type: 'array', items: { type: 'integer' }, description: 'The numbers of the sources the answer rests on, most important first.' },
  },
  required: ['answer', 'sources'],
  additionalProperties: false,
};

const SYSTEM = [
  'You answer a question about a personal and small-business WhatsApp archive, using only the numbered sources you are given.',
  'Each source is a message, a conversation topic, a photo description, a document summary or a voice-note transcript, with its date and chat.',
  'Answer from the sources alone. If they do not contain the answer, say so and say what comes closest.',
  'Be concrete: names, dates, amounts and references exactly as the sources give them.',
  'Reply in the language the question is asked in.',
].join(' ');

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

// Gather: every angle of the search, flattened to numbered lines with a
// handle back to the thing itself.
async function gather(question, semanticCfg) {
  const r = await search.searchAll(question, { limit: 25, semanticCfg, mode: 'any' });
  const items = [];
  const seen = new Set();
  const add = (key, kind, ref, text, meta) => {
    if (!text || seen.has(key)) return;
    seen.add(key);
    items.push({ kind, ref, text: String(text).replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS), ...meta });
  };
  for (const m of r.messages) add('m' + m.id, 'message', { id: m.id, chatId: m.chatId }, (m.snippet || '').replace(/\[\[|\]\]/g, ''), { chat: m.chatName, ts: m.ts, who: m.fromMe ? 'me' : (m.author || m.chatName) });
  for (const t of r.topics) add('t' + t.id, 'topic', { id: t.id, chatId: t.chatId, fromTs: t.fromTs }, `${t.title}: ${t.summary}${t.decisions.length ? ' Decided: ' + t.decisions.join('; ') : ''}`, { chat: t.chatName, ts: t.toTs });
  for (const m of r.media) {
    const kind = m.kind === 'video' ? 'video' : m.kind === 'document' ? 'document' : (m.kind === 'voice' || m.kind === 'audio') ? 'audio' : 'image';
    const row = ai.getLabel(kind, m.id);
    const l = row && row.label;
    if (!l) continue;
    const text = kind === 'audio' ? `voice note: ${l.transcript || l.summary}` : kind === 'document' ? `${l.title}: ${l.summary} ${(l.amounts || []).join(', ')} ${(l.reference_numbers || []).join(', ')} ${l.text_excerpt ? l.text_excerpt.slice(0, 160) : ''}` : `${kind}: ${l.caption}${l.text_in_image ? ' Text in it: ' + l.text_in_image : ''}`;
    add('r' + m.id, kind, { id: m.id, serve: m.serve }, text, { chat: m.chat, ts: m.ts });
  }
  for (const c of r.chats) if (c.summary) add('c' + c.chatId, 'chat', { chatId: c.chatId }, `conversation with ${c.chatName}: ${c.summary}`, { chat: c.chatName, ts: 0 });
  // Topics also bring the messages they span, since the question may hinge
  // on a line that no keyword matched.
  for (const t of r.topics.slice(0, 3)) {
    try {
      const rows = messages.getNewer(t.chatId, t.fromTs, 30).filter((m) => m.ts <= t.toTs && String(m.body || '').trim()).slice(0, 12);
      for (const m of rows) add('m' + m.id, 'message', { id: m.id, chatId: m.chatId }, m.body, { chat: m.chatName, ts: m.ts, who: m.fromMe ? 'me' : (m.authorName || m.chatName) });
    } catch (_) {}
  }
  return { items: items.slice(0, MAX_SNIPPETS), search: r };
}

async function ask(cfg, question, { semanticCfg = null } = {}) {
  const q = String(question || '').trim();
  if (q.length < 3) throw new Error('Ask a longer question.');
  const { items, search: found } = await gather(q, semanticCfg);
  if (!items.length) return { answer: 'Nothing in the archive matches that yet. Try other words, or run the AI sorting so more of it can be searched.', sources: [], searched: found.counts };
  const lines = items.map((it, i) => `${i + 1}. [${it.kind}${it.ts ? ' ' + day(it.ts) : ''}${it.chat ? ' · ' + it.chat : ''}${it.who ? ' · ' + it.who : ''}] ${it.text}`);
  const res = await complete(cfg, {
    system: SYSTEM,
    user: `Question: ${q}\n\nSources:\n${lines.join('\n')}\n\nAnswer the question from these sources.`,
    schema: SCHEMA, schemaName: 'answer', maxTokens: 700,
  });
  try {
    const runId = ai.startRun('ask', cfg.model, cfg.provider);
    ai.updateRun(runId, { items: 1, ok: 1, tokens_in: res.usage.in, tokens_out: res.usage.out, cost_usd: res.cost || 0, cost_cap_usd: res.costCap || 0, finished_at: Date.now() });
  } catch (_) {}
  const used = (Array.isArray(res.json && res.json.sources) ? res.json.sources : []).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= items.length);
  const sources = (used.length ? used : items.slice(0, 5).map((_, i) => i + 1)).map((n) => {
    const it = items[n - 1];
    const rec = it.ref && it.ref.id && it.kind !== 'message' && it.kind !== 'topic' ? store.get(it.ref.id) : null;
    return { n, kind: it.kind, chat: it.chat, ts: it.ts, text: it.text, ref: it.ref, serve: rec ? rec.serve : null };
  });
  return { answer: String((res.json && res.json.answer) || res.text || '').trim(), sources, searched: found.counts, cost: res.cost || 0 };
}

module.exports = { ask, gather };
