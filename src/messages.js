'use strict';
// Conversation (text) store, backed by Node's built-in SQLite (no dependency).
// Kept separate from the media gallery index so the working gallery is untouched.
//
// Since 2.0 this file also holds the address book (`contacts`), the chat list
// as WhatsApp reports it (`chats`), and a full-text index over message bodies
// (`messages_fts`). One file, one WAL, one thing to back up.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
// Some WhatsApp image messages carry thumbnail bytes in the body; those are
// never text and never go to search, transcripts or the AI.
const readableBody = require('./content/message-text');
const readableRows = (rows) => rows.map((row) => ({ ...row, body: readableBody(row.body) }));

let db = null;
let ftsOk = false;

function init() {
  if (db) return db;
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(cfg.DATA_DIR, 'messages.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 4000;');
  db.exec(`CREATE TABLE IF NOT EXISTS messages(
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    chat_name TEXT,
    ts INTEGER NOT NULL,
    from_me INTEGER NOT NULL,
    author TEXT,
    type TEXT,
    body TEXT,
    media_kind TEXT,
    media_serve TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_ts ON messages(chat_id, ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ts ON messages(ts);');

  // Columns added after the first release. ALTER is cheap and idempotent here.
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('author_name')) db.exec('ALTER TABLE messages ADD COLUMN author_name TEXT');
  if (!cols.includes('edited')) db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0');
  if (!cols.includes('revoked')) db.exec('ALTER TABLE messages ADD COLUMN revoked INTEGER DEFAULT 0');
  if (!cols.includes('media_id')) db.exec('ALTER TABLE messages ADD COLUMN media_id TEXT');

  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);

  // The address book, persisted so names resolve from the first second after a
  // restart rather than only once WhatsApp has come back up.
  db.exec(`CREATE TABLE IF NOT EXISTS contacts(
    id TEXT PRIMARY KEY,
    number TEXT,
    name TEXT,
    pushname TEXT,
    short_name TEXT,
    lid TEXT,
    is_group INTEGER DEFAULT 0,
    is_me INTEGER DEFAULT 0,
    is_business INTEGER DEFAULT 0,
    is_my_contact INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_number ON contacts(number);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid);');

  // The chat list as WhatsApp itself reports it. A chat with no captured
  // message is still a chat, and this is how it gets to be listed, synced and
  // named before any text has been saved.
  db.exec(`CREATE TABLE IF NOT EXISTS chats(
    id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER DEFAULT 0,
    last_ts INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    synced_ts INTEGER DEFAULT 0,
    synced_at INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );`);

  // Full text over the bodies. External-content table: the words live only in
  // the index, the text stays in `messages`, and triggers keep the two in step.
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF body ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body); END;`);
    if (getMeta('fts_built') !== '1') {
      db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');`);
      setMeta('fts_built', '1');
    }
    ftsOk = true;
  } catch (e) {
    ftsOk = false;
    console.warn('[messages] full-text index unavailable, falling back to plain search:', e.message);
  }
  return db;
}

// For tests and tools that open a database of their own and want it released.
function close() {
  if (!db) return;
  try { db.close(); } catch (_) {}
  db = null; ftsOk = false; chatsCache = null;
}

