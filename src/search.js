'use strict';
// One search, every angle.
//
// A question typed in the box is answered from everywhere at once: the words
// in messages, the words the AI wrote about photos, documents, voice notes
// and chats, the topics, the people, and — when vectors exist — what the
// words mean. The query is also read for what it says about time and kind:
// "invoices from March" is a kind and a month, not two words to match.
const messages = require('./messages');
const store = require('./store');
const ai = require('./ai/store');
const contacts = require('./contacts');

/* ---------------- reading the query ---------------- */
const MONTHS = {
  january: 0, jan: 0, februari: 1, february: 1, feb: 1, march: 2, maart: 2, mar: 2, april: 3, apr: 3, may: 4, mei: 4, june: 5, juni: 5, jun: 5,
  july: 6, juli: 6, jul: 6, august: 7, augustus: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oktober: 9, oct: 9, okt: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};
const KIND_WORDS = [
  [/\b(photos?|pictures?|pics?|images?|foto'?s?|afbeeldingen?)\b/i, 'image'],
  [/\b(videos?|clips?|films?|filmpjes?)\b/i, 'video'],
  [/\b(documents?|pdfs?|files?|documenten|bestanden|invoices?|facturen|factuur|quotes?|offertes?|contracts?|spreadsheets?|excel|word)\b/i, 'document'],
  [/\b(voice ?notes?|voice messages?|audio|spraakberichten?|recordings?|opnames?)\b/i, 'audio'],
];
const DOC_TYPE_WORDS = [[/\b(invoices?|facturen|factuur)\b/i, 'invoice'], [/\b(quotes?|offertes?|quotations?)\b/i, 'quote'], [/\b(contracts?|contracten)\b/i, 'contract'], [/\b(receipts?|bonnetjes?)\b/i, 'receipt']];

function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
const DAY = 86400000;

// Returns { text, from, to, kind, docType, dir, chat } — the words left to
// match, plus whatever filters the sentence carried.
function parseQuery(raw, now = Date.now()) {
  let q = String(raw || '').trim();
  const out = { text: '', from: 0, to: 0, kind: '', docType: '', dir: '', chat: '' };
  const take = (re, fn) => { const m = q.match(re); if (m) { fn(m); q = q.replace(re, ' '); } };
  const today = dayStart(now);
  take(/\b(today|vandaag)\b/i, () => { out.from = today; out.to = today + DAY; });
  take(/\b(yesterday|gisteren)\b/i, () => { out.from = today - DAY; out.to = today; });
  take(/\b(this week|deze week)\b/i, () => { const d = new Date(today); const dow = (d.getDay() + 6) % 7; out.from = today - dow * DAY; out.to = now + 1; });
  take(/\b(last week|vorige week|afgelopen week)\b/i, () => { const d = new Date(today); const dow = (d.getDay() + 6) % 7; out.from = today - dow * DAY - 7 * DAY; out.to = today - dow * DAY; });
  take(/\b(this month|deze maand)\b/i, () => { const d = new Date(now); out.from = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); out.to = now + 1; });
  take(/\b(last month|vorige maand|afgelopen maand)\b/i, () => { const d = new Date(now); out.from = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(); out.to = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); });
  take(/\b(this year|dit jaar)\b/i, () => { out.from = new Date(new Date(now).getFullYear(), 0, 1).getTime(); out.to = now + 1; });
  take(/\b(last|past|afgelopen|laatste)\s+(\d{1,3})\s+(days?|dagen|weeks?|weken|months?|maanden)\b/i, (m) => {
    const n = parseInt(m[2], 10); const unit = /day|dag/i.test(m[3]) ? DAY : /week/i.test(m[3]) ? 7 * DAY : 30 * DAY;
    out.from = today - n * unit; out.to = now + 1;
  });
  // "march 2026", "in march", "2025"
  take(/\b(?:in|from|van|uit|sinds|since)?\s*\b([a-z]{3,9})\s+(\d{4})\b/i, (m) => {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo === undefined) { q += ' ' + m[0]; return; }
    out.from = new Date(+m[2], mo, 1).getTime(); out.to = new Date(+m[2], mo + 1, 1).getTime();
  });
  if (!out.from) take(/\b(?:in|from|van|uit)\s+([a-z]{3,9})\b/i, (m) => {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo === undefined) { q += ' ' + m[0]; return; }
    const y = new Date(now).getFullYear(); const start = new Date(y, mo, 1).getTime();
    const yy = start > now ? y - 1 : y;
    out.from = new Date(yy, mo, 1).getTime(); out.to = new Date(yy, mo + 1, 1).getTime();
  });
  if (!out.from) take(/\b(20\d{2})\b/, (m) => { out.from = new Date(+m[1], 0, 1).getTime(); out.to = new Date(+m[1] + 1, 0, 1).getTime(); });
  for (const [re, kind] of KIND_WORDS) { if (re.test(q)) { out.kind = kind; } }
  for (const [re, t] of DOC_TYPE_WORDS) { if (re.test(q)) { out.docType = t; out.kind = 'document'; } }
  take(/\b(sent|verstuurd|verzonden)\b/i, () => { out.dir = 'out'; });
  take(/\b(received|ontvangen)\b/i, () => { out.dir = 'in'; });
  take(/\b(?:from|with|van|met)\s+@?"?([^"]{2,40})"?$/i, (m) => { out.chat = m[1].trim(); });
  // Kind words are filters, not search terms — unless they are all there is.
  let text = q.replace(/\s+/g, ' ').trim();
  const stripped = text;
  for (const [re] of KIND_WORDS) text = text.replace(re, ' ');
  for (const [re] of DOC_TYPE_WORDS) text = text.replace(re, ' ');
  text = text.replace(/\b(the|a|an|of|de|het|een|my|mijn|all|alle|show|find|zoek|toon|me|about|over)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  out.text = text || (out.kind ? '' : stripped);
  out.docTypeFromText = !!out.docType;
  return out;
}

