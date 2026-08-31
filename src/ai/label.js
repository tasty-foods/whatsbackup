'use strict';
// Pass 1: one cheap call per item, producing a few short facts about it.
// Cached by content hash, so re-running the library costs nothing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfgApp = require('../config');
const store = require('../store');
const messages = require('../messages');
const ai = require('./store');
const { complete } = require('./provider');
const { shrink } = require('./shrink');

// Anthropic rejects images over 5 MB; anything near that is a photo we don't
// need at full size anyway.
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const MIN_USEFUL_BYTES = 8 * 1024;      // sub-8KB jpegs are thumbnails and avatars

const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    caption: { type: 'string', description: 'One sentence describing what is in the picture.' },
    subjects: { type: 'array', items: { type: 'string' }, description: 'The main things visible, 1-5 short nouns.' },
    scene: { type: 'string', description: 'Where this appears to be, in a few words.' },
    text_in_image: { type: 'string', description: 'Any text legible in the image, verbatim. Empty string if none.' },
    tags: { type: 'array', items: { type: 'string' }, description: '2-6 short lowercase keywords.' },
  },
  required: ['caption', 'subjects', 'scene', 'text_in_image', 'tags'],
  additionalProperties: false,
};

const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences on what this conversation is about.' },
    topics: { type: 'array', items: { type: 'string' }, description: '2-6 short keywords.' },
    category: { type: 'string', description: 'A short label for the kind of relationship, e.g. supplier, customer, family.' },
    is_project: { type: 'boolean', description: 'True if this chat is mainly about one identifiable job, order or project.' },
  },
  required: ['summary', 'topics', 'category', 'is_project'],
  additionalProperties: false,
};

// Written to be read by a model that will see hundreds of these: short, and
// explicit that guessing beyond the evidence is not wanted.
const IMAGE_SYSTEM = [
  'You label photographs from a personal WhatsApp archive so they can be grouped later.',
  'Describe only what is actually visible. Do not guess at intent, names, or backstory.',
  'If text is legible in the image (an invoice, a label, a screenshot), copy it into text_in_image verbatim.',
  'Write in the same language as any text in the image; otherwise write in English.',
  'Keep the caption to one plain sentence.',
].join(' ');

const CHAT_SYSTEM = [
  'You summarise WhatsApp conversations so they can be grouped by project or purpose later.',
  'You are shown a sample of messages, not the whole conversation.',
  'Describe what the conversation is for. Do not speculate about anything not present.',
  'Reply in the language the conversation itself is in.',
].join(' ');

const kindOf = (rec) => (rec.kind === 'video' ? 'video' : 'image');

