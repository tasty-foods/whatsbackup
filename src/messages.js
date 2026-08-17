'use strict';
// Conversation (text) store, backed by Node's built-in SQLite (no dependency).
// Kept separate from the media gallery index so the working gallery is untouched.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');

let db = null;

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
  return db;
}

function addMessage(m) {
  init();
  try {
    db.prepare(`INSERT OR IGNORE INTO messages
      (id, chat_id, chat_name, ts, from_me, author, type, body, media_kind, media_serve)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      m.id, m.chatId, m.chatName || null, m.ts, m.fromMe ? 1 : 0,
      m.author || null, m.type || 'chat', m.body || '', m.mediaKind || null, m.mediaServe || null
    );
    return true;
  } catch (e) { return false; }
}

// Batch insert inside one transaction (fast for history import).
function addMany(list) {
  init();
  let n = 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO messages
    (id, chat_id, chat_name, ts, from_me, author, type, body, media_kind, media_serve)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const m of list) {
      const r = stmt.run(m.id, m.chatId, m.chatName || null, m.ts, m.fromMe ? 1 : 0,
        m.author || null, m.type || 'chat', m.body || '', m.mediaKind || null, m.mediaServe || null);
      if (r.changes) n++;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
  return n;
}

function listChats() {
  init();
  return db.prepare(`
    SELECT chat_id AS chatId, chat_name AS chatName, ts AS lastTs, body AS lastBody,
           type AS lastType, from_me AS lastFromMe, cnt
    FROM (
      SELECT *, COUNT(*) OVER (PARTITION BY chat_id) AS cnt,
             ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY ts DESC, id DESC) AS rn
      FROM messages
    ) WHERE rn = 1
    ORDER BY lastTs DESC`).all();
}

// Most recent `limit` messages in a chat older than `before` (cursor), returned oldest-first.
function getThread(chatId, before, limit) {
  init();
  const rows = db.prepare(`
    SELECT id, chat_id AS chatId, chat_name AS chatName, ts, from_me AS fromMe,
           author, type, body, media_kind AS mediaKind, media_serve AS mediaServe
    FROM messages WHERE chat_id = ? AND ts < ?
    ORDER BY ts DESC, id DESC LIMIT ?`).all(chatId, before || Number.MAX_SAFE_INTEGER, limit || 200);
  rows.reverse();
  return rows;
}

// Messages newer than `after` (for live thread updates), oldest-first.
function getNewer(chatId, after, limit) {
  init();
  return db.prepare(`
    SELECT id, chat_id AS chatId, chat_name AS chatName, ts, from_me AS fromMe,
           author, type, body, media_kind AS mediaKind, media_serve AS mediaServe
    FROM messages WHERE chat_id = ? AND ts > ?
    ORDER BY ts ASC, id ASC LIMIT ?`).all(chatId, after || 0, limit || 200);
}

function search(q, limit) {
  init();
  return db.prepare(`
    SELECT id, chat_id AS chatId, chat_name AS chatName, ts, from_me AS fromMe,
           type, body, media_kind AS mediaKind, media_serve AS mediaServe
    FROM messages WHERE body LIKE ? AND body != ''
    ORDER BY ts DESC LIMIT ?`).all('%' + q + '%', limit || 200);
}

function counts() {
  init();
  const m = db.prepare('SELECT COUNT(*) AS c FROM messages').get();
  const c = db.prepare('SELECT COUNT(DISTINCT chat_id) AS c FROM messages').get();
  return { messages: m ? m.c : 0, chats: c ? c.c : 0 };
}

function allForExport() {
  init();
  return db.prepare(`
    SELECT chat_id AS chatId, chat_name AS chatName, ts, from_me AS fromMe,
           author, type, body, media_kind AS mediaKind
    FROM messages ORDER BY chat_name, ts`).all();
}

module.exports = { init, addMessage, addMany, listChats, getThread, getNewer, search, counts, allForExport };
