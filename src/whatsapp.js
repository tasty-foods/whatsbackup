'use strict';
require('./wwebjs-patches');                 // before the library: it takes its helpers at load time
const { Client, LocalAuth, Chat } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');
const settings = require('./settings');
const messages = require('./messages');
const contacts = require('./contacts');

const state = {
  status: 'starting',        // starting | qr | authenticated | ready | disconnected | error
  qrDataUrl: null,
  me: null,
  lastError: null,
  needsRelink: false,        // set when the phone unlinked this device (terminal)
  startedAt: Date.now(),
};

let reconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

const backfill = {
  running: false, saved: 0, skipped: 0, messages: 0, doneChats: 0, totalChats: 0,
  startedAt: null, finishedAt: null, error: null,
};

// Catching up: messages that arrived while this PC was off never fire a live
// event, so on every connect (and every twenty minutes after) the chats that
// moved since we last looked are read back and anything missing is saved.
const sync = {
  running: false, reason: null, chats: 0, done: 0, newMessages: 0, newMedia: 0,
  startedAt: null, finishedAt: null, lastError: null, lastAt: null,
};
const CATCHUP_DELAY_MS = 20 * 1000;
const CATCHUP_EVERY_MS = 20 * 60 * 1000;
const CATCHUP_CHATS = 60;
const CATCHUP_MESSAGES = 80;
let catchUpTimer = null;

// Capture health. WhatsApp changes its internals without warning, and when that
// happens every download starts failing while everything else still looks fine —
// that is exactly how this app lost a month of capture. Fresh media should
// always be downloadable, so repeated live failures mean something is broken.
const UNHEALTHY_AFTER = 3;
const health = {
  consecutiveFailures: 0,
  lastError: null,
  lastErrorAt: null,
  lastCaptureAt: null,
  totalCaptured: 0,
  lastStorageError: null,      // a folder or cloud drive problem, counted apart
  lastStorageErrorAt: null,
};
function noteCaptureOk() {
  health.consecutiveFailures = 0;
  health.lastError = null;
  health.lastCaptureAt = Date.now();
  health.totalCaptured++;
}
function noteCaptureFail(e) {
  health.consecutiveFailures++;
  health.lastError = describeError(e);
  health.lastErrorAt = Date.now();
}
const captureBroken = () => health.consecutiveFailures >= UNHEALTHY_AFTER;

// Guard against calls that never resolve (whatsapp-web.js can hang on a bad
// chat or a stalled media download) — skip the item instead of freezing.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout: ' + (label || ''))), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Errors thrown inside WhatsApp Web's own minified code arrive as a single
// letter ("r") — keep the class name so the log says at least something.
function describeError(e) {
  if (!e) return 'unknown error';
  const name = e.name && e.name !== 'Error' ? e.name + ': ' : '';
  return (name + (e.message || String(e))).slice(0, 300);
}

function logStack(e) {
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
}

// WhatsApp renamed the serialized field on message ids (a minified "$1" today),
// so msg.id._serialized — which whatsapp-web.js relies on — is undefined. Find
// the key by shape rather than by that name, and rebuild it if it's gone too.
function msgKey(msg) {
  const id = msg && msg.id;
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (typeof id._serialized === 'string') return id._serialized;
  const remote = id.remote, local = id.id;
  if (!remote || !local) return null;
  const serialized = Object.values(id).find(
    (v) => typeof v === 'string' && v.includes(String(remote)) && v.includes(String(local))
  );
  if (serialized) return serialized;
  const parts = [String(!!id.fromMe), String(remote), String(local)];
  if (id.participant) parts.push(String(id.participant));
  return parts.join('_');
}

