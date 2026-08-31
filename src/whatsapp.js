'use strict';
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
  };
}

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/wav': 'wav', 'application/pdf': 'pdf',
};
const extFor = (m) => EXT[(m || '').split(';')[0]] || ((m || '').split(';')[0].split('/')[1]) || 'bin';
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

// Build a conversation row from a message (+ optional saved-media record).
function buildMsgRow(msg, chat, mediaRec) {
  const id = msgKey(msg);
  if (!id) return null;
  const ts = msg.timestamp ? msg.timestamp * 1000 : Date.now();
  const chatId = (chat && chat.id && chat.id._serialized) || msg.from || 'unknown';
  const chatName = (chat && chat.name) || (chat && chat.id && chat.id.user) || 'unknown';
  // Link to the saved media file: the fresh record, or an already-captured one.
  const existing = mediaRec || store.get(id);
  return {
    id, chatId, chatName, ts, fromMe: !!msg.fromMe,
    author: authorName(msg, chat),
    type: msg.type || 'chat',
    body: msg.body || '',
    mediaKind: existing ? existing.kind : (msg.type === 'image' ? 'image' : msg.type === 'video' ? 'video' : null),
    mediaServe: existing ? existing.serve : null,
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
    let bytes;
    try {
      bytes = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash,
        mediaKey: msg.mediaKey, mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type,
        signal: new AbortController().signal, downloadQpl: qpl,
      });
    } catch (e) {
      return { unavailable: 'download failed — ' + ((e && e.name) || 'error') + ': ' + ((e && e.message) || 'unknown') };
    }
    return { data: await window.WWebJS.arrayBufferToBase64Async(bytes), mimetype: msg.mimetype };
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
  if (!shouldCapture(msg, chat, kind)) return null;

  const id = msgKey(msg);
  if (!id || store.has(id)) return null;

  const media = await downloadMediaByKey(id);
  if (media && media.unavailable) throw new Error(media.unavailable);
  if (!media || !media.data) return null;

  const ts = msg.timestamp ? msg.timestamp * 1000 : Date.now();
  const dir = msg.fromMe ? 'out' : 'in';
  const chatName = (chat && (chat.name || (chat.id && chat.id.user))) || 'unknown';
  const number = (chat && chat.id && chat.id.user) || '';

  const ext = extFor(media.mimetype);
  const filename = `${stamp(ts)}__${dir}__${sanitize(chatName)}__${id.replace(/[^A-Za-z0-9]/g, '').slice(-10)}.${ext}`;
  const buf = Buffer.from(media.data, 'base64');

  // Async writes so a slow cloud-drive write doesn't block the shared event loop
  // (which also serves the dashboard the user is looking at).
  const area = AREA_BY_KIND[kind];
  const target = area === 'videos' ? cfg.VIDEO_DIR : area === 'files' ? cfg.FILES_DIR : cfg.IMAGES_DIR;
  try {
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(path.join(target, filename), buf);
  } catch (e) {
    // Tagged so the health net can tell "the drive went away" from "WhatsApp
    // changed its internals". They need opposite reactions from the user.
    e.storage = true;
    throw e;
  }
  if (area === 'images' && mirrorImages()) {
    try {
      await fs.promises.mkdir(cfg.IMAGE_CLOUD_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(cfg.IMAGE_CLOUD_DIR, filename), buf);
    } catch (_) {}
  }
  const serve = `/media/${area}/` + encodeURIComponent(filename);

  const rec = {
    id, ts, dir, kind, chat: chatName, number, mimetype: media.mimetype,
    filename, serve, size: buf.length, caption: msg.body || '',
    docName: msg.type === 'document' ? (msg._data && msg._data.filename) || '' : '',
    cloud: area === 'videos' ? cfg.CLOUD_AVAILABLE : false,
  };
  store.addRecord(rec);
  return rec;
}

async function handleMessage(msg) {
  let chat = null;
  try { chat = await msg.getChat(); } catch (_) {}
  // Media and transcript are tracked separately: a failed download must not
  // cost us the message text, and only download failures count against health.
  try {
    const rec = await saveMediaMessage(msg, chat);
    if (rec) {
      noteCaptureOk();
      console.log(`[capture] ${new Date(rec.ts).toLocaleString()}  ${rec.kind.toUpperCase()} ${rec.dir === 'out' ? '→sent' : '←recv'}  ${rec.chat}  (${(rec.size / 1024).toFixed(0)} KB)`);
      try { require('./ai').noteNewMedia(rec); } catch (_) {}
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
      if (row) messages.addMessage(row);
    }
  } catch (e) { console.error('[capture] transcript error:', describeError(e)); }
}

