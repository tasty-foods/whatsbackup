'use strict';
// Demo mode: answers the same call shapes as a real provider, deterministically
// and for free. It exists so the whole pipeline — queue, costs, albums,
// topics, finals, transcripts, search, the UI — can be exercised and verified
// before anyone pays for a key, and so a user can see what sorting looks like
// before deciding.
//
// It reads only what a real call would see (the caption text, the chat name,
// the extracted document text), so its guesses are plausible without
// pretending to be intelligent.
const crypto = require('crypto');

const pick = (seed, list) => list[parseInt(crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8), 16) % list.length];
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 3);
const STOP = new Set(['this', 'that', 'with', 'from', 'about', 'photo', 'chat', 'called', 'sent', 'received', 'owner', 'describe', 'caption', 'messages', 'oldest', 'first', 'video', 'frames', 'shown', 'order', 'text', 'file', 'name', 'page', 'pages', 'part', 'only', 'message', 'with', 'these', 'which', 'versions', 'thing', 'final', 'pictures', 'documents', 'around', 'them', 'same', 'list', 'topics', 'continue', 'earlier', 'found', 'already', 'matter', 'look', 'like', 'looks']);
const keywords = (s, n = 4) => { const out = []; for (const w of words(s)) if (!STOP.has(w) && !out.includes(w)) out.push(w); return out.slice(0, n); };

const SCENES = ['workshop', 'delivery van', 'office desk', 'shop floor', 'kitchen', 'outdoors'];
const SUBJECTS = [['machine', 'panel'], ['boxes', 'pallet'], ['document', 'paperwork'], ['food', 'packaging'], ['person', 'tools']];
const TAGS = [['equipment', 'repair'], ['delivery', 'logistics'], ['invoice', 'admin'], ['product', 'stock'], ['team', 'onsite']];
const CATEGORIES = ['work', 'logistics', 'admin', 'product', 'personal'];
const KINDS = ['photo', 'design', 'screenshot', 'product', 'photo'];

function labelImage(seed, user) {
  const hint = (user.match(/caption:\s*(.+)/i) || [])[1] || '';
  const subjects = pick(seed + 'sub', SUBJECTS);
  const designy = /advert|design|flyer|poster|logo|version|versie|optie|option/i.test(hint);
  return {
    caption: hint ? `A picture of ${hint.replace(/[.,]+$/, '')}.` : `A photo showing ${subjects.join(' and ')}.`,
    subjects: hint ? keywords(hint, 3).concat(subjects).slice(0, 4) : subjects,
    scene: pick(seed + 'scene', SCENES),
    text_in_image: designy ? hint.toUpperCase().slice(0, 60) : '',
    tags: (hint ? keywords(hint, 3) : []).concat(pick(seed + 'tags', TAGS)).slice(0, 5),
    kind: designy ? 'design' : pick(seed + 'kind', KINDS),
    quality: 3 + (parseInt(crypto.createHash('sha1').update(seed + 'q').digest('hex').slice(0, 2), 16) % 3),
    people: parseInt(crypto.createHash('sha1').update(seed + 'p').digest('hex').slice(0, 2), 16) % 3,
    version_hint: (hint.match(/\b(v\d+|version \d+|versie \d+|final|draft|optie [a-d]|option [a-d])\b/i) || [''])[0],
    language: 'en',
  };
}

function labelChat(seed, name, user) {
  const kw = keywords(user.replace(/^[\s\S]*?messages/i, ''), 5);
  return {
    summary: `Conversation with ${name || 'a contact'} about ${kw.slice(0, 2).join(' and ') || 'day-to-day matters'}.`,
    topics: kw.length ? kw : pick(seed + 'topics', TAGS),
    category: /mum|dad|family|home/i.test(name || '') ? 'family' : /packag|supply|supplier|bv|ltd|design/i.test(name || '') ? 'supplier' : pick(seed + 'cat', CATEGORIES),
    is_project: /project|install|order|bouw|werk|design/i.test(name || ''),
  };
}