function getState() {
  const { qrDataUrl, ...rest } = state;
  let conversations = { messages: 0, chats: 0 };
  try { conversations = messages.counts(); } catch (_) {}
  return {
    ...rest,
    counts: store.counts(),
    conversations,
    conversationsEnabled: captureConversations(),
    cloudConfigured: cfg.CLOUD_CONFIGURED,
    cloudAvailable: cfg.CLOUD_AVAILABLE,
    cloudRoot: cfg.CLOUD_ROOT,
    qr: qrDataUrl,
    backfill: { ...backfill, lastImportAt: settings.read().lastImportAt || backfill.finishedAt || 0 },
    health: { ...health, ok: !captureBroken() },
    sync: { ...sync, contacts: contacts.size() },
  };
}

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/wav': 'wav', 'application/pdf': 'pdf',
  // Documents: Office's own types are long and none of them is an extension.
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'application/rtf': 'rtf', 'text/rtf': 'rtf', 'image/heic': 'heic', 'image/heif': 'heif',
};
// A document's own name says best what it is ("Invoice 4021.xlsx"); the type
// is the fallback, and a type with no known extension becomes .bin rather
// than the tail of a long name Windows will not open.
const extFor = (m, name) => {
  const own = /\.([A-Za-z0-9]{1,6})$/.exec(String(name || ''));
  if (own) return own[1].toLowerCase();
  const type = (m || '').split(';')[0].trim().toLowerCase();
  if (EXT[type]) return EXT[type];
  const tail = type.split('/')[1] || '';
  return /^[a-z0-9]{1,5}$/.test(tail) ? tail : 'bin';
};
const sanitize = (x) => (x || 'unknown').replace(/[^\p{L}\p{N}\-_. ]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown';
const stamp = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const mirrorImages = () => (process.env.WA_MIRROR_IMAGES === '1') || !!settings.read().mirrorImages;
const captureConversations = () => !!settings.read().captureConversations;

// What WhatsApp calls a message type → the kind we file it under, and the
// setting that switches that kind on. Anything not listed is never captured.
const KIND_BY_TYPE = { image: 'image', video: 'video', ptt: 'voice', audio: 'audio', document: 'document', sticker: 'sticker' };
const KIND_SETTING = {
  image: 'captureImages', video: 'captureVideos', voice: 'captureVoice',
  audio: 'captureAudio', document: 'captureDocuments', sticker: 'captureStickers',
};
// Images and stickers sit together in the gallery; voice notes, audio and
// documents share a files folder; videos are the ones that go to the cloud.
const AREA_BY_KIND = { image: 'images', sticker: 'images', video: 'videos', voice: 'files', audio: 'files', document: 'files' };

// Decided before downloading, so an excluded chat never costs bandwidth.
function shouldCapture(msg, chat, kind) {
  if (!kind) return false;
  const s = settings.read();
  if (!s[KIND_SETTING[kind]]) return false;
  if (msg.fromMe && !s.captureSent) return false;
  if (!msg.fromMe && !s.captureReceived) return false;
  if (chat && chat.isGroup && !s.captureGroups) return false;
  const excluded = s.excludedChats || [];
  if (excluded.length && chat) {
    const id = (chat.id && chat.id._serialized) || '';
    const name = (chat.name || '').toLowerCase();
    if (excluded.some((x) => x && (x === id || String(x).toLowerCase() === name))) return false;
  }
  return true;
}

// System/protocol message types that carry no human content — skip in the transcript.
const SKIP_TYPES = new Set(['e2e_notification', 'notification', 'notification_template', 'gp2', 'protocol', 'ciphertext', 'revoked']);

// Sender label: 'me' for own messages, a resolved name for group participants,
// and null for 1:1 chats (where the sender is just the chat itself).
function authorName(msg, chat) {
  if (msg.fromMe) return 'me';
  if (chat && chat.isGroup) return contacts.resolve(msg.author) || (msg.author ? String(msg.author).replace(/@.*$/, '') : '');
  return null;
}

// A chat's name is the contact's name, and the chat object often does not
// carry it: for the @lid ids WhatsApp now uses it has neither a name nor a
// phone number, which is how the busiest chats came to be called "unknown".
// So the contact is asked, once per chat, and the answer kept for a while.
const chatNames = new Map();                 // chatId -> { name, at }
const NAME_TTL_MS = 6 * 60 * 60 * 1000;
const phoneish = (u) => { const d = String(u || '').replace(/\D/g, ''); return d.length >= 8 && d.length <= 15 ? '+' + d : ''; };
function cachedChatName(chat) {
  const id = chat && chat.id && chat.id._serialized;
  const hit = id && chatNames.get(id);
  return hit && Date.now() - hit.at < NAME_TTL_MS ? hit.name : '';
}
async function chatDisplayName(chat, msg) {
  if (chat && chat.name) return chat.name;
  const id = chat && chat.id && chat.id._serialized;
  const cached = cachedChatName(chat);
  if (cached) return cached;
  let name = (id && contacts.resolve(id)) || '';
  if (!name && chat && typeof chat.getContact === 'function') {
    try {
      const ct = await chat.getContact();
      if (ct) name = ct.isMe ? 'Notes to self' : (ct.name || ct.pushname || ct.shortName || phoneish(ct.number) || '');
    } catch (_) {}
  }
  if (!name && msg && !msg.fromMe && msg._data && msg._data.notifyName) name = String(msg._data.notifyName);
  if (!name && chat && chat.id && !/@lid$/.test(id || '')) name = phoneish(chat.id.user);
  if (id && name) chatNames.set(id, { name, at: Date.now() });
  return name || 'unknown';
}

// Chats saved before their name could be found are given it now — in the
// conversations, and in the gallery's copy of the name on each photo.
let readyClient = null;
async function repairUnknownChats(c, { reason = 'startup' } = {}) {
  // What the database already knows comes first: no network, no waiting.
  let healed = 0;
  try {
    for (const id of messages.unknownChatIds()) {
      const known = messages.bestNameFor(id);
      if (known) { messages.renameChat(id, known); store.renameChat(id, known); healed++; }
    }
  } catch (_) {}
  let ids = [];
  try { ids = messages.unknownChatIds(); } catch (_) {}
  // The @lid ids WhatsApp now uses carry no number. The client can be asked
  // which phone each one belongs to, and the phone's contact has the name.
  try {
    const lids = ids.filter((id) => /@lid$/.test(id));
    if (lids.length && typeof c.getContactLidAndPhone === 'function') {
      const pairs = await withTimeout(c.getContactLidAndPhone(lids), 30000, 'lid lookup');
      const n = contacts.addLidMappings(pairs || []);
      if (n) console.log(`[names] ${n} lid ids mapped to phone numbers`);
    }
  } catch (_) {}
  let fixed = healed;
  for (const id of ids) {
    let name = contacts.resolve(id) || '';
    if (!name) {
      let chat = null;
      try { chat = await c.getChatById(id); } catch (_) {}
      if (!chat) continue;
      name = await chatDisplayName(chat, null);
    }
    if (!name || name === 'unknown') continue;
    try { messages.renameChat(id, name); store.renameChat(id, name); fixed++; } catch (_) {}
  }
  // Group authors stored as raw ids get their names now that the book is in.
  try { const n = messages.fillAuthorNames((a) => contacts.resolve(a)); if (n) console.log(`[names] ${n} group messages given their author's name`); } catch (_) {}
  if (ids.length) console.log(`[names] ${reason}: ${fixed} of ${ids.length} unnamed chats given their name`);
  return { checked: ids.length, fixed };
}

// WhatsApp Web's October 2026 build stopped filling in `_serialized` on its
// message keys (fromMe, remote, id and $1 are there; 0 of 231 keys had it on
// 2026-10-12). The library looks messages up by that field, so asking it for a
// chat ended in IndexedDB "No key or key range specified": msg.getChat(),
// getChatById() and fetchMessages() failed for 231 of 238 chats. Names came out
// as "unknown", sent messages had no chat to go to, and catch-up read nothing.
// The key's own toString() is the serialized form, so the field is given back
// on the class, as a getter, where an own property would still take precedence.
async function installKeyShim(c) {
  try {
    return await c.pupPage.evaluate(() => {
      const C = window.require('WAWebCollections');
      let sample = null;
      for (const ch of C.Chat.getModelsArray()) { if (ch.lastReceivedKey) { sample = ch.lastReceivedKey; break; } }
      if (!sample) { const m = C.Msg.getModelsArray()[0]; sample = m && m.id; }
      if (!sample) return 'no key yet';
      if (typeof sample._serialized === 'string') return 'not needed';
      const proto = Object.getPrototypeOf(sample);
      if (!proto || Object.prototype.hasOwnProperty.call(proto, '_serialized')) return 'already there';
      Object.defineProperty(proto, '_serialized', {
        configurable: true, enumerable: false,
        get() { try { return this.toString(); } catch (_) { return undefined; } },
      });
      return typeof sample._serialized === 'string' ? 'installed' : 'did not take';
    });
  } catch (e) { return 'failed: ' + describeError(e); }
}

// The address book, read from the phone and written down.
async function syncContacts(c, { reason = 'startup' } = {}) {
  const cs = await withTimeout(c.getContacts(), 120000, 'getContacts');
  // The library files a hidden-number (@lid) contact under its phone number
  // when it knows one and drops the lid, so a chat or group author that only
  // ever appears as @lid finds no name. WhatsApp's own list has both.
  try {
    const lids = await withTimeout(c.pupPage.evaluate(() => {
      const out = [];
      for (const ct of window.require('WAWebCollections').Contact.getModelsArray()) {
        try {
          const id = ct.id && ct.id._serialized;
          if (!id || !/@lid$/.test(id)) continue;
          const name = ct.name || '', push = ct.pushname || '', biz = ct.verifiedName || '';
          if (!name && !push && !biz) continue;
          const pn = ct.phoneNumber ? (ct.phoneNumber._serialized || String(ct.phoneNumber)) : '';
          out.push({ id, lid: id, name: name || biz, pushname: push, number: pn.replace(/@.*$/, ''), isMyContact: !!ct.isMyContact, isBusiness: !!biz });
        } catch (_) {}
      }
      return out;
    }), 60000, 'lid contacts');
    if (lids.length) cs.push(...lids.map((x) => ({ ...x, id: x.id })));
  } catch (e) { console.warn('[contacts] hidden-number contacts not read:', describeError(e)); }
  const n = contacts.load(cs);
  console.log(`[contacts] ${reason}: ${n} names (${cs.length} contacts read)`);
  return n;
}

// The chat list as WhatsApp reports it, written down with each chat's own
// last-activity time — which is how a catch-up knows where to look.
//
// Read from the page's own rows. The library's Chat object keeps neither `t`
// nor `formattedTitle` (they become `timestamp` and `name`), so reading them
// off it gave every chat a last-activity time of 0 — and catch-up, which only
// reads chats whose activity is newer than what it last saw, read nothing.
async function syncChatList(c) {
  const rows = await readChatRows(c);
  const flat = rows.map((r) => ({
    id: r.id,
    name: chatTitle(r) || contacts.resolve(r.id) || '',
    isGroup: !!r.isGroup,
    lastTs: (r.t || 0) * 1000,
    archived: !!r.archived,
  })).filter((x) => x.id && x.id !== 'status@broadcast');
  messages.upsertChats(flat);
  healChatNames(flat);
  return flat.length;
}

// The name a person sees for a chat in WhatsApp. A saved contact or a group
// has a real title; an unsaved number's title is just the number, and then a
// business's verified name or the name they gave themselves says more.
const numberish = (s) => /^[+\d][\d\s()+\-]{5,}$/.test(String(s || '').trim());
function chatTitle(r) {
  const title = String(r.title || '').trim();
  if (title && !numberish(title)) return title;
  return r.verifiedName || r.pushname || title || '';
}

// Old messages and photos keep the name a chat had when they arrived — a
// number, or "unknown" while WhatsApp could not be asked. Once WhatsApp gives
// a real name, everything from that chat is shown under it.
function healChatNames(flat) {
  let chats = 0;
  for (const ch of flat) {
    if (!ch.name || numberish(ch.name)) continue;
    try {
      const n = messages.retitleChat(ch.id, ch.name);
      const g = store.retitleChat(ch.id, ch.name);
      if (n || g) chats++;
    } catch (_) {}
  }
  if (chats) console.log(`[names] ${chats} chat${chats === 1 ? '' : 's'} now shown under the name WhatsApp gives ${chats === 1 ? 'it' : 'them'}`);
  return chats;
}

// Reads back the recent messages of every chat that moved since we last
// looked, saving media and text that live capture never saw. Idempotent:
// everything is keyed by message id and inserted with OR IGNORE.
async function catchUp(c, { reason = 'startup', chatIds = null, limit = CATCHUP_MESSAGES } = {}) {
  if (sync.running) return { ok: false, error: 'already running' };
  if (!c || state.status !== 'ready') return { ok: false, error: 'not linked' };
  if (backfill.running) return { ok: false, error: 'history import is running' };
  Object.assign(sync, { running: true, reason, chats: 0, done: 0, newMessages: 0, newMedia: 0, startedAt: Date.now(), finishedAt: null, lastError: null });
  try {
    await installKeyShim(c);                     // a page reload would have taken it away
    if (!chatIds) await syncChatList(c);
    const targets = chatIds
      ? chatIds.map((id) => ({ id, synced_ts: 0 }))
      : messages.chatsNeedingSync(CATCHUP_CHATS);
    sync.chats = targets.length;
    const wantConvo = captureConversations();
    for (const t of targets) {
      if (state.status !== 'ready') break;
      let chat = null;
      try { chat = await withTimeout(c.getChatById(t.id), 30000, 'getChatById'); } catch (e) { sync.lastError = describeError(e); }
      if (!chat) { sync.done++; continue; }
      try { chat._wbName = await chatDisplayName(chat, null); } catch (_) {}
      let msgs = [];
      try { msgs = await withTimeout(chat.fetchMessages({ limit }), 45000, 'fetch ' + (chat._wbName || t.id)); }
      catch (e) { sync.lastError = describeError(e); sync.done++; continue; }
      const rows = [];
      let newest = t.synced_ts || 0;
      for (const msg of msgs) {
        const ts = msg.timestamp ? msg.timestamp * 1000 : 0;
        if (ts > newest) newest = ts;
        // Already held: nothing to download, nothing to insert.
        const key = msgKey(msg);
        if (key && messages.getById(key) && (!msg.hasMedia || store.has(key))) continue;
        let mediaRec = null;
        try { mediaRec = await withTimeout(saveMediaMessage(msg, chat), cfg.DOWNLOAD_TIMEOUT_MS, 'download'); if (mediaRec) { sync.newMedia++; try { require('./ai').noteNewMedia(mediaRec); } catch (_) {} } }
        catch (e) { /* media gone or expired — the text is still worth keeping */ }
        if (wantConvo && keepInTranscript(msg)) {
          const row = buildMsgRow(msg, chat, mediaRec);
          if (row) rows.push(row);
        }
      }
      if (rows.length) sync.newMessages += messages.addMany(rows);
      messages.noteSynced(t.id, newest);
      sync.done++;
    }
    if (sync.newMedia) { try { require('./backup').nudge(); } catch (_) {} }
    if (sync.lastError && sync.done) console.warn(`[sync] ${reason}: last problem — ${sync.lastError}`);
    if (sync.newMessages || sync.newMedia) console.log(`[sync] ${reason}: ${sync.done} chats checked, ${sync.newMessages} messages and ${sync.newMedia} files that were missing`);
    else console.log(`[sync] ${reason}: ${sync.done} chats checked, nothing was missing`);
    return { ok: true, chats: sync.done, newMessages: sync.newMessages, newMedia: sync.newMedia };
  } catch (e) {
    sync.lastError = describeError(e);
    console.error('[sync] failed:', describeError(e));
    return { ok: false, error: describeError(e) };
  } finally {
    sync.running = false; sync.finishedAt = Date.now(); sync.lastAt = Date.now();
  }
}

function scheduleCatchUp(c, delay) {
  clearTimeout(catchUpTimer);
  catchUpTimer = setTimeout(async () => {
    if (c !== client || state.status !== 'ready') return;
    try { await catchUp(c, { reason: 'periodic' }); } catch (_) {}
    scheduleCatchUp(c, CATCHUP_EVERY_MS);
  }, delay);
  if (catchUpTimer.unref) catchUpTimer.unref();
}

// Build a conversation row from a message (+ optional saved-media record).
function buildMsgRow(msg, chat, mediaRec) {
  const id = msgKey(msg);
  if (!id) return null;
  const ts = msg.timestamp ? msg.timestamp * 1000 : Date.now();
  // When the chat could not be read, the message itself says where it
  // belongs — but for one you sent, `from` is you and the chat is `to`.
  const chatId = (chat && chat.id && chat.id._serialized) || (msg.fromMe ? msg.to : msg.from) || 'unknown';
  let known = null;
  if (!chat) { try { known = messages.getChat(chatId); } catch (_) {} }
  const chatName = (chat && (chat._wbName || chat.name)) || cachedChatName(chat)
    || (known && known.name) || contacts.resolve(chatId) || 'unknown';
  // Link to the saved media file: the fresh record, or an already-captured one.
  const existing = mediaRec || store.get(id);
  const rawAuthor = msg.fromMe ? 'me' : (chat && chat.isGroup ? (msg.author ? String(msg.author) : '') : null);
  return {
    id, chatId, chatName, ts, fromMe: !!msg.fromMe,
    // The raw id is kept so a name learned later can be filled in; the
    // resolved name travels beside it for the thread to show.
    author: rawAuthor === null ? null : (rawAuthor || authorName(msg, chat)),
    authorName: msg.fromMe ? 'me' : (chat && chat.isGroup ? (contacts.resolve(msg.author) || (msg._data && msg._data.notifyName) || null) : null),
    type: msg.type || 'chat',
    body: require('./content/message-text')(msg.body),
    mediaKind: existing ? existing.kind : (KIND_BY_TYPE[msg.type] || null),
    mediaServe: existing ? existing.serve : null,
    mediaId: existing ? existing.id : null,
  };
}

function keepInTranscript(msg) {
  if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return false;
  if (SKIP_TYPES.has(msg.type)) return false;
  if (!msg.body && !msg.hasMedia && msg.type === 'chat') return false;
  return true;
}

// The library's Message.downloadMedia() looks the message up by
// msg.id._serialized (now undefined), so it asks WhatsApp for message
// "undefined" and gets back a minified error. Same download sequence, real key.
async function downloadMediaByKey(key) {
  return client.pupPage.evaluate(async (msgId) => {
    const Collections = window.require('WAWebCollections');
    let msg = Collections.Msg.get(msgId);
    if (!msg) {
      const got = await Collections.Msg.getMessagesById([msgId]);
      msg = got && got.messages && got.messages[0];
    }
    // Not in the page's collection at all — genuinely nothing to fetch (a silent
    // skip). But a message that IS here yet carries no mediaData is the exact
    // shape of a WhatsApp rename: report it as unavailable so a live failure
    // counts against health instead of vanishing silently.
    if (!msg) return null;
    if (!msg.mediaData) return { unavailable: 'media data missing — WhatsApp internals may have changed' };
    if (msg.mediaData.mediaStage === 'REUPLOADING') return { unavailable: 'expired (WhatsApp no longer has the file)' };
    // WhatsApp's own errors here are minified, so report the media stage — that
    // is the part that says whether the file is simply gone.
    if (msg.mediaData.mediaStage !== 'RESOLVED') {
      try { await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 }); }
      catch (e) { return { unavailable: 'not retrievable (stage ' + (msg.mediaData.mediaStage || '?') + ')' }; }
    }
    const stage = msg.mediaData.mediaStage || '';
    if (stage.includes('ERROR') || stage === 'FETCHING') return { unavailable: 'not retrievable (stage ' + stage + ')' };
    const qpl = { addAnnotations() { return this; }, addPoint() { return this; } };
    // WhatsApp's downloader checks the file's type against the kind of media
    // since early October 2026, and takes application/octet-stream when none is
    // given — which it then refuses for every photo and video
    // (InvalidMediaFileType). The message knows its own type; pass it on.
    // (wwebjs/whatsapp-web.js#201908, open upstream.)
    const FALLBACK_TYPE = { image: 'image/jpeg', video: 'video/mp4', ptt: 'audio/ogg; codecs=opus', audio: 'audio/mpeg', sticker: 'image/webp', document: 'application/octet-stream' };
    const mimetype = msg.mimetype || FALLBACK_TYPE[msg.type] || 'application/octet-stream';
    let bytes;
    try {
      bytes = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash,
        mediaKey: msg.mediaKey, mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type,
        mimetype, signal: new AbortController().signal, downloadQpl: qpl,
      });
    } catch (e) {
      return { unavailable: 'download failed — ' + ((e && e.name) || 'error') + ': ' + ((e && e.message) || 'unknown') };
    }
    return { data: await window.WWebJS.arrayBufferToBase64Async(bytes), mimetype };
  }, key);
}

