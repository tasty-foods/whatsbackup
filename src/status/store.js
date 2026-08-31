'use strict';
// Status Studio's memory, in the same SQLite file as everything else — one
// file, one WAL, one thing to back up. Three tables: what to post and when
// (slots), what is waiting to be posted (queue), and what actually happened
// (history — which is also the rotation state and the rate-cap ledger, so
// those can never disagree with the record).
const messages = require('../messages');

let ready = false;

function db() {
  const handle = messages.handle();
  if (!ready) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS status_slots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,                -- 'daily' | 'weekly' | 'interval'
        at TEXT,                           -- 'HH:MM' for daily/weekly
        weekday INTEGER,                   -- 0=Sunday … 6=Saturday, for weekly
        every_hours INTEGER,               -- for interval
        source TEXT NOT NULL,              -- 'queue' | 'folder' | 'album' | 'ai'
        config_json TEXT,                  -- album id, template, ai overrides
        enabled INTEGER DEFAULT 1,
        next_run_at INTEGER,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_queue(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,                -- 'text' | 'image' | 'video'
        body TEXT NOT NULL,                -- the text itself, or a file path
        caption TEXT,
        template TEXT,                     -- card template for text posts
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        slot_id INTEGER,                   -- null for manual / test posts
        source TEXT,
        source_ref TEXT,                   -- record id for album rotation, path for folder
        type TEXT,
        body TEXT,
        caption TEXT,
        card_file TEXT,                    -- rendered card / copied media, for the history thumbnail
        ok INTEGER NOT NULL,
        dry INTEGER DEFAULT 0,
        error TEXT,
        wa_msg_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_status_hist_at ON status_history(at);
      CREATE TABLE IF NOT EXISTS status_seen_files(
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        posted_at INTEGER NOT NULL
      );
    `);
    ready = true;
  }
  return handle;
}

/* ---------------- slots ---------------- */
function listSlots() {
  return db().prepare('SELECT * FROM status_slots ORDER BY id').all()
    .map((r) => ({ ...r, config: safeParse(r.config_json) }));
}
function getSlot(id) {
  const r = db().prepare('SELECT * FROM status_slots WHERE id = ?').get(id);
  return r ? { ...r, config: safeParse(r.config_json) } : null;
}
function addSlot(s) {
  const r = db().prepare(`INSERT INTO status_slots(kind, at, weekday, every_hours, source, config_json, enabled, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.kind, s.at || null, s.weekday == null ? null : s.weekday, s.everyHours || null,
      s.source, JSON.stringify(s.config || {}), s.enabled === false ? 0 : 1, s.nextRunAt || null, Date.now());
  return Number(r.lastInsertRowid);
}
function updateSlot(id, patch) {
  const cur = getSlot(id);
  if (!cur) return false;
  const merged = { ...cur, ...patch };
  db().prepare(`UPDATE status_slots SET kind=?, at=?, weekday=?, every_hours=?, source=?, config_json=?, enabled=?, next_run_at=?, last_run_at=? WHERE id=?`)
    .run(merged.kind, merged.at || null, merged.weekday == null ? null : merged.weekday,
      merged.everyHours || merged.every_hours || null, merged.source,
      JSON.stringify(patch.config || cur.config || {}),
      merged.enabled ? 1 : 0,
      patch.nextRunAt !== undefined ? patch.nextRunAt : cur.next_run_at,
      patch.lastRunAt !== undefined ? patch.lastRunAt : cur.last_run_at,
      id);
  return true;
}
const deleteSlot = (id) => { db().prepare('DELETE FROM status_slots WHERE id=?').run(id); };

/* ---------------- queue ---------------- */
function listQueue() {
  return db().prepare('SELECT * FROM status_queue ORDER BY position, id').all();
}
function enqueue(item) {
  const max = db().prepare('SELECT COALESCE(MAX(position), 0) AS p FROM status_queue').get().p;
  const r = db().prepare('INSERT INTO status_queue(type, body, caption, template, position, created_at) VALUES (?,?,?,?,?,?)')
    .run(item.type, item.body, item.caption || null, item.template || null, max + 1, Date.now());
  return Number(r.lastInsertRowid);
}
const dequeue = () => db().prepare('SELECT * FROM status_queue ORDER BY position, id LIMIT 1').get() || null;
const removeQueued = (id) => { db().prepare('DELETE FROM status_queue WHERE id=?').run(id); };
function reorderQueue(ids) {
  const stmt = db().prepare('UPDATE status_queue SET position=? WHERE id=?');
  ids.forEach((id, i) => stmt.run(i + 1, id));
}

/* ---------------- history: the log, the caps, the rotation state ---------------- */
function addHistory(h) {
  const r = db().prepare(`INSERT INTO status_history(at, slot_id, source, source_ref, type, body, caption, card_file, ok, dry, error, wa_msg_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(h.at || Date.now(), h.slotId || null, h.source || null, h.sourceRef || null, h.type || null,
      h.body == null ? null : String(h.body).slice(0, 2000), h.caption || null, h.cardFile || null,
      h.ok ? 1 : 0, h.dry ? 1 : 0, h.error || null, h.waMsgId || null);
  return Number(r.lastInsertRowid);
}
const listHistory = (limit) => db().prepare('SELECT * FROM status_history ORDER BY at DESC LIMIT ?').all(limit || 50);

// The caps read the same rows the user sees, so "3 posted today" and the
// history can never tell different stories. Dry runs don't count against caps.
function postsSince(ts) {
  return db().prepare('SELECT COUNT(*) AS c FROM status_history WHERE ok=1 AND dry=0 AND at >= ?').get(ts).c;
}
function lastPostAt() {
  const r = db().prepare('SELECT MAX(at) AS t FROM status_history WHERE ok=1 AND dry=0').get();
  return (r && r.t) || 0;
}
// Album rotation: the member posted longest ago (or never) goes next.
function lastPostedRef(refs) {
  if (!refs.length) return new Map();
  const q = db().prepare(`SELECT source_ref, MAX(at) AS t FROM status_history
    WHERE ok=1 AND source_ref IS NOT NULL GROUP BY source_ref`).all();
  return new Map(q.map((r) => [r.source_ref, r.t]));
}

/* ---------------- folder watch bookkeeping ---------------- */
const seenFile = (p) => db().prepare('SELECT * FROM status_seen_files WHERE path=?').get(p) || null;
function markFilePosted(p, mtime, size) {
  db().prepare(`INSERT INTO status_seen_files(path, mtime, size, posted_at) VALUES (?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, posted_at=excluded.posted_at`)
    .run(p, mtime, size, Date.now());
}

function safeParse(j) { try { return JSON.parse(j || '{}'); } catch (_) { return {}; } }

module.exports = {
  listSlots, getSlot, addSlot, updateSlot, deleteSlot,
  listQueue, enqueue, dequeue, removeQueued, reorderQueue,
  addHistory, listHistory, postsSince, lastPostAt, lastPostedRef,
  seenFile, markFilePosted,
};