function fileFor(rec) {
  const area = rec.kind === 'video' ? [cfgApp.VIDEO_DIR, cfgApp.LOCAL_VIDEO_DIR]
    : rec.kind === 'image' || rec.kind === 'sticker' ? [cfgApp.IMAGES_DIR]
      : [cfgApp.FILES_DIR];
  for (const dir of area) {
    const p = path.join(dir, rec.filename);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

// Everything the run would cost, and everything it would skip, worked out
// before a single call is made. The council's point: costing 466 files as if
// they were all photographs is how a headline price ends up wrong.
// One walk over the media, used by both the estimate and the queue, so the two
// can never disagree about what will be sent. The skip test runs for every
// record â€” including already-labelled ones â€” because that is what fills the
// duplicate set; testing it only for unlabelled records makes a second copy of
// an already-labelled photo look like a fresh one.
function eachCandidate(onItem) {
  const seen = new Set();
  for (const rec of store.listRecords({})) {
    if (rec.kind === 'video') { onItem(rec, 'video', null); continue; }
    const reason = skipReason(rec, seen);
    onItem(rec, 'image', reason);
  }
}

function census({ analyseImages = true, analyseChats = true } = {}) {
  const out = {
    images: { count: 0, bytes: 0, labelled: 0, todo: 0, skipped: {} },
    videos: { count: 0, labelled: 0, todo: 0 },
    chats: { count: 0, labelled: 0, todo: 0 },
  };
  if (analyseImages) {
    eachCandidate((rec, kind, reason) => {
      const bucket = kind === 'video' ? out.videos : out.images;
      bucket.count++;
      if (kind === 'image') out.images.bytes += rec.size || 0;
      if (reason) { out.images.skipped[reason] = (out.images.skipped[reason] || 0) + 1; return; }
      if (ai.getLabel(kind, rec.id)) bucket.labelled++;
      else bucket.todo++;
    });
  }
  if (analyseChats) {
    const withText = messages.chatsWithText();
    for (const c of messages.listChats()) {
      out.chats.count++;
      if (!withText.has(c.chatId)) { out.chats.noText = (out.chats.noText || 0) + 1; continue; }
      if (ai.getLabel('chat', c.chatId)) out.chats.labelled++;
      else out.chats.todo++;
    }
  }
  return out;
}

// Documents, voice notes and audio are captured too when those settings are on.
// No vision model can read any of them, and posting a PDF or an .ogg as a
// base64 "image" is a charged call that can only fail.
const VISIBLE_KINDS = new Set(['image', 'sticker']);

// What makes two images the same image. Size and type alone put two unrelated
// photographs that happen to weigh the same into one bucket, and the loser is
// dropped from the run as a "duplicate" — never labelled, never sorted, and
// nothing says so. A forward from WhatsApp is byte-identical, so the head of
// the file settles it: 16 KB is enough to separate any two real photographs
// and far cheaper than hashing 78 MB. Computed once per record — files here
// are written once and never edited — so repeated estimates cost nothing.
const dupKeys = new Map();
function dupKey(rec) {
  const cached = dupKeys.get(rec.id);
  if (cached) return cached;
  let key = `${rec.size}:${rec.mimetype}`;
  try {
    const file = path.join(rec.kind === 'video' ? cfgApp.VIDEO_DIR : cfgApp.IMAGES_DIR, rec.filename);
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(Math.min(16384, rec.size || 16384));
      const read = fs.readSync(fd, head, 0, head.length, 0);
      key += ':' + crypto.createHash('sha1').update(head.subarray(0, read)).digest('hex').slice(0, 16);
    } finally { fs.closeSync(fd); }
  } catch (_) {
    // Unreadable right now — a cloud drive that has gone away. Fall back to the
    // weaker key rather than calling every unreadable file distinct.
  }
  dupKeys.set(rec.id, key);
  return key;
}

// A free local pass that keeps money from being spent on things that cannot
// produce a useful group.
function skipReason(rec, seen) {
  if (rec.sample) return 'sample image';
  if (!VISIBLE_KINDS.has(rec.kind)) return 'not a picture';
  if ((rec.size || 0) > MAX_IMAGE_BYTES) return 'too large to send';
  if ((rec.size || 0) < MIN_USEFUL_BYTES) return 'thumbnail-sized';
  if (rec.kind === 'sticker') return 'sticker';
  const key = dupKey(rec);
  if (seen) {
    if (seen.has(key)) return 'duplicate of another image';
    seen.add(key);
  }
  return null;
}

/* ---------------- the two labellers ---------------- */

async function labelImage(cfg, rec) {
  const file = fileFor(rec);
  if (!file) return { skipped: 'file is missing from disk' };
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_IMAGE_BYTES) return { skipped: 'too large to send' };

  const hash = ai.sha1(bytes);
  if (ai.isLabelled('image', rec.id, hash)) return { cached: true };

  // Sent smaller: same answer, a quarter of the input tokens, and on a model
  // running on this machine roughly a fifth of the wait. Falls back to the
  // original bytes if the shell can't do it.
  const sending = await shrink(bytes);

  const hint = (rec.caption || '').trim();
  const res = await complete(cfg, {
    system: IMAGE_SYSTEM,
    user: `This photo was ${rec.dir === 'out' ? 'sent by the owner' : 'received'} in a chat called "${rec.chat}".`
      + (hint ? `\ncaption: ${hint}` : '')
      + '\nDescribe it.',
    images: [{ mediaType: sending === bytes ? (rec.mimetype || 'image/jpeg') : 'image/jpeg', data: sending.toString('base64') }],
    schema: IMAGE_SCHEMA, schemaName: 'image_label', maxTokens: 400,
  });
  ai.putLabel({ kind: 'image', refId: rec.id, contentHash: hash, label: res.json, model: cfg.model, provider: cfg.provider, usage: res.usage, cost: res.cost });
  return { usage: res.usage, cost: res.cost, costCap: res.costCap };
}

// A video can't be shown to a vision model without extracting a frame, which
// needs ffmpeg. Rather than leave 39 files in a permanent unexplained pile,
// they're described from the context around them and marked as not seen.
async function labelVideo(cfg, rec) {
  const hash = ai.sha1(`${rec.id}:${rec.size}:${rec.caption || ''}`);
  if (ai.isLabelled('video', rec.id, hash)) return { cached: true };

  const res = await complete(cfg, {
    system: CHAT_SYSTEM,
    user: `A video (not shown to you) was ${rec.dir === 'out' ? 'sent' : 'received'} in a chat called "${rec.chat}"`
      + ` on ${new Date(rec.ts).toISOString().slice(0, 10)}, ${Math.round((rec.size || 0) / 1e6)} MB.`
      + (rec.caption ? `\nIts caption: ${rec.caption}` : '')
      + '\nFrom that context alone, summarise what this video is most likely part of. Say so plainly if the context is too thin.',
    schema: CHAT_SCHEMA, schemaName: 'video_label', maxTokens: 300,
  });
  const label = { ...res.json, caption: res.json.summary, tags: res.json.topics, visual: false };
  ai.putLabel({ kind: 'video', refId: rec.id, contentHash: hash, label, model: cfg.model, provider: cfg.provider, usage: res.usage, cost: res.cost });
  return { usage: res.usage, cost: res.cost, costCap: res.costCap };
}

async function labelChat(cfg, chat) {
  const fp = messages.chatFingerprint(chat.chatId);
  const hash = ai.sha1(`${chat.chatId}:${fp.count}:${fp.last}`);
  if (ai.isLabelled('chat', chat.chatId, hash)) return { cached: true };

  const body = messages.digest(chat.chatId);
  if (!body.trim()) return { skipped: 'no message text stored' };

  const res = await complete(cfg, {
    system: CHAT_SYSTEM,
    user: `chat: ${chat.chatName || chat.chatId}\nmessages (a sample, oldest first):\n${body}`,
    schema: CHAT_SCHEMA, schemaName: 'chat_label', maxTokens: 400,
  });
  ai.putLabel({ kind: 'chat', refId: chat.chatId, contentHash: hash, label: res.json, model: cfg.model, provider: cfg.provider, usage: res.usage, cost: res.cost });
  return { usage: res.usage, cost: res.cost, costCap: res.costCap };
}

module.exports = { census, eachCandidate, skipReason, fileFor, kindOf, VISIBLE_KINDS, labelImage, labelVideo, labelChat, IMAGE_SCHEMA, CHAT_SCHEMA };