// Shared by live capture AND history import. Returns the record, or null.
async function saveMediaMessage(msg, chatObj) {
  if (!msg.hasMedia) return null;
  if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return null;
  const kind = KIND_BY_TYPE[msg.type];
  if (!kind) return null;

  let chat = chatObj;
  if (!chat) { try { chat = await msg.getChat(); } catch (_) { chat = null; } }
  if (chat && !chat._wbName) { try { chat._wbName = await chatDisplayName(chat, msg); } catch (_) {} }
  if (!shouldCapture(msg, chat, kind)) return null;

  const id = msgKey(msg);
  if (!id || store.has(id)) return null;

  const media = await downloadMediaByKey(id);
  if (media && media.unavailable) throw new Error(media.unavailable);
  if (!media || !media.data) return null;

  const ts = msg.timestamp ? msg.timestamp * 1000 : Date.now();
  const dir = msg.fromMe ? 'out' : 'in';
  const chatName = (chat && (chat._wbName || chat.name)) || cachedChatName(chat) || 'unknown';
  const number = (chat && chat.id && chat.id.user) || '';

  const ext = extFor(media.mimetype, msg.type === 'document' ? (msg._data && msg._data.filename) : '');
  const filename = `${stamp(ts)}__${dir}__${sanitize(chatName)}__${id.replace(/[^A-Za-z0-9]/g, '').slice(-10)}.${ext}`;
  const buf = Buffer.from(media.data, 'base64');

  // Async writes so a slow cloud-drive write doesn't block the shared event loop
  // (which also serves the dashboard the user is looking at).
  const area = AREA_BY_KIND[kind];
  const cloudTarget = cfg.CLOUD_AVAILABLE && area === 'videos' ? require('./backup').cloudPathFor({ kind, filename, ts, source: 'whatsapp' }) : null;
  let destination = cloudTarget || path.join(area === 'videos' ? cfg.LOCAL_VIDEO_DIR : area === 'files' ? cfg.FILES_DIR : cfg.IMAGES_DIR, filename);
  try {
    try { await fs.promises.mkdir(path.dirname(destination), { recursive: true }); await fs.promises.writeFile(destination, buf); }
    catch (error) {
      if (!cloudTarget) throw error;
      destination = path.join(cfg.LOCAL_VIDEO_DIR, filename);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true }); await fs.promises.writeFile(destination, buf);
    }
  } catch (e) {
    // Tagged so the health net can tell "the drive went away" from "WhatsApp
    // changed its internals". They need opposite reactions from the user.
    e.storage = true;
    throw e;
  }
  if (area === 'images' && mirrorImages()) {
    try {
      const mirror = require('./backup').cloudPathFor({ kind, filename, ts, source:'whatsapp' });
      if (mirror) { await fs.promises.mkdir(path.dirname(mirror), { recursive: true }); await fs.promises.writeFile(mirror, buf); }
    } catch (_) {}
  }
  const serve = `/media/${area}/` + encodeURIComponent(filename);

  const rec = {
    id, ts, dir, kind, chat: chatName, number, mimetype: media.mimetype,
    filename, serve, size: buf.length, caption: require('./content/message-text')(msg.body),
    docName: msg.type === 'document' ? (msg._data && msg._data.filename) || '' : '',
    cloud: !!cloudTarget && destination === cloudTarget,
  };
  store.addRecord(rec);
  return rec;
}