function getMeta(key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/* ---------------- chat list cache ----------------
   listChats() runs a window function over every row; the dashboard asks for
   it every few seconds while the Conversations view is open. A five-second
   cache answers those from memory, and any write drops it. */
let chatsCache = null;
let chatsCacheAt = 0;
const CHATS_TTL_MS = 5000;
const dirty = () => { chatsCache = null; };

function addMessage(m) {
  init();
  try {
    db.prepare(`INSERT OR IGNORE INTO messages
      (id, chat_id, chat_name, ts, from_me, author, author_name, type, body, media_kind, media_serve, media_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      m.id, m.chatId, m.chatName || null, m.ts, m.fromMe ? 1 : 0,
      m.author || null, m.authorName || null, m.type || 'chat', readableBody(m.body), m.mediaKind || null, m.mediaServe || null, m.mediaId || null
    );
    dirty();
    return true;
  } catch (e) { return false; }
}

// Batch insert inside one transaction (fast for history import).
function addMany(list) {
  init();
  let n = 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO messages
    (id, chat_id, chat_name, ts, from_me, author, author_name, type, body, media_kind, media_serve, media_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const m of list) {
      const r = stmt.run(m.id, m.chatId, m.chatName || null, m.ts, m.fromMe ? 1 : 0,
        m.author || null, m.authorName || null, m.type || 'chat', readableBody(m.body), m.mediaKind || null, m.mediaServe || null, m.mediaId || null);
      if (r.changes) n++;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
  if (n) dirty();
  return n;
}

// An edit replaces the words; the index follows through the trigger.
function updateBody(id, body) {
  init();
  const r = db.prepare('UPDATE messages SET body = ?, edited = 1 WHERE id = ?').run(readableBody(body), id);
  if (r.changes) dirty();
  return r.changes;
}

// A message deleted for everyone stays in the archive (that is what an archive
// is for) but is marked, so the thread can say so.
function markRevoked(id) {
  init();
  const r = db.prepare('UPDATE messages SET revoked = 1 WHERE id = ?').run(id);
  if (r.changes) dirty();
  return r.changes;
}

// Links a transcript row to the media record that was saved for it later
// (history import downloads first; live capture may save the text first).
function linkMedia(id, mediaKind, mediaServe, mediaId) {
  init();
  return db.prepare('UPDATE messages SET media_kind = ?, media_serve = ?, media_id = ? WHERE id = ?').run(mediaKind, mediaServe, mediaId || null, id).changes;
}

function listChats() {
  init();
  if (chatsCache && Date.now() - chatsCacheAt < CHATS_TTL_MS) return chatsCache;
  chatsCache = db.prepare(`
    SELECT chat_id AS chatId, chat_name AS chatName, ts AS lastTs, body AS lastBody,
           type AS lastType, from_me AS lastFromMe, cnt
    FROM (
      SELECT *, COUNT(*) OVER (PARTITION BY chat_id) AS cnt,
             ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY ts DESC, id DESC) AS rn
      FROM messages
    ) WHERE rn = 1
    ORDER BY lastTs DESC`).all().map((row) => ({ ...row, lastBody: readableBody(row.lastBody) }));
  chatsCacheAt = Date.now();
  return chatsCache;
}

const ROW_COLS = `id, chat_id AS chatId, chat_name AS chatName, ts, from_me AS fromMe,
           author, author_name AS authorName, type, body, media_kind AS mediaKind, media_serve AS mediaServe,
           media_id AS mediaId, edited, revoked`;

// Most recent `limit` messages in a chat older than the cursor, returned
// oldest-first. WhatsApp timestamps are whole seconds, so a burst of messages
// shares one ts and the ordering tiebreaks on id — the cursor has to carry the
// same (ts, id) pair, or rows cut off mid-second by LIMIT are never reachable.
function getThread(chatId, before, limit, beforeId) {
  init();
  const b = before || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`
    SELECT ${ROW_COLS}
    FROM messages WHERE chat_id = ? AND (ts < ? OR (ts = ? AND id < ?))
    ORDER BY ts DESC, id DESC LIMIT ?`).all(chatId, b, b, beforeId || '', limit || 200);
  rows.reverse();
  return readableRows(rows);
}

// Messages at or after `after` (for live thread updates), oldest-first.
// `>=` rather than `>` for the same whole-second reason: a message landing in
// the second already polled would otherwise be skipped forever. The client
// dedupes by id, exactly as the media gallery does.
function getNewer(chatId, after, limit) {
  init();
  return readableRows(db.prepare(`
    SELECT ${ROW_COLS}
    FROM messages WHERE chat_id = ? AND ts >= ?
    ORDER BY ts ASC, id ASC LIMIT ?`).all(chatId, after || 0, limit || 200));
}

// The messages around one moment in a chat — what was said just before and
// after a photo arrived, for instance. Used by the finals pass to read which
// version the people in the chat actually chose.
function around(chatId, ts, { before = 6, after = 12 } = {}) {
  init();
  const prev = db.prepare(`SELECT ${ROW_COLS} FROM messages WHERE chat_id = ? AND ts < ? AND COALESCE(body,'') != ''
    ORDER BY ts DESC LIMIT ?`).all(chatId, ts, before).reverse();
  const next = db.prepare(`SELECT ${ROW_COLS} FROM messages WHERE chat_id = ? AND ts >= ? AND COALESCE(body,'') != ''
    ORDER BY ts ASC LIMIT ?`).all(chatId, ts, after);
  return readableRows([...prev, ...next]);
}

// A window of a chat read forward from a cursor, for the topic pass.
function windowFrom(chatId, afterTs, afterId, limit) {
  init();
  return readableRows(db.prepare(`SELECT ${ROW_COLS} FROM messages
    WHERE chat_id = ? AND (ts > ? OR (ts = ? AND id > ?))
    ORDER BY ts ASC, id ASC LIMIT ?`).all(chatId, afterTs || 0, afterTs || 0, afterId || '', limit || 80));
}

function getById(id) {
  init();
  const row = db.prepare(`SELECT ${ROW_COLS} FROM messages WHERE id = ?`).get(id) || null;
  return row ? readableRows([row])[0] : null;
}

// Turns free text into an FTS5 query: every word a prefix term, all required
// (or any of them, for a question). A plural is searched by its stem, so
// "boxes" finds "box" and "cakes" finds "cake". Quotes and operators the
// user typed are not FTS syntax; strip them.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which', 'will', 'did', 'does', 'was', 'were', 'are', 'how', 'who', 'why', 'can', 'could', 'should', 'would', 'about', 'een', 'het', 'van', 'met', 'wat', 'wanneer', 'waar', 'hoe', 'wie', 'zal', 'zijn', 'was', 'over', 'naar', 'voor', 'ook', 'nog', 'dan', 'maar', 'you', 'your', 'our', 'their', 'have', 'has', 'had']);
// Enough of a stem for a prefix search: "boxes" → box, "delivered" → deliver,
// "opening" → open, "deliveries" → deliver. Anything cut too short still
// matches as a prefix, which errs towards finding more rather than less.
function stem(w) {
  const l = w.toLowerCase();
  if (l.length >= 6 && /ing$/.test(l)) return l.slice(0, -3);
  if (l.length >= 5 && /ies$/.test(l)) return l.slice(0, -3);
  if (l.length >= 5 && /ed$/.test(l)) return l.slice(0, -2);
  if (l.length >= 5 && /es$/.test(l) && !/[aeiou]es$/.test(l)) return l.slice(0, -2);
  if (l.length >= 4 && /[^s]s$/.test(l)) return l.slice(0, -1);
  return l;
}
function ftsQuery(q, { mode = 'all' } = {}) {
  let words = String(q || '').replace(/["*^(){}:]/g, ' ').split(/\s+/).filter((w) => w.length >= 2).slice(0, 10);
  if (mode === 'any') words = words.filter((w) => !STOP.has(w.toLowerCase()));
  if (!words.length) return null;
  return words.map((w) => '"' + stem(w.replace(/"/g, '')) + '"*').join(mode === 'any' ? ' OR ' : ' AND ');
}

function search(q, limit, { chatId, mode = 'all' } = {}) {
  init();
  const lim = limit || 200;
  if (ftsOk) {
    const expr = ftsQuery(q, { mode });
    if (!expr) return [];
    try {
      return readableRows(db.prepare(`
        SELECT m.id, m.chat_id AS chatId, m.chat_name AS chatName, m.ts, m.from_me AS fromMe,
               m.author, m.author_name AS authorName, m.type, m.body, m.media_kind AS mediaKind, m.media_serve AS mediaServe,
               snippet(messages_fts, 0, '[[', ']]', '…', 14) AS snippet, bm25(messages_fts) AS rank
        FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE messages_fts MATCH ? ${chatId ? 'AND m.chat_id = ?' : ''}
        ORDER BY rank LIMIT ?`).all(...[expr, ...(chatId ? [chatId] : []), lim])).filter((row) => row.body);
    } catch (e) {
      // A query the tokenizer cannot parse falls through to the plain search.
    }
  }
  return readableRows(db.prepare(`
    SELECT id, chat_id AS chatId, chat_name AS chatName, ts, from_me AS fromMe,
           author, author_name AS authorName, type, body, media_kind AS mediaKind, media_serve AS mediaServe
    FROM messages WHERE body LIKE ? AND body != '' ${chatId ? 'AND chat_id = ?' : ''}
    ORDER BY ts DESC LIMIT ?`).all(...['%' + q + '%', ...(chatId ? [chatId] : []), lim])).filter((row) => row.body);
}

function counts() {
  init();
  const m = db.prepare('SELECT COUNT(*) AS c FROM messages').get();
  const c = db.prepare('SELECT COUNT(DISTINCT chat_id) AS c FROM messages').get();
  return { messages: m ? m.c : 0, chats: c ? c.c : 0 };
}

function allForExport() {
  init();
  return readableRows(db.prepare(`
    SELECT chat_id AS chatId, chat_name AS chatName, ts, from_me AS fromMe,
           author, author_name AS authorName, type, body, media_kind AS mediaKind
    FROM messages ORDER BY chat_name, ts`).all());
}

// The AI tables live in this same database file — one file, one WAL, one thing
// to back up — so they borrow this connection rather than opening a second one.
function handle() { return init(); }

// A compact digest of one chat for the AI to read: the newest messages plus a
// sample spread across the whole history, so a long chat is characterised by
// more than its last afternoon.
function digest(chatId, { recent = 30, spread = 30, chars = 200 } = {}) {
  init();
  const newest = db.prepare(`SELECT ts, from_me, author, author_name, body FROM messages
    WHERE chat_id = ? AND COALESCE(body,'') != '' ORDER BY ts DESC LIMIT ?`).all(chatId, recent);
  const sampled = db.prepare(`SELECT ts, from_me, author, author_name, body FROM messages
    WHERE chat_id = ? AND COALESCE(body,'') != '' AND id NOT IN (
      SELECT id FROM messages WHERE chat_id = ? AND COALESCE(body,'') != '' ORDER BY ts DESC LIMIT ?)
    ORDER BY RANDOM() LIMIT ?`).all(chatId, chatId, recent, spread);
  const rows = [...sampled, ...newest.reverse()].sort((a, b) => a.ts - b.ts);
  return rows.filter((r) => readableBody(r.body)).map((r) => {
    const who = r.from_me ? 'me' : (r.author_name || r.author || 'them');
    const when = new Date(r.ts).toISOString().slice(0, 10);
    return `[${when} ${who}] ${readableBody(r.body).replace(/\s+/g, ' ').slice(0, chars)}`;
  }).join('\n');
}

// The last two days across every chat, one line per message, for the status
// writer's optional context. Chat-aware is opt-in and this is all it sees:
// short lines, newest last, capped hard — enough to be topical, not a feed.
function recentDigest({ hours = 48, limit = 60, chars = 160 } = {}) {
  init();
  const since = Date.now() - hours * 3600000;
  const rows = db.prepare(`SELECT chat_name, from_me, author, author_name, body, ts FROM messages
    WHERE ts >= ? AND COALESCE(body,'') != '' ORDER BY ts DESC LIMIT ?`).all(since, limit);
  rows.reverse();
  return rows.filter((r) => readableBody(r.body)).map((r) => {
    const who = r.from_me ? 'me' : (r.author_name || r.author || r.chat_name || 'them');
    return `[${r.chat_name || '?'} · ${who}] ${readableBody(r.body).replace(/\s+/g, ' ').slice(0, chars)}`;
  }).join('\n');
}

// Chats that actually have something to read. A chat of nothing but photos has
// no text to summarise, so it should never be counted or costed as work.
function chatsWithText() {
  init();
  return new Set(db.prepare(`SELECT DISTINCT chat_id FROM messages WHERE COALESCE(body,'') != ''`)
    .all().map((r) => r.chat_id));
}

// Identifies the state of a chat for caching: re-summarise only when it has
// grown meaningfully, not on every new message.
function chatFingerprint(chatId) {
  init();
  const r = db.prepare(`SELECT COUNT(*) c, MAX(ts) last FROM messages WHERE chat_id = ?`).get(chatId);
  return { count: r ? r.c : 0, last: r ? r.last : 0 };
}

// Chats saved before their name could be found.
function unknownChatIds() {
  return init().prepare("SELECT DISTINCT chat_id AS id FROM messages WHERE chat_name IS NULL OR chat_name = '' OR chat_name = 'unknown'").all().map((r) => r.id);
}
function renameChat(chatId, name) {
  const n = init().prepare('UPDATE messages SET chat_name = ? WHERE chat_id = ?').run(name, chatId).changes;
  if (n) dirty();
  return n;
}

// A chat's rows can disagree with each other: the name was found for some
// messages and not for others, and the list shows whichever is newest. The
// newest real name a chat has ever been saved under wins for all its rows.
function bestNameFor(chatId) {
  const r = init().prepare("SELECT chat_name AS name FROM messages WHERE chat_id = ? AND chat_name IS NOT NULL AND chat_name <> '' AND chat_name <> 'unknown' ORDER BY ts DESC LIMIT 1").get(chatId);
  if (r) return r.name;
  // The chat list WhatsApp reports, and the address book, know names the
  // transcript never got to hear.
  const c = getChat(chatId);
  if (c && c.name && c.name !== 'unknown') return c.name;
  const ct = getContact(chatId);
  if (ct && (ct.name || ct.pushname)) return ct.name || ct.pushname;
  // A number that is in no address book has no name to find; the number
  // itself is a better label than "unknown". (@lid ids are not numbers.)
  const m = /^(\d{8,15})@c\.us$/.exec(String(chatId || ''));
  return m ? '+' + m[1] : null;
}
function selfHealNames() {
  let fixed = 0;
  for (const id of unknownChatIds()) {
    const name = bestNameFor(id);
    if (name) { renameChat(id, name); fixed++; }
  }
  return fixed;
}

/* ---------------- contacts ---------------- */
function upsertContacts(list) {
  init();
  const stmt = db.prepare(`INSERT INTO contacts (id, number, name, pushname, short_name, lid, is_group, is_me, is_business, is_my_contact, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      number = COALESCE(NULLIF(excluded.number,''), contacts.number),
      name = COALESCE(NULLIF(excluded.name,''), contacts.name),
      pushname = COALESCE(NULLIF(excluded.pushname,''), contacts.pushname),
      short_name = COALESCE(NULLIF(excluded.short_name,''), contacts.short_name),
      lid = COALESCE(NULLIF(excluded.lid,''), contacts.lid),
      is_group = excluded.is_group, is_me = excluded.is_me, is_business = excluded.is_business,
      is_my_contact = excluded.is_my_contact, updated_at = excluded.updated_at`);
  const now = Date.now();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const c of list || []) {
      if (!c || !c.id) continue;
      stmt.run(c.id, c.number || '', c.name || '', c.pushname || '', c.shortName || '', c.lid || '',
        c.isGroup ? 1 : 0, c.isMe ? 1 : 0, c.isBusiness ? 1 : 0, c.isMyContact ? 1 : 0, now);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
  return n;
}
const allContacts = () => init().prepare('SELECT * FROM contacts').all();
const getContact = (id) => init().prepare('SELECT * FROM contacts WHERE id = ? OR lid = ?').get(id, id) || null;
const contactCount = () => (init().prepare('SELECT COUNT(*) c FROM contacts').get() || {}).c || 0;
function searchContacts(q, limit = 20) {
  init();
  const like = '%' + String(q || '').replace(/[%_]/g, ' ') + '%';
  return db.prepare(`SELECT id, number, name, pushname, is_group AS isGroup FROM contacts
    WHERE (name LIKE ? OR pushname LIKE ? OR number LIKE ?) AND is_me = 0 ORDER BY name LIMIT ?`).all(like, like, like, limit);
}

// Group authors were stored as raw ids before their names were known; once the
// address book is in, fill the names in wherever they are still missing.
function fillAuthorNames(resolve) {
  init();
  const rows = db.prepare(`SELECT DISTINCT author FROM messages WHERE author IS NOT NULL AND author <> '' AND author <> 'me'
    AND (author_name IS NULL OR author_name = '')`).all();
  const stmt = db.prepare('UPDATE messages SET author_name = ? WHERE author = ? AND (author_name IS NULL OR author_name = \'\')');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const name = resolve(r.author);
      if (name && name !== r.author) n += stmt.run(name, r.author).changes;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
  if (n) dirty();
  return n;
}

/* ---------------- chats (as WhatsApp lists them) ---------------- */
function upsertChats(list) {
  init();
  const stmt = db.prepare(`INSERT INTO chats (id, name, is_group, last_ts, archived, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(NULLIF(excluded.name,''), chats.name),
      is_group = excluded.is_group,
      last_ts = MAX(excluded.last_ts, chats.last_ts),
      archived = excluded.archived,
      updated_at = excluded.updated_at`);
  const now = Date.now();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const c of list || []) {
      if (!c || !c.id) continue;
      stmt.run(c.id, c.name || '', c.isGroup ? 1 : 0, c.lastTs || 0, c.archived ? 1 : 0, now);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
  return n;
}
const getChat = (id) => init().prepare('SELECT * FROM chats WHERE id = ?').get(id) || null;
const allChats = () => init().prepare('SELECT * FROM chats ORDER BY last_ts DESC').all();
function noteSynced(chatId, newestTs) {
  init();
  db.prepare(`INSERT INTO chats (id, name, is_group, last_ts, archived, synced_ts, synced_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET synced_ts = MAX(excluded.synced_ts, chats.synced_ts), synced_at = excluded.synced_at`)
    .run(chatId, '', 0, 0, 0, newestTs || 0, Date.now(), Date.now());
}

// Which chats changed on WhatsApp's side since we last caught up with them.
function chatsNeedingSync(limit = 60) {
  init();
  return db.prepare(`SELECT * FROM chats WHERE last_ts > synced_ts AND archived = 0 ORDER BY last_ts DESC LIMIT ?`).all(limit);
}

module.exports = { unknownChatIds, renameChat, bestNameFor, selfHealNames,
  init, close, addMessage, addMany, updateBody, markRevoked, linkMedia, listChats, getThread, getNewer, around, windowFrom, getById,
  search, ftsQuery, counts, allForExport,
  handle, digest, recentDigest, chatFingerprint, chatsWithText,
  upsertContacts, allContacts, getContact, contactCount, searchContacts, fillAuthorNames,
  upsertChats, getChat, allChats, noteSynced, chatsNeedingSync,
  getMeta, setMeta, hasFts: () => ftsOk,
};
