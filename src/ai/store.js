'use strict';
// AI results live in the same SQLite file as the messages — one file, one WAL,
// one thing to back up. Labels are keyed by a content hash so re-running never
// pays twice for an item that hasn't changed.
const crypto = require('crypto');
const messages = require('../messages');

let ready = false;
let ftsOk = false;
// Bumped on every write to a label, so caches keyed on it (the census, the
// content index) know when to look again.
let revision = 0;

function db() {
  const handle = messages.handle();
  if (!ready) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS ai_labels(
        kind TEXT NOT NULL,               -- 'image' | 'video' | 'chat' | 'document' | 'audio'
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
        kind TEXT NOT NULL,               -- 'media' | 'chat' | 'topic'
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
        type TEXT NOT NULL,               -- label_image | label_video | label_chat | label_document | transcribe_audio | topics_chat | embed | finals_set
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
      -- Vectors: what each item means, for search by meaning. One row per item
      -- and model; the hash says which text was embedded.
      CREATE TABLE IF NOT EXISTS ai_embeddings(
        kind TEXT NOT NULL, ref_id TEXT NOT NULL,
        model TEXT NOT NULL, dims INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        vec BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, ref_id)
      );
      -- Topics: what a stretch of a conversation was about, with its span.
      CREATE TABLE IF NOT EXISTS ai_topics(
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        keywords TEXT,                    -- JSON array
        people TEXT,                      -- JSON array
        decisions TEXT,                   -- JSON array of short strings
        from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL,
        msg_count INTEGER DEFAULT 0,
        first_id TEXT, last_id TEXT,
        model TEXT, provider TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_topics_chat ON ai_topics(chat_id, from_ts);
      CREATE TABLE IF NOT EXISTS ai_topic_cursor(
        chat_id TEXT PRIMARY KEY,
        last_ts INTEGER DEFAULT 0, last_id TEXT,
        updated_at INTEGER NOT NULL
      );
      -- Finals: sets of versions of one thing, and which one to keep.
      CREATE TABLE IF NOT EXISTS ai_finals(
        id TEXT PRIMARY KEY,
        set_key TEXT NOT NULL UNIQUE,     -- stable over re-runs: sorted member ids hashed
        kind TEXT NOT NULL,               -- 'image' | 'document' | 'video'
        chat TEXT,
        members TEXT NOT NULL,            -- JSON array of record ids, oldest first
        suggested_id TEXT,
        confidence REAL DEFAULT 0,
        reason TEXT,
        ranking TEXT,                     -- JSON: [{id, note}] best first
        status TEXT NOT NULL DEFAULT 'suggested',   -- suggested | kept | dismissed
        decided_id TEXT,
        model TEXT, provider TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS finals_marks(
        ref_id TEXT PRIMARY KEY,
        set_id TEXT,
        local_path TEXT, cloud_path TEXT,
        marked_at INTEGER NOT NULL
      );
    `);
    handle.exec('CREATE INDEX IF NOT EXISTS idx_labels_hash ON ai_labels(kind, content_hash)');
    // Databases written before albums could be renamed.
    const cols = handle.prepare('PRAGMA table_info(ai_groups)').all().map((c) => c.name);
    if (!cols.includes('prev_names')) handle.exec('ALTER TABLE ai_groups ADD COLUMN prev_names TEXT');
    const runCols = handle.prepare('PRAGMA table_info(ai_runs)').all().map((c) => c.name);
    if (!runCols.includes('cost_cap_usd')) handle.exec('ALTER TABLE ai_runs ADD COLUMN cost_cap_usd REAL DEFAULT 0');
    // Words the AI wrote about things, searchable. Not external-content: the
    // text is small and lives only here, rebuilt per item when a label changes.
    try {
      handle.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ai_fts USING fts5(kind UNINDEXED, ref_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');`);
      ftsOk = true;
      if (messages.getMeta('ai_fts_built') !== '2') {
        handle.exec('DELETE FROM ai_fts');
        const ins = handle.prepare('INSERT INTO ai_fts (kind, ref_id, text) VALUES (?,?,?)');
        for (const r of handle.prepare('SELECT kind, ref_id, label_json FROM ai_labels').all()) {
          let l = null; try { l = JSON.parse(r.label_json); } catch (_) {}
          if (l) ins.run(r.kind, r.ref_id, labelText(l));
        }
        for (const t of handle.prepare('SELECT id, title, summary, keywords, decisions FROM ai_topics').all()) ins.run('topic', t.id, topicText(t));
        messages.setMeta('ai_fts_built', '2');
      }
    } catch (e) { ftsOk = false; }
    ready = true;
    // Anything the last process was mid-way through is ours to finish.
    requeueStale();
  }
  return handle;
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const newId = (prefix) => prefix + '_' + crypto.randomBytes(6).toString('hex');