let client = null;

// Read the chat list straight from WhatsApp's own collection, taking only the
// few fields the import needs and skipping any chat we can't read. Unlike the
// library's getChats(), this touches no group metadata / LID / last-message
// code, so one chat WhatsApp changed under us can't sink the whole import.
async function listChatsTolerant(c) {
  const rows = await withTimeout(c.pupPage.evaluate(() => {
    const out = [];
    for (const chat of window.require('WAWebCollections').Chat.getModelsArray()) {
      try {
        const id = chat && chat.id && chat.id._serialized;
        if (!id) continue;
        let title = '';
        try { title = chat.formattedTitle || chat.name || ''; } catch (_) {}
        let isGroup = false;
        try { isGroup = !!chat.groupMetadata || chat.id.server === 'g.us'; } catch (_) {}
        out.push({
          id: { _serialized: id, user: chat.id.user || '', server: chat.id.server || '' },
          formattedTitle: title || chat.id.user || '',
          isGroup,
          t: chat.t || 0,
        });
      } catch (_) {}
    }
    return out;
  }), 60000, 'listChatsTolerant');
  return rows.map((r) => new Chat(c, r));
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
      for (const msg of msgs) {
        let mediaRec = null;
        try { mediaRec = await withTimeout(saveMediaMessage(msg, chat), cfg.DOWNLOAD_TIMEOUT_MS, 'download'); if (mediaRec) backfill.saved++; }
        catch (e) { noteSkip(e); }
        if (wantConvo && keepInTranscript(msg)) {
          const row = buildMsgRow(msg, chat, mediaRec);
          if (row) convoRows.push(row);
        }
      }
      if (convoRows.length) backfill.messages += messages.addMany(convoRows);
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

function buildClient() {
  // Chromium's sandbox works out of the box on Windows — the --no-sandbox pair
  // this used to carry are Linux/CI habits, and running unsandboxed while
  // rendering media from strangers is exposure we don't need. WB_NO_SANDBOX is
  // the escape hatch if some machine turns out to need it.
  const args = ['--disable-gpu'];
  if (process.env.WB_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  // WA_DEBUG_PORT opens Chrome's debugging port so the WhatsApp Web page can be
  // inspected while the app runs — needed whenever WhatsApp changes its
  // internals and the library starts throwing minified errors.
  if (process.env.WA_DEBUG_PORT) args.push('--remote-debugging-port=' + process.env.WA_DEBUG_PORT);

  const puppeteerOpts = { headless: true, args };
  if (cfg.CHROME_PATH) puppeteerOpts.executablePath = cfg.CHROME_PATH;  // the Chrome we ship

  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: cfg.AUTH_DIR }),
    puppeteer: puppeteerOpts,
  });

  c.on('qr', async (qr) => {
    state.status = 'qr';
    try { state.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 }); } catch (_) {}
    console.log(`\n[link] Scan required at http://localhost:${cfg.PORT}\n`);
  });
  c.on('authenticated', () => { state.status = 'authenticated'; state.qrDataUrl = null; });
  c.on('ready', () => {
    state.status = 'ready';
    state.qrDataUrl = null;
    state.needsRelink = false;
    reconnecting = false;
    reconnectAttempts = 0;
    try { const i = c.info; state.me = (i && (i.pushname || (i.wid && i.wid.user))) || 'linked'; } catch (_) { state.me = 'linked'; }
    console.log(`[link] Ready. Linked as ${state.me}. Capturing images & videos now.`);
    // Load the address book so group authors resolve to names.
    c.getContacts().then((cs) => console.log('[contacts] loaded', contacts.load(cs), 'names')).catch((e) => console.warn('[contacts] load failed:', e.message));
  });
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

function startClient() {
  store.loadAll();
  try { messages.init(); } catch (e) { console.error('[messages] init failed:', e.message); }
  client = buildClient();
  client.initialize().catch((e) => { state.status = 'error'; state.lastError = e.message; console.error('[link] initialize failed:', e.message); });
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
  if (!client) return { ok: false, message: 'Not running' };
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnecting = false;
  reconnectAttempts = 0;
  scheduleReconnect(client);
  return { ok: true };
}

module.exports = { startClient, getState, runBackfill, unlink, reconnectNow, sendStatus, getBrowser };
