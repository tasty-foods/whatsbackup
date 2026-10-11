'use strict';
// Search by meaning.
//
// Words find what was written; a vector finds what was meant. "broken
// machine" should find the photo labelled "oven with a faulty thermostat"
// and the voice note that says the mixer stopped. Every labelled thing is
// turned into one short text and that text into a vector, stored beside the
// label. A search embeds the question the same way and ranks by cosine —
// in memory, over a few thousand vectors, in a millisecond.
//
// Vectors come from whichever provider in the chain offers an embeddings
// model (Gemini's and OpenAI's are the usual ones). They are only comparable
// within one model, so the store keeps the model name and a search uses the
// one with the most coverage.
const store = require('../store');
const messages = require('../messages');
const ai = require('./store');
const { embed } = require('./provider');

const BATCH = 32;
const QUERY_CACHE = new Map();         // query text -> vector, per model
const QUERY_CACHE_MAX = 200;

// One text per thing. The chat name and month go in front so that "the
// supplier photos from March" works without a filter.
function textFor(kind, refId) {
  if (kind === 'chat') {
    const row = ai.getLabel('chat', refId);
    if (!row || !row.label) return null;
    const name = (messages.listChats().find((c) => c.chatId === refId) || {}).chatName || '';
    return [`chat with ${name}`, ai.labelText(row.label)].filter(Boolean).join('\n');
  }
  if (kind === 'topic') {
    const t = ai.getTopic(refId);
    if (!t) return null;
    const name = (messages.listChats().find((c) => c.chatId === t.chatId) || {}).chatName || '';
    return [`${t.title} (${name}, ${new Date(t.toTs).toISOString().slice(0, 7)})`, t.summary, t.keywords.join(' '), t.decisions.join(' ')].filter(Boolean).join('\n');
  }
  const rec = store.get(refId);
  const row = ai.getLabel(kind, refId);
  if (!rec || !row || !row.label) return null;
  const when = new Date(rec.ts).toISOString().slice(0, 7);
  const head = `${kind} from ${rec.chat || 'unknown'}, ${when}` + (rec.docName ? `, file ${rec.docName}` : '') + (rec.caption ? `, caption: ${String(rec.caption).slice(0, 120)}` : '');
  return [head, ai.labelText(row.label)].filter(Boolean).join('\n').slice(0, 6000);
}

const hashFor = (text, model) => ai.sha1(model + '\n' + text);

// Which labelled things still lack a vector for this model.
function pending(model) {
  const out = [];
  for (const kind of ['image', 'video', 'document', 'audio', 'chat']) {
    for (const row of ai.labelsOfKinds([kind])) {
      const text = textFor(kind, row.refId);
      if (!text) continue;
      if (!ai.hasEmbedding(kind, row.refId, hashFor(text, model))) out.push({ kind, refId: row.refId });
    }
  }
  for (const t of ai.allTopics()) {
    const text = textFor('topic', t.id);
    if (text && !ai.hasEmbedding('topic', t.id, hashFor(text, model))) out.push({ kind: 'topic', refId: t.id });
  }
  return out;
}

// jobs: ai_jobs rows whose ref_id is "<kind>:<refId>". One call for the lot.
async function embedBatch(cfg, jobs) {
  const items = [];
  for (const j of jobs) {
    const i = j.ref_id.indexOf(':');
    const kind = j.ref_id.slice(0, i), refId = j.ref_id.slice(i + 1);
    const text = textFor(kind, refId);
    items.push({ job: j, kind, refId, text });
  }
  const live = items.filter((x) => x.text && !ai.hasEmbedding(x.kind, x.refId, hashFor(x.text, cfg.embedModel)));
  const results = new Map(items.map((x) => [x.job.id, x.text ? { cached: true } : { skipped: 'nothing to embed' }]));
  if (!live.length) return { results, usage: { in: 0, out: 0 }, cost: 0, costCap: 0 };
  const res = await embed(cfg, live.map((x) => x.text), { inputType: 'passage' });
  live.forEach((x, i) => {
    ai.putEmbedding({ kind: x.kind, refId: x.refId, model: cfg.embedModel, contentHash: hashFor(x.text, cfg.embedModel), vec: res.vectors[i] });
    results.set(x.job.id, { done: true });
  });
  return { results, usage: res.usage, cost: res.cost, costCap: res.costCap, embedded: live.length };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// The model to search with: the one most of the library is embedded in.
function bestModel() {
  const rows = ai.embeddingModels();
  return rows.length ? rows[0].model : null;
}

// [{kind, refId, score}], best first. The query is embedded with the given
// cfg (which must use the same model as the vectors) — one small call.
async function search(cfg, query, { limit = 40, minScore = 0.25 } = {}) {
  const model = cfg.embedModel;
  const key = model + '|' + query.toLowerCase().trim();
  let qv = QUERY_CACHE.get(key);
  if (!qv) {
    const res = await embed(cfg, [query], { inputType: 'query' });
    qv = res.vectors[0];
    if (QUERY_CACHE.size >= QUERY_CACHE_MAX) QUERY_CACHE.delete(QUERY_CACHE.keys().next().value);
    QUERY_CACHE.set(key, qv);
  }
  const all = ai.allEmbeddings(model);
  const scored = [];
  for (const e of all) {
    const s = cosine(qv, e.vec);
    if (s >= minScore) scored.push({ kind: e.kind, refId: e.refId, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { textFor, pending, embedBatch, search, bestModel, cosine, BATCH };