// Everything a label says, flattened for the word index and for embedding.
function labelText(l) {
  if (!l || typeof l !== 'object') return '';
  const arr = (x) => (Array.isArray(x) ? x : []).map((v) => (v && typeof v === 'object' ? (v.description || v.text || '') : String(v)));
  return [l.caption, l.summary, l.title, l.scene, l.kind, l.doc_type, l.category,
    arr(l.subjects).join(' '), arr(l.tags).join(' '), arr(l.topics).join(' '), arr(l.details).join('. '),
    arr(l.parties).join(' '), arr(l.reference_numbers).join(' '), arr(l.amounts).join(' '), arr(l.dates).join(' '),
    arr(l.action_items).join(' '), l.text_in_image, l.version_hint, l.text_excerpt, l.transcript,
    arr(l.frames).join('. '), arr(l.chunks).join('\n').slice(0, 6000)]
    .filter(Boolean).join('\n').slice(0, 16000);
}
function topicText(t) {
  const arr = (x) => { try { const v = typeof x === 'string' ? JSON.parse(x) : x; return Array.isArray(v) ? v.map(String) : []; } catch (_) { return []; } };
  return [t.title, t.summary, arr(t.keywords).join(' '), arr(t.decisions).join(' ')].filter(Boolean).join('\n');
}
function indexText(kind, refId, text) {
  if (!ftsOk) return;
  try {
    db().prepare('DELETE FROM ai_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
    if (text) db().prepare('INSERT INTO ai_fts (kind, ref_id, text) VALUES (?,?,?)').run(kind, refId, text);
  } catch (_) {}
}

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
  revision++;
  indexText(kind, refId, labelText(label));
}
// The same bytes already read under another id (a forward, a copy): its
// label can be reused without a call.
function labelByHash(kind, hash) {
  const row = db().prepare('SELECT label_json, model, provider FROM ai_labels WHERE kind=? AND content_hash=? LIMIT 1').get(kind, hash);
  if (!row) return null;
  try { return { ...row, label: JSON.parse(row.label_json) }; } catch (_) { return null; }
}

const labelsOfKinds = (kinds) => db()
  .prepare(`SELECT kind, ref_id, label_json FROM ai_labels WHERE kind IN (${kinds.map(() => '?').join(',')})`)
  .all(...kinds)
  .map((r) => { try { return { kind: r.kind, refId: r.ref_id, label: JSON.parse(r.label_json) }; } catch (_) { return null; } })
  .filter(Boolean);

// Every label with its album in one query, for the dashboard.
const labelsWithGroups = (kinds, groupKind) => db()
  .prepare(`SELECT l.kind, l.ref_id, l.label_json, m.group_id, m.source, g.name AS group_name, g.emoji AS group_emoji
    FROM ai_labels l
    LEFT JOIN ai_group_members m ON m.kind = l.kind AND m.ref_id = l.ref_id
    LEFT JOIN ai_groups g ON g.id = m.group_id AND g.kind = ?
    WHERE l.kind IN (${kinds.map(() => '?').join(',')})`)
  .all(groupKind, ...kinds)
  .map((r) => { let label = null; try { label = JSON.parse(r.label_json); } catch (_) {} return { kind: r.kind, refId: r.ref_id, label, groupId: r.group_name ? r.group_id : null, groupName: r.group_name || null, groupEmoji: r.group_emoji || null, placedBy: r.group_id ? r.source : null }; })
  .filter((r) => r.label);

const labelCount = (kind) => (db().prepare('SELECT COUNT(*) c FROM ai_labels WHERE kind = ?').get(kind) || {}).c || 0;

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

function enqueueMany(jobs) {
  const handle = db();
  handle.exec('BEGIN IMMEDIATE');
  try { for (const job of jobs) enqueue(job.type, job.refId); handle.exec('COMMIT'); }
  catch (e) { handle.exec('ROLLBACK'); throw e; }
}

