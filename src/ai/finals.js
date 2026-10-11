'use strict';
// Which one to keep.
//
// A designer sends three versions of an advert; a supplier sends a quote,
// then a revised quote; the same photo gets retaken until it is sharp. The
// archive holds all of them, as it should, but somebody still has to say
// which one is the final. This pass finds the sets — versions of one thing,
// from one chat, close in time — and asks the model which to keep, showing
// it the pictures and the messages around them, where the decision was
// usually said out loud ("the second one, the green"). The suggestion is a
// suggestion: a click keeps one, which copies it into a Finals folder and
// marks it. Nothing is deleted or moved.
const fs = require('fs');
const path = require('path');
const cfgApp = require('../config');
const store = require('../store');
const messages = require('../messages');
const ai = require('./store');
const imaging = require('../imaging');
const label = require('./label');
const { complete } = require('./provider');
const { shrink } = require('./shrink');

const WINDOW_MS = 72 * 3600 * 1000;        // versions of one thing arrive within days, not months
const DOC_WINDOW_MS = 21 * 24 * 3600 * 1000;
const MAX_MEMBERS = 6;
const HASH_NEAR = 12;                       // dHash bits apart that still mean "the same design, edited"
const SEND_EDGE = 640;

const SCHEMA = {
  type: 'object',
  properties: {
    same_thing: { type: 'boolean', description: 'True if these really are versions, options or retakes of one thing. False if they are simply different pictures or documents.' },
    best_index: { type: 'integer', description: 'The number of the one to keep as final. 0 if same_thing is false or none can be chosen.' },
    confidence: { type: 'number', description: '0 to 1.' },
    reason: { type: 'string', description: 'One sentence saying why, citing the conversation when it decided it.' },
    ranking: { type: 'array', items: { type: 'integer' }, description: 'All item numbers, best first.' },
  },
  required: ['same_thing', 'best_index', 'confidence', 'reason', 'ranking'],
  additionalProperties: false,
};

const SYSTEM = [
  'You help a small business keep its archive tidy. You are shown a few items from one WhatsApp chat that may be versions, options or retakes of one thing, together with the messages sent around them.',
  'Decide whether they are versions of the same thing, and if so which one is the final — the one the people in the chat chose, or failing that the most complete, latest and best-made one.',
  'What the conversation says outweighs your own taste: if someone picked one, that is the final.',
  'Refer to items by their number. Keep the reason to one sentence.',
].join(' ');

/* ---------------- fingerprints (local, free) ---------------- */
function fpTable() {
  const db = ai.db();
  db.exec(`CREATE TABLE IF NOT EXISTS ai_fingerprints(ref_id TEXT PRIMARY KEY, hash TEXT, width INTEGER, height INTEGER, created_at INTEGER NOT NULL);`);
  return db;
}
async function fingerprintOf(rec) {
  const db = fpTable();
  const row = db.prepare('SELECT hash, width, height FROM ai_fingerprints WHERE ref_id = ?').get(rec.id);
  if (row) return row.hash ? row : null;
  const file = label.fileFor(rec);
  let fp = null;
  if (file && (rec.size || 0) <= 12 * 1024 * 1024) {
    try { fp = await imaging.fingerprint(fs.readFileSync(file)); } catch (_) { fp = null; }
  }
  // A miss is remembered too (empty hash), so an undecodable file is not
  // re-read on every pass; it is retried if the shell appears later.
  if (fp || !imaging.hasShell()) db.prepare('INSERT OR REPLACE INTO ai_fingerprints (ref_id, hash, width, height, created_at) VALUES (?,?,?,?,?)')
    .run(rec.id, fp ? fp.hash : '', fp ? fp.width : 0, fp ? fp.height : 0, Date.now());
  return fp;
}

/* ---------------- detecting sets ---------------- */
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}
const VERSIONY = /\b(v\d+|versie|version|versi[oó]n|optie|option|opt\s?[a-d]\b|variant|concept|draft|final|finale?|definitief|def\b|proef|proof|try|take|retake|new|nieuw|update|revised|rev\d*)\b/i;
const DESIGNY = new Set(['design', 'document', 'screenshot', 'product', 'chart']);
const stem = (name) => norm(String(name || '').replace(/\.[a-z0-9]{1,6}$/i, '')).replace(/\b(v\d+|versie|version|final|definitief|draft|concept|rev\d*|\d{1,2})\b/g, '').trim();

