'use strict';
// What a conversation was about, stretch by stretch.
//
// A chat label says what a chat is for; a chat with a supplier is "orders and
// deliveries". That is the shelf, not the book. People look for the thing
// itself: the time the oven broke, the quote for the boxes, the spring
// advert. So each chat is read in windows of messages, and every window
// yields the topics it contains — a title, a summary, the words that name
// it, the people in it, what was decided — with the exact span of messages
// it covers, so a topic opens the conversation at the right place.
//
// Read once, forward only. A cursor per chat remembers how far the reading
// got; a new run reads only what arrived since. Nothing is re-sent.
const messages = require('../messages');
const ai = require('./store');
const { complete } = require('./provider');

const WINDOW = 80;              // messages per call
const MAX_WINDOWS_PER_JOB = 4;  // bound one job's spend; the next run continues
const MIN_NEW = 8;              // fewer new messages than this is not worth a call yet
const CHARS = 220;

const SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      description: 'The distinct things this stretch of conversation was about, in order of first appearance. Usually 1 to 6.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short, specific title, 2 to 7 words, in the language of the conversation. Name the thing, not the kind of thing: "Spring sale advert" not "Design discussion".' },
          summary: { type: 'string', description: 'One or two sentences: what was discussed and where it got to.' },
          keywords: { type: 'array', items: { type: 'string' }, description: '2-6 lowercase keywords someone might search for, including names, product names and reference numbers.' },
          people: { type: 'array', items: { type: 'string' }, description: 'The participants who spoke about it, by the names shown. Up to 4.' },
          decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions, agreements, dates set or things promised, each a short sentence. Empty if none.' },
          first_index: { type: 'integer', description: 'The number of the first message that belongs to this topic.' },
          last_index: { type: 'integer', description: 'The number of the last message that belongs to this topic.' },
        },
        required: ['title', 'summary', 'keywords', 'people', 'decisions', 'first_index', 'last_index'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

const SYSTEM = [
  'You read a stretch of a WhatsApp conversation and break it into the topics it covers.',
  'A topic is one real matter: an order, a repair, an event, a design being chosen, a question that got answered, a plan being made.',
  'Small talk, greetings and single-line pleasantries are not topics; fold them into the matter they belong to or leave them out.',
  'Refer to messages by their number. Use the names shown for people.',
  'Write titles and summaries in the language the conversation itself is in.',
].join(' ');

function line(n, m) {
  const who = m.fromMe ? 'me' : (m.authorName || (m.author && !/@/.test(m.author) ? m.author : null) || 'them');
  const when = new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ');
  let body = String(m.body || '').replace(/\s+/g, ' ').trim();
  if (!body && m.mediaKind) body = `[${m.mediaKind}${m.type === 'ptt' ? ' voice note' : ''}]`;
  else if (m.mediaKind && body) body = `[${m.mediaKind}] ${body}`;
  return `${n}. [${when} ${who}] ${body.slice(0, CHARS)}`;
}

// Messages worth reading: with text, or media with a caption, or media at all
// (a photo in the middle of a discussion is part of it).
const readable = (m) => !m.revoked && (String(m.body || '').trim() || m.mediaKind);

function validate(json, count) {
  const out = [];
  const raw = json && Array.isArray(json.topics) ? json.topics : [];
  for (const t of raw) {
    const title = String(t.title || '').trim().slice(0, 80);
    if (!title) continue;
    let a = parseInt(t.first_index, 10), b = parseInt(t.last_index, 10);
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    if (a > b) [a, b] = [b, a];
    a = Math.max(1, Math.min(count, a)); b = Math.max(1, Math.min(count, b));
    out.push({
      title,
      summary: String(t.summary || '').trim().slice(0, 600),
      keywords: (Array.isArray(t.keywords) ? t.keywords : []).map((k) => String(k || '').toLowerCase().trim()).filter(Boolean).slice(0, 8),
      people: (Array.isArray(t.people) ? t.people : []).map((k) => String(k || '').trim()).filter(Boolean).slice(0, 4),
      decisions: (Array.isArray(t.decisions) ? t.decisions : []).map((k) => String(k || '').trim()).filter(Boolean).slice(0, 6),
      a, b,
    });
  }
  return out;
}

// How many windows a chat still has to read — for the estimate.
function pendingWindows(chatId) {
  const cur = ai.topicCursor(chatId);
  const fp = messages.chatFingerprint(chatId);
  if (!fp.count) return 0;
  if (!cur) return fp.count >= 3 ? Math.max(1, Math.ceil(fp.count / WINDOW)) : 0;
  if (fp.last <= cur.last_ts) return 0;
  // Only what came after the cursor counts; a rough but cheap count.
  const rows = messages.windowFrom(chatId, cur.last_ts, cur.last_id, 2000);
  const n = rows.filter(readable).length;
  return n < MIN_NEW ? 0 : Math.ceil(n / WINDOW);
}

// One job: read up to MAX_WINDOWS_PER_JOB windows from the cursor on.
async function extractTopics(cfg, chatId, { chatName } = {}) {
  let cur = ai.topicCursor(chatId) || { last_ts: 0, last_id: '' };
  const name = chatName || (messages.listChats().find((c) => c.chatId === chatId) || {}).chatName || chatId;
  let usage = { in: 0, out: 0 }, cost = 0, costCap = 0, made = 0, windows = 0, skipped = null;
  for (let w = 0; w < MAX_WINDOWS_PER_JOB; w++) {
    const rows = messages.windowFrom(chatId, cur.last_ts, cur.last_id, WINDOW * 2).filter(readable).slice(0, WINDOW);
    if (!rows.length) break;
    // A thin tail is left for later, when there is more to read with it —
    // unless nothing has ever been read, in which case a few lines is all
    // there is and they deserve a topic too.
    const first = !ai.topicCursor(chatId) && w === 0;
    if (rows.length < MIN_NEW && !(first && rows.length >= 3)) { skipped = 'too little new since last time'; break; }
    const list = rows.map((m, i) => line(i + 1, m)).join('\n');
    const prev = ai.topicsOf(chatId).slice(-4).map((t) => `- ${t.title}`).join('\n');
    const res = await complete(cfg, {
      system: SYSTEM,
      user: `chat: ${name}\n${prev ? `topics already found earlier in this chat (continue them only if these messages are about the same matter):\n${prev}\n\n` : ''}messages ${w + 1 > 1 ? '(continued) ' : ''}oldest first:\n${list}\n\nList the topics.`,
      schema: SCHEMA, schemaName: 'topics', maxTokens: Math.min(4000, 600 + rows.length * 18),
    });
    usage.in += res.usage.in; usage.out += res.usage.out;
    cost = (cost == null || res.cost == null) ? null : cost + res.cost;
    costCap += res.costCap || 0;
    windows++;
    const found = validate(res.json, rows.length);
    const topics = found.map((t) => ({
      title: t.title, summary: t.summary, keywords: t.keywords, people: t.people, decisions: t.decisions,
      fromTs: rows[t.a - 1].ts, toTs: rows[t.b - 1].ts, msgCount: t.b - t.a + 1, firstId: rows[t.a - 1].id, lastId: rows[t.b - 1].id,
    }));
    if (topics.length) { ai.putTopics(chatId, topics, { model: cfg.model, provider: cfg.provider }); made += topics.length; }
    const last = rows[rows.length - 1];
    ai.setTopicCursor(chatId, last.ts, last.id);
    cur = { last_ts: last.ts, last_id: last.id };
    if (rows.length < WINDOW) break;
  }
  if (!windows && skipped) return { skipped };
  return { usage, cost, costCap, topics: made, windows };
}

// The topics as entries for the arrange pass, which groups them into themes
// across chats — "the spring campaign" is three chats and five topics.
function entries() {
  const names = new Map(messages.listChats().map((c) => [c.chatId, c.chatName]));
  return ai.allTopics().map((t) => ({
    kind: 'topic', refId: t.id,
    label: { caption: t.title, summary: t.summary, tags: t.keywords, text_in_image: '' },
    chat: names.get(t.chatId) || '', when: new Date(t.toTs).toISOString().slice(0, 7),
  }));
}

module.exports = { extractTopics, pendingWindows, entries, validate, WINDOW };