// Claiming marks the rows as taken in the same synchronous turn it reads them.
// node:sqlite is synchronous, so nothing can interleave between the SELECT and
// the UPDATE — which is what keeps two drains from paying for the same job.
// Cheap work (text) is claimed before expensive work (vision, audio) so a
// short run still gets the whole library's words indexed first. A selection
// (these ids, these types) narrows what one run may take: indexing one file
// must not pick up the rest of the queue.
const PRIORITY = { label_chat: 0, label_document: 1, topics_chat: 2, label_image: 3, label_video: 4, transcribe_audio: 5, embed: 6, finals_set: 7 };
function claim(n, { ids = null, types = null } = {}) {
  const where = ["state = 'queued'"], args = [];
  for (const [column, values] of [['ref_id', ids], ['type', types]]) {
    if (!values) continue;
    const list = [...values];
    if (!list.length) return [];
    where.push(`${column} IN (${list.map(() => '?').join(',')})`);
    args.push(...list);
  }
  const rows = db().prepare(`SELECT * FROM ai_jobs WHERE ${where.join(' AND ')} ORDER BY
    CASE type ${Object.entries(PRIORITY).map(([t, p]) => `WHEN '${t}' THEN ${p}`).join(' ')} ELSE 9 END, id LIMIT ?`).all(...args, n);
  const mark = db().prepare(`UPDATE ai_jobs SET state = 'running', updated_at = ? WHERE id = ?`);
  const now = Date.now();
  for (const r of rows) mark.run(now, r.id);
  return rows;
}

// More of one type, for work that goes out in one call (vectors).
function claimType(type, n) {
  if (n <= 0) return [];
  const rows = db().prepare(`SELECT * FROM ai_jobs WHERE state = 'queued' AND type = ? ORDER BY id LIMIT ?`).all(type, n);
  const mark = db().prepare(`UPDATE ai_jobs SET state = 'running', updated_at = ? WHERE id = ?`);
  const now = Date.now();
  for (const r of rows) mark.run(now, r.id);
  return rows;
}
// Claimed but not worked on: back to the queue, no attempt counted.
function releaseJobs(ids) {
  const st = db().prepare(`UPDATE ai_jobs SET state = 'queued' WHERE id = ? AND state = 'running'`);
  for (const id of ids) st.run(id);
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
const queuedByType = () => {
  const out = {};
  for (const r of db().prepare(`SELECT type, COUNT(*) c FROM ai_jobs WHERE state IN ('queued','running') GROUP BY type`).all()) out[r.type] = r.c;
  return out;
};
const clearJobs = () => db().exec('DELETE FROM ai_jobs');
const clearJobsOfType = (type) => db().prepare(`DELETE FROM ai_jobs WHERE type = ? AND state <> 'running'`).run(type);

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
// The running run's own row is left out when asked, because its spend is
// counted from memory while it runs and written to the row as it goes.
const spendCapSince = (ts, excludeRunId = -1) => (db().prepare('SELECT SUM(MAX(COALESCE(cost_usd,0), COALESCE(cost_cap_usd,0))) s FROM ai_runs WHERE started_at >= ? AND id != ?').get(ts, excludeRunId || -1) || {}).s || 0;

/* ---------------- embeddings ---------------- */
function putEmbedding({ kind, refId, model, contentHash, vec }) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  db().prepare(`INSERT INTO ai_embeddings (kind, ref_id, model, dims, content_hash, vec, created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET model=excluded.model, dims=excluded.dims, content_hash=excluded.content_hash, vec=excluded.vec, created_at=excluded.created_at`)
    .run(kind, refId, model, f32.length, contentHash, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), Date.now());
}
const hasEmbedding = (kind, refId, contentHash) => {
  const r = db().prepare('SELECT content_hash FROM ai_embeddings WHERE kind = ? AND ref_id = ?').get(kind, refId);
  return !!r && r.content_hash === contentHash;
};
// All vectors of one model, as Float32Arrays, for the in-memory search.
function allEmbeddings(model) {
  return db().prepare('SELECT kind, ref_id, dims, vec FROM ai_embeddings WHERE model = ?').all(model)
    .map((r) => ({ kind: r.kind, refId: r.ref_id, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dims) }));
}
const embeddingCount = () => (db().prepare('SELECT COUNT(*) c FROM ai_embeddings').get() || {}).c || 0;
const embeddingModels = () => db().prepare('SELECT model, COUNT(*) c FROM ai_embeddings GROUP BY model ORDER BY c DESC').all();