async function handleMessage(msg) {
  let chat = null;
  try { chat = await msg.getChat(); } catch (_) {}
  if (chat) { try { chat._wbName = await chatDisplayName(chat, msg); } catch (_) {} }
  // Media and transcript are tracked separately: a failed download must not
  // cost us the message text, and only download failures count against health.
  try {
    const rec = await saveMediaMessage(msg, chat);
    if (rec) {
      noteCaptureOk();
      console.log(`[capture] ${new Date(rec.ts).toLocaleString()}  ${rec.kind.toUpperCase()} ${rec.dir === 'out' ? '→sent' : '←recv'}  ${rec.chat}  (${(rec.size / 1024).toFixed(0)} KB)`);
      try { require('./ai').noteNewMedia(rec); } catch (_) {}
      try { require('./backup').nudge(); } catch (_) {}
    }
  } catch (e) {
    if (e && e.storage) {
      // The download worked and the bytes are in hand; we just couldn't write
      // them. Counting this as a capture failure would put "WhatsApp may have
      // changed" in front of someone whose cloud drive is simply offline.
      health.lastStorageError = describeError(e);
      health.lastStorageErrorAt = Date.now();
      console.error('[capture] could not save the file:', describeError(e), '— check the media folder or cloud drive.');
    } else {
      noteCaptureFail(e);
      console.error('[capture] download failed:', describeError(e), `(${health.consecutiveFailures} in a row)`);
      if (captureBroken()) console.error('[capture] capture looks broken — WhatsApp may have changed again. Check for an update.');
    }
  }
  try {
    if (captureConversations() && keepInTranscript(msg)) {
      const row = buildMsgRow(msg, chat, null);
      if (row) {
        messages.addMessage(row);
        try { require('./ai').noteNewMessages(row.chatId); } catch (_) {}
      }
    }
  } catch (e) { console.error('[capture] transcript error:', describeError(e)); }
}