function labelDocument(user) {
  const text = (user.split(/\ntext:\n/)[1] || '');
  const name = (user.match(/file name:\s*(.+)/i) || [, ''])[1].trim();
  const first = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || name;
  const type = /invoice|factuur/i.test(text) ? 'invoice' : /quot|offerte/i.test(text) ? 'quote' : /artwork|poster|print/i.test(text) ? 'artwork' : 'other';
  return {
    title: first.slice(0, 60),
    summary: `${type === 'other' ? 'A document' : 'A ' + type} named ${name}: ${text.replace(/\s+/g, ' ').slice(0, 120)}.`,
    doc_type: type,
    parties: (text.match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)* (?:BV|NV|Ltd|GmbH|Foods|Packaging)\b/g) || []).slice(0, 3),
    dates: (text.match(/\b\d{1,2} [A-Z][a-z]+ \d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g) || []).slice(0, 3),
    amounts: (text.match(/\b(?:EUR|€|\$|USD)\s?[\d.,]+\b/g) || []).slice(0, 4),
    reference_numbers: (text.match(/\b[A-Z]{1,4}-?\d{3,}(?:-\d+)?\b|\b\d{4,6}\b/g) || []).slice(0, 4),
    tags: keywords(text, 5),
    version_hint: (text.match(/\b(v\d+|final|draft|concept|print-ready)\b/i) || [''])[0],
    language: 'en',
  };
}

function labelAudio(user) {
  const t = (user.split(/transcript:\n/)[1] || '').trim();
  return {
    summary: t ? t.split(/[.!?]/)[0].trim().slice(0, 140) + '.' : 'Nothing was said.',
    topics: keywords(t, 4),
    action_items: /please|can you|could you|will you|remind/i.test(t) ? [t.split(/[.!?]/).find((s) => /please|can you|could you|will you|remind/i.test(s)).trim()] : [],
    category: /\?/.test(t) ? 'question' : 'update',
    language: 'en',
  };
}

// The arrange call: group items by the first tag their fact line carries, which
// mimics a real clustering result closely enough to test everything downstream.
function arrange(user) {
  const lines = user.split('\n').filter((l) => /^\s*\d+[.|)]/.test(l));
  const buckets = new Map();
  for (const line of lines) {
    const idx = parseInt(line.match(/^\s*(\d+)/)[1], 10);
    const key = /advert|design|sale|poster|spring/i.test(line) ? 'Spring campaign'
      : /invoice|quote|offerte|factuur|eur|total/i.test(line) ? 'Paperwork'
        : /box|pallet|deliver|packag/i.test(line) ? 'Deliveries'
          : /oven|repair|machine|fixed/i.test(line) ? 'Equipment & repairs'
            : /family|mum|garden|lunch|beach|birthday/i.test(line) ? 'Family'
              : pick(line.replace(/^\s*\d+/, ''), ['Products', 'People & places', 'Paperwork']);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(idx);
  }
  const groups = [...buckets.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([name, members]) => ({ id: '', name, description: `Demo grouping: ${name.toLowerCase()}.`, emoji: '📁', members }));
  const placed = new Set(groups.flatMap((g) => g.members));
  return { groups, unsorted: lines.map((l) => parseInt(l.match(/^\s*(\d+)/)[1], 10)).filter((i) => !placed.has(i)) };
}

// Topics: cut the numbered messages into runs of up to twelve, titled by
// their most telling words.
function topics(user) {
  const lines = user.split('\n').filter((l) => /^\s*\d+\.\s*\[/.test(l));
  const out = [];
  for (let i = 0; i < lines.length; i += 12) {
    const chunk = lines.slice(i, i + 12);
    const text = chunk.map((l) => l.replace(/^\s*\d+\.\s*\[[^\]]*\]\s*/, '')).join(' ');
    const kw = keywords(text, 5);
    if (!kw.length) continue;
    out.push({
      title: kw.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
      summary: `Discussion about ${kw.slice(0, 3).join(', ')}.`,
      keywords: kw,
      people: [...new Set(chunk.map((l) => (l.match(/\[\S+ \S+ ([^\]]+)\]/) || [, 'them'])[1]).filter((p) => p !== 'me'))].slice(0, 3),
      decisions: /agree|go with|ok|fine|deal|paid|deliver/i.test(text) ? [text.split(/[.!?]/).find((s) => /agree|go with|ok|fine|deal|paid|deliver/i.test(s)).trim().slice(0, 120)] : [],
      first_index: parseInt(chunk[0].match(/^\s*(\d+)/)[1], 10),
      last_index: parseInt(chunk[chunk.length - 1].match(/^\s*(\d+)/)[1], 10),
    });
  }
  return { topics: out };
}