function related(a, b, fa, fb, la, lb) {
  // Byte-near pictures: a re-export, a crop, a colour tweak.
  if (fa && fb && fa.hash && fb.hash && imaging.hammingHex(fa.hash, fb.hash) <= HASH_NEAR) return true;
  const ca = words((a.caption || '') + ' ' + (la && la.caption) + ' ' + (la && la.text_in_image));
  const cb = words((b.caption || '') + ' ' + (lb && lb.caption) + ' ' + (lb && lb.text_in_image));
  const kindA = la && la.kind, kindB = lb && lb.kind;
  // Made things (adverts, labels, screenshots of the same page) that read alike.
  if (DESIGNY.has(kindA) && DESIGNY.has(kindB) && jaccard(ca, cb) >= 0.4) return true;
  // Captions that talk in versions, about the same subject.
  if (VERSIONY.test(a.caption || '') && VERSIONY.test(b.caption || '') && jaccard(words(a.caption), words(b.caption)) >= 0.3) return true;
  if (la && lb && VERSIONY.test(la.version_hint || '') && VERSIONY.test(lb.version_hint || '') && jaccard(ca, cb) >= 0.3) return true;
  return false;
}

// Union-find over a chat's pictures that arrived within the window of each other.
function cluster(items, isRelated) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].rec.ts - items[i].rec.ts > (items[i].windowMs || WINDOW_MS)) break;
      if (isRelated(items[i], items[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()].filter((g) => g.length >= 2);
}

// Every set in the library, as member id arrays with their kind. Local and
// free, apart from fingerprints which are computed once per picture.
async function detectSets({ onlyNew = true } = {}) {
  const hidden = store.hiddenIds();
  const all = store.listRecords({}).filter((r) => !hidden.has(r.id) && !r.sample);
  const byChat = new Map();
  for (const r of all) {
    if (r.kind !== 'image' && r.kind !== 'document') continue;
    const key = r.kind + '|' + (r.source || 'whatsapp') + '|' + (r.chat || '');
    if (!byChat.has(key)) byChat.set(key, []);
    byChat.get(key).push(r);
  }
  const known = onlyNew ? ai.finalSetKeys() : new Set();
  const sets = [];
  for (const [key, recs] of byChat) {
    recs.sort((a, b) => a.ts - b.ts);
    const kind = key.split('|')[0];
    const items = [];
    for (const rec of recs) {
      const lbl = ai.getLabel(kind, rec.id);
      const fp = kind === 'image' ? await fingerprintOf(rec) : null;
      items.push({ rec, label: lbl && lbl.label, fp, windowMs: kind === 'document' ? DOC_WINDOW_MS : WINDOW_MS });
    }
    const groups = kind === 'image'
      ? cluster(items, (x, y) => related(x.rec, y.rec, x.fp, y.fp, x.label, y.label))
      : cluster(items, (x, y) => {
          const sa = stem(x.rec.docName), sb = stem(y.rec.docName);
          if (sa && sb && (sa === sb || jaccard(words(sa), words(sb)) >= 0.6)) return true;
          const ta = x.label && x.label.title, tb = y.label && y.label.title;
          if (ta && tb && jaccard(words(ta), words(tb)) >= 0.6 && (x.label.doc_type === y.label.doc_type)) return true;
          const ra = x.label && x.label.reference_numbers, rb = y.label && y.label.reference_numbers;
          if (ra && rb && ra.length && rb.length && ra.some((n) => rb.includes(n))) return true;
          return false;
        });
    for (const g of groups) {
      const members = g.slice(-MAX_MEMBERS).map((it) => it.rec.id);
      const setKey = ai.setKeyFor(members);
      if (known.has(setKey)) continue;
      sets.push({ setKey, kind, chat: recs[0].chat || '', members });
    }
  }
  return sets;
}

/* ---------------- asking ---------------- */
function contextLines(chatId, fromTs, toTs) {
  if (!chatId) return '';
  const before = messages.around(chatId, fromTs, { before: 4, after: 0 });
  const after = messages.around(chatId, toTs, { before: 0, after: 10 });
  const seen = new Set();
  const rows = [...before, ...after].filter((m) => !seen.has(m.id) && seen.add(m.id) && String(m.body || '').trim());
  return rows.map((m) => `[${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')} ${m.fromMe ? 'me' : (m.authorName || 'them')}] ${String(m.body).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
}

const chatIdFor = (rec) => {
  if (!rec) return null;
  // Record ids carry the chat id between underscores: true_<chat>_<msgid>.
  const m = /^(?:true|false)_([^_]+)_/.exec(String(rec.id || ''));
  if (m) return m[1];
  const c = messages.listChats().find((x) => x.chatName === rec.chat);
  return c ? c.chatId : null;
};

async function judgeSet(cfg, set) {
  const recs = set.members.map((id) => store.get(id)).filter(Boolean);
  if (recs.length < 2) return { skipped: 'set no longer exists' };
  recs.sort((a, b) => a.ts - b.ts);
  const chatId = chatIdFor(recs[0]);
  const context = contextLines(chatId, recs[0].ts, recs[recs.length - 1].ts);
  const lines = [];
  const images = [];
  for (const [i, r] of recs.entries()) {
    const lbl = ai.getLabel(set.kind, r.id);
    const l = lbl && lbl.label;
    const bits = [`${i + 1}. ${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')} ${r.dir === 'out' ? 'sent' : 'received'}`];
    if (r.docName) bits.push(`file "${r.docName}"`);
    if (r.caption) bits.push(`caption: "${String(r.caption).slice(0, 120)}"`);
    if (l && (l.caption || l.title)) bits.push(`looks like: ${l.title || l.caption}`);
    if (l && l.version_hint) bits.push(`version mark: ${l.version_hint}`);
    if (l && l.text_excerpt) bits.push(`text: ${String(l.text_excerpt).replace(/\s+/g, ' ').slice(0, 400)}`);
    if (l && l.text_in_image) bits.push(`text in it: ${String(l.text_in_image).slice(0, 160)}`);
    lines.push(bits.join(' · '));
    if (set.kind === 'image') {
      const file = label.fileFor(r);
      if (file) {
        try {
          const bytes = fs.readFileSync(file);
          const small = await shrink(bytes, SEND_EDGE);
          images.push({ mediaType: small === bytes ? (r.mimetype || 'image/jpeg') : 'image/jpeg', data: small.toString('base64') });
        } catch (_) {}
      }
    }
  }
  const res = await complete(cfg, {
    system: SYSTEM,
    user: `${recs.length} ${set.kind === 'image' ? 'pictures' : 'documents'} from the chat "${set.chat}"${images.length ? ', shown in the same order' : ''}:\n${lines.join('\n')}`
      + (context ? `\n\nmessages around them:\n${context}` : '\n\n(no messages around them were saved)')
      + '\n\nAre these versions of one thing, and which one is the final?',
    images,
    schema: SCHEMA, schemaName: 'final_pick', maxTokens: 400,
  });
  const j = res.json || {};
  const n = recs.length;
  const best = Math.max(0, Math.min(n, parseInt(j.best_index, 10) || 0));
  const ranking = (Array.isArray(j.ranking) ? j.ranking : []).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= n);
  const same = !!j.same_thing && best > 0;
  const id = ai.putFinalSet({
    setKey: set.setKey, kind: set.kind, chat: set.chat, members: recs.map((r) => r.id),
    suggestedId: same ? recs[best - 1].id : null,
    confidence: same ? Math.max(0, Math.min(1, Number(j.confidence) || 0)) : 0,
    reason: String(j.reason || '').slice(0, 300),
    ranking: ranking.map((x) => recs[x - 1].id),
    model: cfg.model, provider: cfg.provider,
  });
  ai.decideFinalSet(id, same ? 'suggested' : 'not_versions', null);
  return { usage: res.usage, cost: res.cost, costCap: res.costCap, same };
}

/* ---------------- keeping ---------------- */
function finalsDirs() {
  const local = path.join(cfgApp.MEDIA_ROOT, 'Finals');
  const cloud = cfgApp.CLOUD_ROOT ? path.join(cfgApp.CLOUD_ROOT, 'Finals') : null;
  return { local, cloud };
}

// A copy, never a move: the item stays in its chat's place; the Finals folder
// is the shelf where the chosen ones also stand.
function keep(refId, { setId } = {}) {
  const rec = store.get(refId);
  if (!rec) throw new Error('no such item');
  const src = label.fileFor(rec);
  if (!src) throw new Error('the file is missing from disk');
  const { local, cloud } = finalsDirs();
  const name = finalName(rec);
  fs.mkdirSync(local, { recursive: true });
  const dst = path.join(local, name);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  let cloudDst = null;
  if (cloud) {
    try {
      let ok = false;
      try { ok = fs.statSync(cfgApp.CLOUD_ROOT).isDirectory(); } catch (_) {}
      if (ok) { fs.mkdirSync(cloud, { recursive: true }); cloudDst = path.join(cloud, name); if (!fs.existsSync(cloudDst)) fs.copyFileSync(src, cloudDst); }
    } catch (_) { cloudDst = null; }
  }
  ai.markFinal(refId, { setId: setId || null, localPath: dst, cloudPath: cloudDst });
  if (setId) ai.decideFinalSet(setId, 'kept', refId);
  return { ok: true, local: dst, cloud: cloudDst };
}

// A readable name on the shelf: the chat, the date, the original name.
function finalName(rec) {
  const d = new Date(rec.ts);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const chat = String(rec.chat || 'unknown').replace(/[^\p{L}\p{N}\-_. ]/gu, '_').trim().slice(0, 40);
  const ext = (/\.([A-Za-z0-9]{1,6})$/.exec(rec.filename) || [, 'bin'])[1];
  // A document keeps its own name; a picture takes its caption, failing that
  // what the AI called it, failing that the id's tail.
  let base = rec.docName ? String(rec.docName) : '';
  if (!base) {
    const lbl = ai.getLabel(rec.kind === 'video' ? 'video' : 'image', rec.id);
    const words = String(rec.caption || (lbl && lbl.label && lbl.label.caption) || '').replace(/[^\p{L}\p{N}\-_ ]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    base = (words || rec.filename.replace(/^.*__/, '').replace(/\.[^.]+$/, '')) + '.' + ext;
  }
  base = base.replace(/[\\/:*?"<>|]/g, '_');
  return `${day} ${chat} - ${base}`.slice(0, 180);
}

function unkeep(refId) {
  const m = ai.finalMark(refId);
  if (!m) return { ok: true, removed: 0 };
  let removed = 0;
  for (const p of [m.local_path, m.cloud_path]) {
    if (!p) continue;
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; } } catch (_) {}
  }
  ai.unmarkFinal(refId);
  if (m.set_id) { const s = ai.getFinalSetById(m.set_id); if (s && s.decidedId === refId) ai.decideFinalSet(m.set_id, 'suggested', null); }
  return { ok: true, removed };
}

function dismiss(setId) { ai.decideFinalSet(setId, 'dismissed', null); return { ok: true }; }
function reopen(setId) { ai.decideFinalSet(setId, 'suggested', null); return { ok: true }; }

// Sets for the dashboard, each member as a small record.
function listSets(status) {
  const marks = new Set(ai.allFinalMarks().map((m) => m.ref_id));
  return ai.listFinalSets(status).filter((s) => s.status !== 'not_versions').map((s) => ({
    ...s,
    members: s.members.map((id) => { const r = store.get(id); return r ? { id, ts: r.ts, kind: r.kind, serve: r.serve, chat: r.chat, caption: r.caption || '', docName: r.docName || '', kept: marks.has(id) } : null; }).filter(Boolean),
  })).filter((s) => s.members.length >= 2);
}

module.exports = { detectSets, judgeSet, keep, unkeep, dismiss, reopen, listSets, finalsDirs, fingerprintOf, related, cluster, stem, WINDOW_MS };