// Edits and deletions after the fact. The archive keeps what was said; it only
// notes that WhatsApp's copy changed.
function handleEdit(msg, newBody) {
  try { const id = msgKey(msg); if (id) messages.updateBody(id, newBody != null ? String(newBody) : (msg.body || '')); } catch (_) {}
}
function handleRevoke(after, before) {
  try { const id = msgKey(before || after); if (id) messages.markRevoked(id); } catch (_) {}
}

let client = null;

// Read the chat list straight from WhatsApp's own collection, taking only the
// few fields the import needs and skipping any chat we can't read. Unlike the
// library's getChats(), this touches no group metadata / LID / last-message
// code, so one chat WhatsApp changed under us can't sink the whole import.
async function readChatRows(c) {
  return withTimeout(c.pupPage.evaluate(() => {
    const out = [];
    for (const chat of window.require('WAWebCollections').Chat.getModelsArray()) {
      try {
        const id = chat && chat.id && chat.id._serialized;
        if (!id) continue;
        const r = { id, user: chat.id.user || '', server: chat.id.server || '', title: '', pushname: '', verifiedName: '', isGroup: false, archived: false, t: 0 };
        try { r.title = chat.formattedTitle || chat.name || ''; } catch (_) {}
        try { const ct = chat.contact; if (ct) { r.pushname = ct.pushname || ''; r.verifiedName = ct.verifiedName || ''; } } catch (_) {}
        try { r.isGroup = !!chat.groupMetadata || chat.id.server === 'g.us'; } catch (_) {}
        try { r.archived = !!chat.archive; } catch (_) {}
        try { r.t = chat.t || 0; } catch (_) {}
        out.push(r);
      } catch (_) {}
    }
    return out;
  }), 60000, 'readChatRows');
}
async function listChatsTolerant(c) {
  const rows = await readChatRows(c);
  return rows.map((r) => new Chat(c, {
    id: { _serialized: r.id, user: r.user, server: r.server },
    formattedTitle: r.title || r.user || '',
    isGroup: r.isGroup, t: r.t, _wbArchived: r.archived,
  }));
}