/* ---------------- running it ---------------- */
const lc = (s) => String(s || '').toLowerCase();
const RE_ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mark(text, q) {
  if (!text) return '';
  const words = q.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
  if (!words.length) return String(text).slice(0, 180);
  const re = new RegExp('(' + words.map(RE_ESC).join('|') + ')', 'ig');
  const s = String(text);
  const i = s.search(re);
  const start = Math.max(0, i - 60);
  const cut = (start ? '…' : '') + s.slice(start, start + 200) + (s.length > start + 200 ? '…' : '');
  return cut.replace(re, '[[$1]]');
}

function matchesFilters(rec, f) {
  if (f.kind && !(f.kind === 'image' ? (rec.kind === 'image' || rec.kind === 'sticker') : f.kind === 'audio' ? (rec.kind === 'voice' || rec.kind === 'audio') : rec.kind === f.kind)) return false;
  if (f.dir && rec.dir !== f.dir) return false;
  if (f.from && rec.ts < f.from) return false;
  if (f.to && rec.ts >= f.to) return false;
  if (f.chat && !lc(rec.chat).includes(lc(f.chat))) return false;
  return true;
}

// The whole answer: { query, filters, media:[], messages:[], chats:[], topics:[], contacts:[], semantic: bool }
// `mode` 'all' wants every word; 'any' (a question) ranks by how many.
async function searchAll(raw, { limit = 30, semanticCfg = null, mode = 'all' } = {}) {
  const f = parseQuery(raw);
  const q = f.text;
  const ql = lc(q);
  const wordsOf = (s) => lc(s).split(' ').filter((w) => w.length >= 2 && (mode !== 'any' || !/^(the|and|for|with|from|that|this|what|when|where|which|will|did|does|was|were|are|how|who|why|can|could|should|would|about|you|your|have|has|had)$/.test(w)));
  const hidden = store.hiddenIds();
  const chatNames = new Map(messages.listChats().map((c) => [c.chatId, c.chatName]));
  const out = { query: raw, text: q, filters: { from: f.from || null, to: f.to || null, kind: f.kind || null, docType: f.docType || null, dir: f.dir || null, chat: f.chat || null },
    media: [], messages: [], chats: [], topics: [], contacts: [], semantic: false };

  // 1. media by their own fields and the AI's words
  const scored = new Map();              // id -> { rec, score, why }
  const bump = (rec, s, why) => {
    if (!rec || hidden.has(rec.id) || rec.sample || !matchesFilters(rec, f)) return;
    const cur = scored.get(rec.id) || { rec, score: 0, why: [] };
    cur.score += s; if (why && !cur.why.includes(why)) cur.why.push(why);
    scored.set(rec.id, cur);
  };
  const labelOf = (rec) => { const kind = rec.kind === 'video' ? 'video' : rec.kind === 'document' ? 'document' : (rec.kind === 'voice' || rec.kind === 'audio') ? 'audio' : 'image'; const r = ai.getLabel(kind, rec.id); return r && r.label; };
  if (ql) {
    const words = wordsOf(ql);
    for (const rec of store.listRecords({})) {
      if (!matchesFilters(rec, f)) continue;
      const own = lc([rec.chat, rec.caption, rec.docName].filter(Boolean).join(' '));
      let hits = 0;
      for (const w of words) if (own.includes(w)) hits++;
      if (hits && (mode === 'any' || hits === words.length || hits >= 2)) bump(rec, hits === words.length ? 3 : 1.2 * hits, hits === words.length ? 'caption or name' : 'partly in caption');
    }
    let labelHits = ai.searchLabels(q, 200, { mode });
    // Every word, or failing that most of them: a search that finds nothing
    // is worse than one that is a little generous.
    if (mode === 'all' && labelHits.length < 3 && words.length > 1) labelHits = labelHits.concat(ai.searchLabels(q, 200, { mode: 'any' }).map((r) => ({ ...r, rank: (r.rank || 0) + 6 })));
    for (const row of labelHits) {
      if (row.kind === 'topic' || row.kind === 'chat') continue;
      const rec = store.get(row.refId);
      if (rec) { const r = scored.get(rec.id); bump(rec, 2.5 - Math.min(2, Math.abs(row.rank || 0) / 20), 'what the AI saw'); if (scored.get(rec.id)) scored.get(rec.id).snippet = scored.get(rec.id).snippet || row.snippet; void r; }
    }
  } else {
    // Filters alone ("photos from March"): everything that fits, newest first.
    for (const rec of store.listRecords({})) bump(rec, 1, 'matches the filter');
  }
  if (f.docType) {
    for (const [id, x] of scored) { const l = labelOf(x.rec); if (!l || l.doc_type !== f.docType) { if (ql) x.score -= 1; else scored.delete(id); } else x.score += 1.5; }
  }
  // 2. by meaning
  if (ql && semanticCfg) {
    try {
      const embedMod = require('./ai/embed');
      const hits = await embedMod.search(semanticCfg, q, { limit: 40, minScore: 0.28 });
      out.semantic = true;
      for (const h of hits) {
        if (h.kind === 'chat' || h.kind === 'topic') continue;
        const rec = store.get(h.refId);
        if (rec) bump(rec, 1.5 + h.score * 2, 'means the same');
      }
      for (const h of hits) if (h.kind === 'topic') { const t = ai.getTopic(h.refId); if (t) out.topics.push({ ...t, chatName: chatNames.get(t.chatId) || '', score: 1 + h.score * 2, why: 'means the same' }); }
      for (const h of hits) if (h.kind === 'chat') out.chats.push({ chatId: h.refId, chatName: chatNames.get(h.refId) || h.refId, score: 1 + h.score * 2, why: 'means the same' });
    } catch (e) { out.semanticError = e.message; }
  }
  const media = [...scored.values()].sort((a, b) => b.score - a.score || b.rec.ts - a.rec.ts).slice(0, limit);
  out.media = media.map((x) => {
    const l = labelOf(x.rec);
    return { id: x.rec.id, kind: x.rec.kind, ts: x.rec.ts, chat: x.rec.chat, dir: x.rec.dir, serve: x.rec.serve, docName: x.rec.docName || '', caption: x.rec.caption || '',
      title: (l && (l.title || l.caption || l.summary)) || '', snippet: x.snippet || (l ? mark(ai.labelText(l), q) : ''), score: Math.round(x.score * 10) / 10, why: x.why.slice(0, 2) };
  });

  // 3. messages, with their chat
  if (ql) {
    let rows = messages.search(q, 60, { mode });
    if (mode === 'all' && rows.length < 3 && wordsOf(ql).length > 1) rows = rows.concat(messages.search(q, 60, { mode: 'any' }).filter((m) => !rows.some((r) => r.id === m.id)));
    out.messages = rows.filter((m) => (!f.from || m.ts >= f.from) && (!f.to || m.ts < f.to) && (!f.chat || lc(m.chatName).includes(lc(f.chat)))).slice(0, limit)
      .map((m) => ({ id: m.id, chatId: m.chatId, chatName: m.chatName, ts: m.ts, fromMe: !!m.fromMe, author: m.authorName || (m.author && !/@/.test(m.author) ? m.author : (m.author ? contacts.resolve(m.author) : null)) || null, snippet: m.snippet || mark(m.body, q), mediaKind: m.mediaKind || null, mediaServe: m.mediaServe || null }));
  }

  // 4. chats by what they are about
  if (ql) {
    const seen = new Set(out.chats.map((c) => c.chatId));
    for (const row of ai.labelsWithGroups(['chat'], 'chat')) {
      const l = row.label || {};
      const hay = lc([chatNames.get(row.refId), l.summary, l.category, (l.topics || []).join(' '), row.groupName].filter(Boolean).join(' '));
      const words = ql.split(' ').filter((w) => w.length >= 2);
      const hits = words.filter((w) => hay.includes(w)).length;
      if (hits && !seen.has(row.refId)) { seen.add(row.refId); out.chats.push({ chatId: row.refId, chatName: chatNames.get(row.refId) || row.refId, summary: l.summary || '', project: row.groupName || null, score: hits === words.length ? 2 : hits, why: 'what the chat is about' }); }
    }
    for (const c of messages.listChats()) {
      if (seen.has(c.chatId)) continue;
      if (lc(c.chatName).includes(ql)) { seen.add(c.chatId); out.chats.push({ chatId: c.chatId, chatName: c.chatName, summary: '', score: 2.5, why: 'name' }); }
    }
    out.chats.sort((a, b) => b.score - a.score);
    out.chats = out.chats.slice(0, 12);
  }

  // 5. topics by their words
  if (ql) {
    const seen = new Set(out.topics.map((t) => t.id));
    let topicHits = ai.searchLabels(q, 60, { mode });
    if (mode === 'all' && !topicHits.some((r) => r.kind === 'topic') && wordsOf(ql).length > 1) topicHits = ai.searchLabels(q, 60, { mode: 'any' });
    for (const row of topicHits) {
      if (row.kind !== 'topic' || seen.has(row.refId)) continue;
      const t = ai.getTopic(row.refId);
      if (!t) continue;
      if (f.from && t.toTs < f.from) continue;
      if (f.to && t.fromTs >= f.to) continue;
      seen.add(t.id);
      out.topics.push({ ...t, chatName: chatNames.get(t.chatId) || '', snippet: row.snippet, score: 2, why: 'topic' });
    }
    out.topics.sort((a, b) => b.score - a.score || b.toTs - a.toTs);
    out.topics = out.topics.slice(0, 12);
  }

  // 6. people
  if (ql && ql.length >= 2) {
    try { out.contacts = messages.searchContacts(q, 8); } catch (_) { out.contacts = []; }
  }
  out.counts = { media: out.media.length, messages: out.messages.length, chats: out.chats.length, topics: out.topics.length, contacts: out.contacts.length };
  return out;
}

module.exports = { parseQuery, searchAll, mark };