// Finals: the conversation decides when it names a number or a colour; else
// the last one.
function finalPick(user) {
  const n = (user.match(/^(\d+) (?:pictures|documents)/m) || [, '2'])[1];
  const count = parseInt(n, 10) || 2;
  const head = user.split(/messages around them:/)[0] || '';
  const ctx = (user.split(/messages around them:/)[1] || '').toLowerCase();
  // Versions of one thing talk alike: captions that share words, or that
  // carry version marks. Four unrelated family photos do neither.
  const items = head.split('\n').filter((l) => /^\d+\. /.test(l));
  const bags = items.map((l) => new Set(keywords((l.match(/caption: "([^"]*)"|looks like: ([^·]*)/) || []).slice(1).join(' '), 6)));
  let shared = 0;
  for (let i = 0; i < bags.length; i++) for (let j = i + 1; j < bags.length; j++) { let c = 0; for (const w of bags[i]) if (bags[j].has(w)) c++; if (c >= 2) shared++; }
  const versiony = /version mark:/.test(head) || /\b(v\d+|version|versie|optie|option)\b/i.test(head);
  const same = versiony || shared >= Math.max(1, items.length - 1);
  if (!same) return { same_thing: false, best_index: 0, confidence: 0.8, reason: 'These look like different pictures rather than versions of one thing.', ranking: [] };
  let best = count;
  let reason = 'The latest version is usually the final; nothing in the chat says otherwise.';
  // The owner's own words decide; the last choice stated wins.
  const map = { first: 1, '1st': 1, one: 1, second: 2, '2nd': 2, two: 2, third: 3, '3rd': 3, three: 3, fourth: 4, '4th': 4, four: 4 };
  const re = /\b(?:the|number|option|version|versie|optie|nummer)\s*(first|second|third|fourth|1st|2nd|3rd|4th|one|two|three|four|\d)\b/g;
  let picked = null;
  for (const line of ctx.split('\n')) {
    if (!/ me\]/.test(line)) continue;
    let m; while ((m = re.exec(line))) picked = m;
  }
  if (picked) { best = map[picked[1]] || parseInt(picked[1], 10) || best; reason = `The chat picked "${picked[0]}" — that one is the final.`; }
  best = Math.max(1, Math.min(count, best));
  return { same_thing: true, best_index: best, confidence: picked ? 0.9 : 0.55, reason, ranking: [best, ...Array.from({ length: count }, (_, i) => i + 1).filter((i) => i !== best)] };
}

async function complete(cfg, req) {
  await new Promise((r) => setTimeout(r, 40));   // enough delay to see progress move
  const seed = (req.user || '').slice(0, 400);
  let json = null;
  if (req.schema) {
    const props = req.schema.properties || {};
    if (props.groups) json = arrange(req.user || '');
    else if (props.topics && props.topics.items && props.topics.items.properties && props.topics.items.properties.first_index) json = topics(req.user || '');
    else if (props.best_index) json = finalPick(req.user || '');
    else if (props.doc_type) json = labelDocument(req.user || '');
    else if (props.action_items) json = labelAudio(req.user || '');
    else if (props.caption) json = labelImage(seed, req.user || '');
    else if (props.summary) json = labelChat(seed, (req.user.match(/chat:\s*(.+)/i) || [])[1], req.user || '');
    else if (props.ok) json = { ok: true };
    else if (props.colour) json = { colour: 'red' };
    else if (props.group_id) json = { group_id: null, confidence: 0 };
    else if (props.text) json = { text: 'A demo status.' };
    else if (props.answer) json = { answer: 'Demo mode cannot answer questions; add a real provider.', sources: [] };
    else json = {};
  }
  return { json, text: json ? JSON.stringify(json) : 'READY', usage: { in: 0, out: 0 } };
}

// A fake transcript: long enough to be summarised, built from the chat name
// so it reads plausibly.
async function transcribe(cfg, req) {
  await new Promise((r) => setTimeout(r, 40));
  const who = (String(req.prompt || '').match(/with (.+?)\.?$/) || [, 'the contact'])[1];
  const text = `Hi, this is a demo transcript of a voice note from ${who}. The delivery is confirmed for Thursday morning, please can you confirm the invoice has been paid. Thanks, speak soon.`;
  return { text, language: 'en', seconds: Math.max(3, Math.round((req.bytes ? req.bytes.length : 8000) / 2500)) };
}

// Bag-of-words hashing into 64 dimensions: texts that share words share
// directions, which is all a search by meaning needs in a demo.
async function embed(cfg, texts) {
  const dims = 64;
  const vectors = texts.map((t) => {
    const v = new Float32Array(dims);
    for (const w of words(t)) {
      const h = crypto.createHash('sha1').update(w).digest();
      v[h[0] % dims] += 1; v[h[1] % dims] += 0.5; v[h[2] % dims] -= 0.25;
    }
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < dims; i++) v[i] /= n;
    return v;
  });
  return { vectors, usage: { in: 0, out: 0 } };
}

module.exports = { complete, transcribe, embed };