// Prefer the library's own listing; fall back when a new WhatsApp Web build
// breaks it (which is what "import error: r" was).
async function listChatsForImport(c) {
  try {
    return await withTimeout(c.getChats(), 60000, 'getChats');
  } catch (e) {
    console.warn('[history] getChats() failed (' + describeError(e) + ') — using the tolerant chat listing instead.');
    logStack(e);
    return await listChatsTolerant(c);
  }
}

// Pull historical media from existing chats (best-effort — WhatsApp limits
// how far back a linked device can see).
async function runBackfill(limitPerChat) {
  if (backfill.running) return backfill;
  if (!client || state.status !== 'ready') { backfill.error = 'not linked yet'; return backfill; }
  const limit = limitPerChat || settings.read().backfillLimit || cfg.BACKFILL_LIMIT;
  Object.assign(backfill, { running: true, saved: 0, skipped: 0, messages: 0, doneChats: 0, totalChats: 0, startedAt: Date.now(), finishedAt: null, error: null });
  console.log(`[history] Import started (up to ${limit} messages/chat)…`);
  // Tally why items were skipped — otherwise "565 skipped" says nothing about
  // whether the media is simply too old or something broke.
  const skipReasons = new Map();
  const noteSkip = (e) => {
    backfill.skipped++;
    const k = describeError(e).slice(0, 120);
    skipReasons.set(k, (skipReasons.get(k) || 0) + 1);
  };
  try {
    const chats = await listChatsForImport(client);
    backfill.totalChats = chats.length;
    for (const chat of chats) {
      const name = (chat && chat.name) || (chat && chat.id && chat.id.user) || '?';
      let msgs = [];
      try { msgs = await withTimeout(chat.fetchMessages({ limit }), 30000, 'fetch ' + name); }
      catch (e) { noteSkip(e); console.warn(`[history] skip chat "${name}" (${describeError(e)})`); backfill.doneChats++; continue; }
      const wantConvo = captureConversations();
      const convoRows = [];
      let newest = 0;
      for (const msg of msgs) {
        const ts = msg.timestamp ? msg.timestamp * 1000 : 0;
        if (ts > newest) newest = ts;
        let mediaRec = null;
        try { mediaRec = await withTimeout(saveMediaMessage(msg, chat), cfg.DOWNLOAD_TIMEOUT_MS, 'download'); if (mediaRec) { backfill.saved++; try { require('./ai').noteNewMedia(mediaRec); } catch (_) {} } }
        catch (e) { noteSkip(e); }
        if (wantConvo && keepInTranscript(msg)) {
          const row = buildMsgRow(msg, chat, mediaRec);
          if (row) convoRows.push(row);
        }
      }
      if (convoRows.length) backfill.messages += messages.addMany(convoRows);
      const chatId = chat && chat.id && chat.id._serialized;
      if (chatId) { try { messages.noteSynced(chatId, newest); } catch (_) {} }
      backfill.doneChats++;
      if (backfill.doneChats % 10 === 0) console.log(`[history] ${backfill.doneChats}/${backfill.totalChats} chats · ${backfill.saved} saved · ${backfill.skipped} skipped`);
    }
    console.log(`[history] Import done. ${backfill.saved} new items from ${backfill.totalChats} chats (${backfill.skipped} skipped).`);
    for (const [reason, n] of [...skipReasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`[history] skipped ${n} × ${reason}`);
    }
  } catch (e) {
    backfill.error = "Couldn't read your chat list — " + describeError(e);
    console.error('[history] import error:', describeError(e));
    logStack(e);
  }
  backfill.running = false;
  backfill.finishedAt = Date.now();
  // Kept in settings rather than memory: "last synced" is the first thing
  // looked at after a restart, which is exactly when memory is empty.
  try { settings.write({ lastImportAt: backfill.finishedAt }); } catch (_) {}
  return backfill;
}