/* ---------------- topics ---------------- */
function putTopics(chatId, topics, { model, provider } = {}) {
  const ins = db().prepare(`INSERT INTO ai_topics (id, chat_id, title, summary, keywords, people, decisions, from_ts, to_ts, msg_count, first_id, last_id, model, provider, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  for (const t of topics) {
    const id = newId('tp');
    ins.run(id, chatId, t.title, t.summary || '', JSON.stringify(t.keywords || []), JSON.stringify(t.people || []), JSON.stringify(t.decisions || []),
      t.fromTs, t.toTs, t.msgCount || 0, t.firstId || null, t.lastId || null, model || '', provider || '', Date.now());
    indexText('topic', id, topicText({ title: t.title, summary: t.summary, keywords: t.keywords, decisions: t.decisions }));
    ids.push(id);
  }
  return ids;
}
const topicsOf = (chatId) => db().prepare('SELECT * FROM ai_topics WHERE chat_id = ? ORDER BY from_ts').all(chatId).map(parseTopic);
const allTopics = () => db().prepare('SELECT * FROM ai_topics ORDER BY to_ts DESC').all().map(parseTopic);
const getTopic = (id) => { const r = db().prepare('SELECT * FROM ai_topics WHERE id = ?').get(id); return r ? parseTopic(r) : null; };
const topicCount = () => (db().prepare('SELECT COUNT(*) c FROM ai_topics').get() || {}).c || 0;
function parseTopic(r) {
  const arr = (x) => { try { const v = JSON.parse(x); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
  return { id: r.id, chatId: r.chat_id, title: r.title, summary: r.summary, keywords: arr(r.keywords), people: arr(r.people), decisions: arr(r.decisions),
    fromTs: r.from_ts, toTs: r.to_ts, msgCount: r.msg_count, firstId: r.first_id, lastId: r.last_id, createdAt: r.created_at };
}
const topicCursor = (chatId) => db().prepare('SELECT * FROM ai_topic_cursor WHERE chat_id = ?').get(chatId) || null;
function setTopicCursor(chatId, lastTs, lastId) {
  db().prepare(`INSERT INTO ai_topic_cursor (chat_id, last_ts, last_id, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET last_ts = excluded.last_ts, last_id = excluded.last_id, updated_at = excluded.updated_at`)
    .run(chatId, lastTs, lastId || null, Date.now());
}
function deleteTopicsOf(chatId) {
  for (const t of db().prepare('SELECT id FROM ai_topics WHERE chat_id = ?').all(chatId)) {
    indexText('topic', t.id, '');
    db().prepare('DELETE FROM ai_group_members WHERE kind = ? AND ref_id = ?').run('topic', t.id);
  }
  db().prepare('DELETE FROM ai_topics WHERE chat_id = ?').run(chatId);
  db().prepare('DELETE FROM ai_topic_cursor WHERE chat_id = ?').run(chatId);
}

/* ---------------- finals ---------------- */
const setKeyFor = (ids) => sha1(ids.slice().sort().join('|')).slice(0, 24);
function getFinalSet(setKey) {
  const r = db().prepare('SELECT * FROM ai_finals WHERE set_key = ?').get(setKey);
  return r ? parseFinal(r) : null;
}
function parseFinal(r) {
  const arr = (x) => { try { const v = JSON.parse(x); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
  return { id: r.id, setKey: r.set_key, kind: r.kind, chat: r.chat, members: arr(r.members), suggestedId: r.suggested_id, confidence: r.confidence || 0,
    reason: r.reason || '', ranking: arr(r.ranking), status: r.status, decidedId: r.decided_id, createdAt: r.created_at, updatedAt: r.updated_at };
}
function putFinalSet({ setKey, kind, chat, members, suggestedId, confidence, reason, ranking, model, provider, status }) {
  const existing = db().prepare('SELECT id, status, decided_id FROM ai_finals WHERE set_key = ?').get(setKey);
  const id = existing ? existing.id : newId('fin');
  if (!existing && status) {
    // A set found but not yet judged. The upsert below keeps the status of
    // an existing row; a new row takes the one asked for.
    db().prepare('INSERT INTO ai_finals (id, set_key, kind, chat, members, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, setKey, kind, chat || '', JSON.stringify(members), status, Date.now(), Date.now());
    return id;
  }
  db().prepare(`INSERT INTO ai_finals (id, set_key, kind, chat, members, suggested_id, confidence, reason, ranking, status, decided_id, model, provider, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(set_key) DO UPDATE SET members=excluded.members, suggested_id=excluded.suggested_id, confidence=excluded.confidence,
      reason=excluded.reason, ranking=excluded.ranking, model=excluded.model, provider=excluded.provider, updated_at=excluded.updated_at`)
    .run(id, setKey, kind, chat || '', JSON.stringify(members), suggestedId || null, confidence || 0, reason || '', JSON.stringify(ranking || []),
      existing ? existing.status : 'suggested', existing ? existing.decided_id : null, model || '', provider || '', Date.now(), Date.now());
  return id;
}
const listFinalSets = (status) => db().prepare(status ? 'SELECT * FROM ai_finals WHERE status = ? ORDER BY updated_at DESC' : 'SELECT * FROM ai_finals ORDER BY updated_at DESC')
  .all(...(status ? [status] : [])).map(parseFinal);
const getFinalSetById = (id) => { const r = db().prepare('SELECT * FROM ai_finals WHERE id = ?').get(id); return r ? parseFinal(r) : null; };
function decideFinalSet(id, status, decidedId) {
  db().prepare('UPDATE ai_finals SET status = ?, decided_id = ?, updated_at = ? WHERE id = ?').run(status, decidedId || null, Date.now(), id);
}
// Which sets already exist, so detection can skip what it already asked about.
const finalSetKeys = () => new Set(db().prepare('SELECT set_key FROM ai_finals').all().map((r) => r.set_key));

function markFinal(refId, { setId, localPath, cloudPath }) {
  db().prepare(`INSERT INTO finals_marks (ref_id, set_id, local_path, cloud_path, marked_at) VALUES (?,?,?,?,?)
    ON CONFLICT(ref_id) DO UPDATE SET set_id = COALESCE(excluded.set_id, finals_marks.set_id), local_path = excluded.local_path, cloud_path = excluded.cloud_path, marked_at = excluded.marked_at`)
    .run(refId, setId || null, localPath || null, cloudPath || null, Date.now());
}
const unmarkFinal = (refId) => db().prepare('DELETE FROM finals_marks WHERE ref_id = ?').run(refId).changes;
const finalMark = (refId) => db().prepare('SELECT * FROM finals_marks WHERE ref_id = ?').get(refId) || null;
const allFinalMarks = () => db().prepare('SELECT * FROM finals_marks ORDER BY marked_at DESC').all();

/* ---------------- search over the words the AI wrote ---------------- */
function searchLabels(q, limit = 100, { mode = 'all' } = {}) {
  if (!ftsOk) return [];
  const expr = messages.ftsQuery(q, { mode });
  if (!expr) return [];
  try {
    return db().prepare(`SELECT kind, ref_id AS refId, snippet(ai_fts, 2, '[[', ']]', '…', 14) AS snippet, bm25(ai_fts) AS rank
      FROM ai_fts WHERE ai_fts MATCH ? ORDER BY rank LIMIT ?`).all(expr, limit);
  } catch (_) { return []; }
}

function wipe() {
  revision++;
  db().exec(`DELETE FROM ai_labels; DELETE FROM ai_group_members; DELETE FROM ai_groups;
             DELETE FROM ai_corrections; DELETE FROM ai_jobs; DELETE FROM ai_runs;
             DELETE FROM ai_embeddings; DELETE FROM ai_topics; DELETE FROM ai_topic_cursor; DELETE FROM ai_finals;`);
  try { db().exec('DELETE FROM ai_fts'); } catch (_) {}
}

module.exports = {
  db, sha1, newId, UNFILED, labelText,
  getLabel, isLabelled, putLabel, labelsOfKinds, labelsWithGroups, labelCount, labelByHash, revision: () => revision,
  listGroups, groupOf, membersOf, createGroup, renameGroup, aliasesOf, setMember, clearAiMembers,
  pruneEmptyGroups, mergeDuplicateNames,
  addCorrection, recentCorrections,
  enqueue, enqueueMany, claim, claimType, releaseJobs, requeueStale, finishJob, retryJob, jobCounts, queuedByType, clearJobs, clearJobsOfType,
  startRun, updateRun, lastRun, spendSince, spendCapSince,
  putEmbedding, hasEmbedding, allEmbeddings, embeddingCount, embeddingModels,
  putTopics, topicsOf, allTopics, getTopic, topicCount, topicCursor, setTopicCursor, deleteTopicsOf,
  setKeyFor, getFinalSet, getFinalSetById, putFinalSet, listFinalSets, decideFinalSet, finalSetKeys,
  markFinal, unmarkFinal, finalMark, allFinalMarks,
  searchLabels, hasFts: () => ftsOk,
  wipe,
};
