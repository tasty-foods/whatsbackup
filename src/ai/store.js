'use strict';
// AI results live in the same SQLite file as the messages — one file, one WAL,
// one thing to back up. Labels are keyed by a content hash so re-running never
// pays twice for an item that hasn't changed.
const crypto = require('crypto');
const messages = require('../messages');

let ready = false;

function db() {
  const handle = messages.handle();
  if (!ready) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS ai_labels(
        kind TEXT NOT NULL,               -- 'image' | 'video' | 'chat'
        ref_id TEXT NOT NULL,             -- media record id, or chat_id
        content_hash TEXT NOT NULL,
        label_json TEXT NOT NULL,
        model TEXT, provider TEXT,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, ref_id)
      );
      CREATE TABLE IF NOT EXISTS ai_groups(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,               -- 'media' | 'chat'
        name TEXT NOT NULL,
        description TEXT,
        emoji TEXT,
        pinned INTEGER DEFAULT 0,         -- set when the user renames it
        prev_names TEXT,                  -- JSON array; see renameGroup
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_group_members(
        group_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'ai',   -- 'ai' | 'user'
        PRIMARY KEY (kind, ref_id)
      );
      CREATE INDEX IF NOT EXISTS idx_members_group ON ai_group_members(group_id);
      CREATE TABLE IF NOT EXISTS ai_corrections(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_jobs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,               -- label_image | label_video | label_chat
        ref_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',   -- queued | done | error | skipped
        attempts INTEGER DEFAULT 0,
        error TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique ON ai_jobs(type, ref_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_state ON ai_jobs(state);
      CREATE TABLE IF NOT EXISTS ai_runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT, model TEXT, provider TEXT,
        items INTEGER DEFAULT 0, ok INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
        started_at INTEGER, finished_at INTEGER, error TEXT
      );
    `);
    // Databases written before albums could be renamed.
    const cols = handle.prepare('PRAGMA table_info(ai_groups)').all().map((c) => c.name);
    if (!cols.includes('prev_names')) handle.exec('ALTER TABLE ai_groups ADD COLUMN prev_names TEXT');
    const runCols = handle.prepare('PRAGMA table_info(ai_runs)').all().map((c) => c.name);
    if (!runCols.includes('cost_cap_usd')) handle.exec('ALTER TABLE ai_runs ADD COLUMN cost_cap_usd REAL DEFAULT 0');
    ready = true;
    // Anything the last process was mid-way through is ours to finish.
    requeueStale();
  }
  return handle;
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const newId = (prefix) => prefix + '_' + crypto.randomBytes(6).toString('hex');

/* ---------------- labels ---------------- */
function getLabel(kind, refId) {
  const row = db().prepare('SELECT * FROM ai_labels WHERE kind = ? AND ref_id = ?').get(kind, refId);
  if (!row) return null;
  try { row.label = JSON.parse(row.label_json); } catch (_) { row.label = null; }
  return row;
}

function isLabelled(kind, refId, contentHash) {
  const row = db().prepare('SELECT content_hash FROM ai_labels WHERE kind = ? AND ref_id = ?').get(kind, refId);
  return !!row && row.content_hash === contentHash;
}

function putLabel({ kind, refId, contentHash, label, model, provider, usage, cost }) {
  db().prepare(`INSERT INTO ai_labels (kind, ref_id, content_hash, label_json, model, provider, tokens_in, tokens_out, cost_usd, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET
      content_hash=excluded.content_hash, label_json=excluded.label_json, model=excluded.model,
      provider=excluded.provider, tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
      cost_usd=excluded.cost_usd, created_at=excluded.created_at`)
    .run(kind, refId, contentHash, JSON.stringify(label), model || '', provider || '',
      (usage && usage.in) || 0, (usage && usage.out) || 0, cost == null ? null : cost, Date.now());
}

const labelsOfKinds = (kinds) => db()
  .prepare(`SELECT kind, ref_id, label_json FROM ai_labels WHERE kind IN (${kinds.map(() => '?').join(',')})`)
  .all(...kinds)
  .map((r) => { try { return { kind: r.kind, refId: r.ref_id, label: JSON.parse(r.label_json) }; } catch (_) { return null; } })
  .filter(Boolean);

/* ---------------- groups ---------------- */
const listGroups = (kind) => db().prepare(`
  SELECT g.*, (SELECT COUNT(*) FROM ai_group_members m WHERE m.group_id = g.id) AS members
  FROM ai_groups g WHERE g.kind = ? ORDER BY members DESC, g.name`).all(kind);

const groupOf = (kind, refId) => db()
  .prepare('SELECT group_id, source FROM ai_group_members WHERE kind = ? AND ref_id = ?').get(kind, refId) || null;

const membersOf = (groupId) => db()
  .prepare('SELECT kind, ref_id, source FROM ai_group_members WHERE group_id = ?').all(groupId);

function createGroup({ kind, name, description, emoji, pinned = 0 }) {
  const id = newId('grp');
  db().prepare('INSERT INTO ai_groups (id, kind, name, description, emoji, pinned, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, kind, name, description || '', emoji || '', pinned ? 1 : 0, Date.now());
  return id;
}

// The old name is kept so a later arrange can still recognise the album it is
// looking at. A model that proposes "Equipment & repairs" means the album the
// user renamed to "Machine repairs" — without the alias it would build a second
// album alongside it and strand the renamed one.
function renameGroup(id, name) {
  const row = db().prepare('SELECT name, prev_names FROM ai_groups WHERE id = ?').get(id);
  if (!row || row.name === name) return;
  let prev = []; try { prev = JSON.parse(row.prev_names) || []; } catch (_) { prev = []; }
  if (!prev.includes(row.name)) prev.push(row.name);
  db().prepare('UPDATE ai_groups SET name = ?, pinned = 1, prev_names = ? WHERE id = ?')
    .run(name, JSON.stringify(prev.slice(-5)), id);
  addCorrection('group', 'rename', JSON.stringify({ id, name }));
}

const aliasesOf = (g) => { try { return JSON.parse(g.prev_names) || []; } catch (_) { return []; } };

// Taking something out of an album is a decision too. It is stored as a real
// row pointing at a group that does not exist, so the next arrange sees it in
// the user-placed set and puts it back to "no album" rather than re-filing it.
// No group ever has this id, so it shows as unsorted everywhere else.
const UNFILED = '-';

function setMember(kind, refId, groupId, source = 'ai') {
  if (!groupId) {
    db().prepare('DELETE FROM ai_group_members WHERE kind = ? AND ref_id = ?').run(kind, refId);
    return;
  }
  db().prepare(`INSERT INTO ai_group_members (group_id, kind, ref_id, source) VALUES (?,?,?,?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET group_id=excluded.group_id, source=excluded.source`)
    .run(groupId, kind, refId, source);
}

// Removes AI-assigned memberships only — anything the user placed by hand
// survives a re-arrange, which is the whole point of the source column.
function clearAiMembers(kind) {
  db().prepare(`DELETE FROM ai_group_members WHERE source = 'ai' AND kind = ?`).run(kind);
}

// Two albums with the same name are never what anyone wants. They can arise
// from a model that proposes a name it was already given, so fold them together
// rather than leaving the user to tidy up.
function mergeDuplicateNames(kind) {
  const rows = db().prepare('SELECT id, name, pinned FROM ai_groups WHERE kind = ? ORDER BY pinned DESC, created_at').all(kind);
  const keep = new Map();
  let merged = 0;
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    const first = keep.get(key);
    if (!first) { keep.set(key, r.id); continue; }
    db().prepare('UPDATE OR REPLACE ai_group_members SET group_id = ? WHERE group_id = ?').run(first, r.id);
    db().prepare('DELETE FROM ai_groups WHERE id = ?').run(r.id);
    merged++;
  }
  return merged;
}

// An album with nothing in it is clutter, even one the user named — the name
// they chose is remembered in the corrections ledger and replayed into the next
// arrange, so nothing is actually lost by dropping the empty shell.
function pruneEmptyGroups(kind) {
  db().prepare(`DELETE FROM ai_groups WHERE kind = ?
    AND id NOT IN (SELECT group_id FROM ai_group_members)`).run(kind);
}

/* ---------------- corrections (the house rules) ---------------- */
function addCorrection(kind, action, detail) {
  db().prepare('INSERT INTO ai_corrections (kind, action, detail, created_at) VALUES (?,?,?,?)')
    .run(kind, action, detail, Date.now());
}
const recentCorrections = (limit = 40) => db()
  .prepare('SELECT action, detail FROM ai_corrections ORDER BY id DESC LIMIT ?').all(limit);

/* ---------------- jobs ---------------- */
// A job that ended badly must be able to come back. Someone who mistypes a
// model name gets every photo marked 'skipped'; without this, fixing the name
// would never re-queue them, while the estimate went on pricing them as work to
// do. Re-queueing an already-done item is free: the labellers check the content
// hash first and return `cached` without calling anyone.
function enqueue(type, refId) {
  db().prepare(`INSERT INTO ai_jobs (type, ref_id, state, updated_at) VALUES (?,?, 'queued', ?)
    ON CONFLICT(type, ref_id) DO UPDATE SET
      state = 'queued', attempts = 0, error = NULL, updated_at = excluded.updated_at
    WHERE ai_jobs.state NOT IN ('queued', 'running')`).run(type, refId, Date.now());
}

// Claiming marks the rows as taken in the same synchronous turn it reads them.
// node:sqlite is synchronous, so nothing can interleave between the SELECT and
// the UPDATE — which is what keeps two drains from paying for the same job.
function claim(n) {
  const rows = db().prepare(`SELECT * FROM ai_jobs WHERE state = 'queued' ORDER BY id LIMIT ?`).all(n);
  const mark = db().prepare(`UPDATE ai_jobs SET state = 'running', updated_at = ? WHERE id = ?`);
  const now = Date.now();
  for (const r of rows) mark.run(now, r.id);
  return rows;
}

// A process that died mid-batch leaves rows stuck in 'running'.
const requeueStale = () => db().prepare(`UPDATE ai_jobs SET state = 'queued' WHERE state = 'running'`).run();

function finishJob(id, state, error) {
  db().prepare('UPDATE ai_jobs SET state = ?, error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?')
    .run(state, error || null, Date.now(), id);
}
function retryJob(id, error) {
  db().prepare(`UPDATE ai_jobs SET state = 'queued', attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?`)
    .run(error || null, Date.now(), id);
}
const jobCounts = () => {
  const rows = db().prepare('SELECT state, COUNT(*) c FROM ai_jobs GROUP BY state').all();
  const out = { queued: 0, done: 0, error: 0, skipped: 0 };
  for (const r of rows) {
    if (r.state === 'running') out.queued += r.c;      // still outstanding work
    else out[r.state] = r.c;
  }
  return out;
};
const clearJobs = () => db().exec('DELETE FROM ai_jobs');

/* ---------------- runs ---------------- */
function startRun(kind, model, provider) {
  const r = db().prepare('INSERT INTO ai_runs (kind, model, provider, started_at) VALUES (?,?,?,?)')
    .run(kind, model, provider, Date.now());
  return Number(r.lastInsertRowid);
}
function updateRun(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db().prepare(`UPDATE ai_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
}
const lastRun = () => db().prepare('SELECT * FROM ai_runs ORDER BY id DESC LIMIT 1').get() || null;
// What was actually spent, as far as we can price it.
const spendSince = (ts) => (db().prepare('SELECT SUM(cost_usd) s FROM ai_runs WHERE started_at >= ?').get(ts) || {}).s || 0;
// What the budget cap counts: the same figure, except that a model with no
// published price is charged at the dearest rate we know rather than as free.
const spendCapSince = (ts) => (db().prepare('SELECT SUM(MAX(COALESCE(cost_usd,0), COALESCE(cost_cap_usd,0))) s FROM ai_runs WHERE started_at >= ?').get(ts) || {}).s || 0;

function wipe() {
  db().exec(`DELETE FROM ai_labels; DELETE FROM ai_group_members; DELETE FROM ai_groups;
             DELETE FROM ai_corrections; DELETE FROM ai_jobs; DELETE FROM ai_runs;`);
}

module.exports = {
  db, sha1, newId, UNFILED,
  getLabel, isLabelled, putLabel, labelsOfKinds,
  listGroups, groupOf, membersOf, createGroup, renameGroup, aliasesOf, setMember, clearAiMembers,
  pruneEmptyGroups, mergeDuplicateNames,
  addCorrection, recentCorrections,
  enqueue, claim, requeueStale, finishJob, retryJob, jobCounts, clearJobs,
  startRun, updateRun, lastRun, spendSince, spendCapSince,
  wipe,
};