// ---------- status stories ----------
// The one door through which a status leaves this machine. Content is
// {type:'text'|'image'|'video', text?, filePath?, caption?}. The library has
// first-class support — sendMessage to status@broadcast — and returns null
// (with a console warning) rather than throwing when it refuses a type, so
// null is turned back into an error the caller can log and count.
async function sendStatus(content) {
  if (!client) throw new Error('Not running');
  if (state.status !== 'ready') throw new Error('Not linked — status ' + state.status);
  const { MessageMedia } = require('whatsapp-web.js');
  let payload;
  const options = {};
  if (content.type === 'text') {
    payload = String(content.text || '').trim().slice(0, 700);
    if (!payload) throw new Error('Empty status text');
  } else {
    payload = MessageMedia.fromFilePath(content.filePath);
    if (content.caption) options.caption = String(content.caption).slice(0, 700);
  }
  const timeoutMs = content.type === 'video' ? 240000 : 90000;
  const msg = await withTimeout(client.sendMessage('status@broadcast', payload, options), timeoutMs, 'status post');
  if (!msg) throw new Error('WhatsApp refused this status type (see engine log)');
  return { id: msgKey(msg), ts: msg.timestamp ? msg.timestamp * 1000 : Date.now() };
}

// The status-card renderer borrows the browser this client already owns.
const getBrowser = () => (client && client.pupBrowser) || null;

function browserUserAgent() {
  let major = '146';
  try {
    const m = /win64-(\d+)\./.exec(String(cfg.CHROME_PATH || '')) || /^(\d+)\./.exec(process.versions.chrome || '');
    if (m) major = m[1];
  } catch (_) {}
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';
}

function buildClient() {
  // Chromium's sandbox works out of the box on Windows — the --no-sandbox pair
  // this used to carry are Linux/CI habits, and running unsandboxed while
  // rendering media from strangers is exposure we don't need. WB_NO_SANDBOX is
  // the escape hatch if some machine turns out to need it.
  // WhatsApp Web answers a browser that calls itself HeadlessChrome with
  // "update Chrome" and nothing else - from one morning on, after months of
  // working. It is the same Chrome; it gives the name of the Chrome it is.
  const args = ['--disable-gpu', '--user-agent=' + browserUserAgent(), '--disable-blink-features=AutomationControlled'];
  if (process.env.WB_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  // WA_DEBUG_PORT opens Chrome's debugging port so the WhatsApp Web page can be
  // inspected while the app runs — needed whenever WhatsApp changes its
  // internals and the library starts throwing minified errors.
  if (process.env.WA_DEBUG_PORT) args.push('--remote-debugging-port=' + process.env.WA_DEBUG_PORT);

  const puppeteerOpts = {
    // WhatsApp Web can take minutes to come up on a large account; the
    // three-minute default was hit once and left the link in "error".
    protocolTimeout: 10 * 60 * 1000, headless: true, args, ignoreDefaultArgs: ['--enable-automation'] };
  if (cfg.CHROME_PATH) puppeteerOpts.executablePath = cfg.CHROME_PATH;  // the Chrome we ship

  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: cfg.AUTH_DIR }),
    // A stale cached WhatsApp bundle can authenticate but never finish syncing.
    // Keep the linked session, but fetch the current web application on startup.
    webVersionCache: { type: 'none' },
    puppeteer: puppeteerOpts,
  });

  c.on('qr', async (qr) => {
    clearTimeout(startWatchdog);
    state.status = 'qr';
    try { state.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 }); } catch (_) {}
    console.log(`\n[link] Scan required at http://localhost:${cfg.PORT}\n`);
  });
  // Accepted is not ready. On 2026-10-11 WhatsApp Web accepted the session and
  // synced, then the library hung hooking into its events and never said ready —
  // so the watchdog stays armed until ready, and a link stuck between the two is
  // restarted like one that never started.
  c.on('authenticated', () => { state.status = 'authenticated'; state.qrDataUrl = null; if (c === client) watchStart(ACCEPTED_TO_READY_MS); });
  c.on('ready', () => {
    clearTimeout(startWatchdog); startAttempts = 0;
    state.status = 'ready';
    state.lastError = null;
    state.qrDataUrl = null;
    state.needsRelink = false;
    reconnecting = false;
    reconnectAttempts = 0;
    try { const i = c.info; state.me = (i && (i.pushname || (i.wid && i.wid.user))) || 'linked'; } catch (_) { state.me = 'linked'; }
    console.log(`[link] Ready. Linked as ${state.me}. Capturing images & videos now.`);
    // The address book first, so names resolve; then the chat list; then the
    // chats that moved while we were away.
    readyClient = c;
    (async () => {
      const shim = await installKeyShim(c);
      if (shim !== 'not needed') console.log('[link] message keys: ' + shim);
      try { await syncContacts(c, { reason: 'connected' }); } catch (e) { console.warn('[contacts] load failed:', e.message); }
      try { await syncChatList(c); } catch (e) { console.warn('[chats] list failed:', e.message); }
      try { require('./maintenance').refileSentOnce(); } catch (_) {}
      try { await repairUnknownChats(c); } catch (_) {}
      scheduleCatchUp(c, CATCHUP_DELAY_MS);
    })();
  });
  // Edits, deletions and renames after the fact.
  c.on('message_edit', (msg, newBody) => handleEdit(msg, newBody));
  c.on('message_revoke_everyone', (after, before) => handleRevoke(after, before));
  c.on('group_update', () => { chatNames.clear(); if (c === client) syncChatList(c).catch(() => {}); });
  c.on('contact_changed', () => { chatNames.clear(); });
  c.on('auth_failure', (m) => { state.status = 'error'; state.lastError = 'auth_failure: ' + m; });
  c.on('disconnected', (reason) => {
    // Terminal reasons mean the phone unlinked this device — retrying is futile;
    // tell the user to re-scan instead of looping.
    if (/LOGOUT|UNPAIRED|CONFLICT|DEPRECATED/i.test(String(reason))) {
      state.status = 'error';
      state.needsRelink = true;
      state.lastError = `Device was unlinked (${reason}). Open the dashboard and re-scan the QR to reconnect.`;
      console.warn('[link] Terminal disconnect:', reason, '- needs re-link.');
      return;
    }
    state.status = 'disconnected';
    state.lastError = 'disconnected: ' + reason;
    scheduleReconnect(c);
  });
  c.on('message_create', handleMessage);
  return c;
}

// Reconnect with exponential backoff (capped), a single-flight guard, and a
// reschedule if the attempt itself fails — so a transient failure doesn't
// permanently kill capture.
function scheduleReconnect(c) {
  if (c !== client) return;                              // not the one that is running any more
  if (reconnecting) return;
  reconnecting = true;
  const delay = Math.min(60000, 5000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  console.warn(`[link] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})…`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    c.initialize()
      .then(() => { reconnecting = false; })
      .catch((e) => { reconnecting = false; console.error('[link] reconnect failed:', e.message); scheduleReconnect(c); });
  }, delay);
}

// A start that neither succeeds nor fails is the worst kind: no QR, no
// "ready", no error — and no browser, once, for nine minutes, after a start
// that had timed out and been killed. Nothing is captured while it waits.
// So a start is watched: make no progress for this long and it is torn
// down and begun again, a few times, with the wait growing each time.
const START_WATCHDOG_MS = 4 * 60 * 1000;          // launch to accepted: a QR or a slow load can take a while
const ACCEPTED_TO_READY_MS = 90 * 1000;           // accepted to ready is about a second when it works
let startAttempts = 0;
let startWatchdog = null;

function watchStart(ms = START_WATCHDOG_MS) {
  clearTimeout(startWatchdog);
  startWatchdog = setTimeout(async () => {
    if (state.status === 'ready') return;               // it got there
    if (state.status === 'qr') return;                  // waiting on a person, not stuck
    if (state.status === 'error' && state.needsRelink) return;
    startAttempts++;
    // Never give up: a stall is WhatsApp's page misbehaving for a moment, and
    // giving up meant no capture until someone restarted the app. The wait
    // between tries grows to five minutes instead.
    console.error(`[link] not ready after ${Math.round(ms / 1000)}s (stuck at ${state.status}) — restarting the link (attempt ${startAttempts})`);
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const old = client; client = null;                  // nothing may reconnect the old one now
    try { if (old) await withTimeout(old.destroy(), 15000, 'closing stalled WhatsApp'); }
    catch (_) { try { old && old.pupBrowser && old.pupBrowser.process() && old.pupBrowser.process().kill(); } catch (_) {} }
    setTimeout(() => startClient({ retry: true }), Math.min(5 * 60000, 5000 * startAttempts));
  }, ms);
  if (startWatchdog.unref) startWatchdog.unref();
}

function startClient({ retry = false } = {}) {
  if (!retry) {
    store.loadAll();
    try { messages.init(); } catch (e) { console.error('[messages] init failed:', e.message); }
    // Names known from the last session, before the link is even up.
    try { const n = contacts.loadFromDb(); if (n) console.log('[contacts] ' + n + ' names loaded from the database'); } catch (_) {}
  }
  // For tests and for working on the dashboard: everything but the phone link.
  if (process.env.WB_NO_WHATSAPP === '1') {
    state.status = 'disconnected';
    state.lastError = 'WhatsApp link disabled (WB_NO_WHATSAPP=1)';
    console.log('[link] disabled by WB_NO_WHATSAPP — dashboard and archive only');
    return null;
  }
  state.status = 'starting';
  client = buildClient();
  watchStart();
  // A failed first start is retried the way a dropped link is, rather than
  // left as an error until someone restarts the app.
  const mine = client;
  client.initialize().catch((e) => {
    if (client !== mine) return;                         // torn down by the watchdog; it is starting a fresh one
    state.status = 'error'; state.lastError = e.message; console.error('[link] initialize failed:', e.message); scheduleReconnect(mine);
  });
  return client;
}

// Unlink this device and come back with a fresh QR. logout() tells the phone,
// which is the polite path; if it fails we still drop the local session so the
// user isn't stuck with a half-linked app.
async function unlink() {
  const c = client;
  if (!c) return { ok: false, message: 'Not running' };
  try { await c.logout(); }
  catch (e) { console.warn('[link] logout failed, dropping local session anyway:', describeError(e)); }
  state.status = 'starting';
  state.me = null;
  state.needsRelink = false;
  try { await c.destroy(); } catch (_) {}
  client = buildClient();
  client.initialize().catch((e) => { state.status = 'error'; state.lastError = describeError(e); });
  return { ok: true };
}

// Ask for a reconnect now instead of waiting out the backoff.
function reconnectNow() {
  if (!client) { startClient({ retry: true }); return { ok: true }; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnecting = false;
  reconnectAttempts = 0;
  scheduleReconnect(client);
  return { ok: true };
}

const whenLinked = (fn) => (readyClient && state.status === 'ready' && readyClient === client)
  ? fn(readyClient) : Promise.resolve({ ok: false, error: 'not linked' });

module.exports = {
  repairNames: () => readyClient ? repairUnknownChats(readyClient, { reason: 'manual' }) : Promise.resolve({ checked: 0, fixed: 0, error: 'not linked' }),
  syncContacts: () => whenLinked(async (c) => { const n = await syncContacts(c, { reason: 'manual' }); await repairUnknownChats(c, { reason: 'manual' }); return { ok: true, names: n }; }),
  catchUp: (opts) => whenLinked((c) => catchUp(c, { reason: 'manual', ...(opts || {}) })),
  syncChat: (chatId, limit) => whenLinked((c) => catchUp(c, { reason: 'chat', chatIds: [chatId], limit: Math.min(1000, Math.max(20, limit || 200)) })),
  getSyncState: () => ({ ...sync }),
  startClient, getState, runBackfill, unlink, reconnectNow, sendStatus, getBrowser,
};
