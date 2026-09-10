'use strict';
const fs = require('fs');
const cfg = require('./config');

// In-memory, parsed index — loaded once, kept in sync on append. Avoids
// re-reading & re-parsing the whole ndjson file on every request.
let records = [];
const seen = new Set();
const byId = new Map();

// Items moved to quarantine by the cleanup pass. Kept beside the index rather
// than in it: the index is append-only, and a hidden record is still a record
// - it comes back with one click.
const hidden = new Set();
const hiddenFile = () => require('path').join(cfg.DATA_DIR, 'quarantine.json');
function loadHidden() {
  hidden.clear();
  try { for (const id of JSON.parse(fs.readFileSync(hiddenFile(), 'utf8'))) hidden.add(id); } catch (_) {}
}
function saveHidden() {
  try { fs.writeFileSync(hiddenFile(), JSON.stringify([...hidden])); } catch (_) {}
}
function hide(ids) { for (const id of ids) hidden.add(id); saveHidden(); }
function unhide(ids) { for (const id of ids) hidden.delete(id); saveHidden(); }
const hiddenIds = () => new Set(hidden);

function ensureDirs() {
  for (const d of [cfg.IMAGES_DIR, cfg.VIDEO_DIR, cfg.FILES_DIR, cfg.DATA_DIR, cfg.LOGS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}   // a missing cloud drive must not stop startup
  }
  if (cfg.MIRROR_IMAGES_TO_CLOUD) {
    try { fs.mkdirSync(cfg.IMAGE_CLOUD_DIR, { recursive: true }); } catch (_) {}
  }
  if (!fs.existsSync(cfg.INDEX_FILE)) fs.writeFileSync(cfg.INDEX_FILE, '');
}

function loadAll() {
  records = [];
  seen.clear();
  byId.clear();
  loadHidden();
  try {
    const raw = fs.readFileSync(cfg.INDEX_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); records.push(r); seen.add(r.id); byId.set(r.id, r); } catch (_) {}
    }
  } catch (_) {}
  records.sort((a, b) => b.ts - a.ts);
}

function has(id) { return seen.has(id); }
function get(id) { return byId.get(id) || null; }

function addRecord(rec) {
  if (seen.has(rec.id)) return false;
  seen.add(rec.id);
  byId.set(rec.id, rec);
  records.push(rec);
  fs.appendFileSync(cfg.INDEX_FILE, JSON.stringify(rec) + '\n');
  return true;
}

function listRecords({ kind, since, direction, chat } = {}) {
  const q = chat ? chat.toLowerCase() : null;
  const out = records.filter((r) => {
    if (hidden.has(r.id)) return false;      // in quarantine
    if (kind && r.kind !== kind) return false;
    if (direction && r.dir !== direction) return false;
    // `<` (not `<=`) so items sharing the newest whole-second timestamp are still
    // returned on incremental polls; the client dedupes by id.
    if (since && r.ts < since) return false;
    if (q && !(r.chat || '').toLowerCase().includes(q)) return false;
    return true;
  });
  return out.sort((a, b) => b.ts - a.ts);
}

function counts() {
  let images = 0, videos = 0;
  for (const r of records) { if (hidden.has(r.id)) continue; if (r.kind === 'image') images++; else if (r.kind === 'video') videos++; }
  return { images, videos };
}

// The index is append-only, so a name learned later is written by rewriting
// the file once. Only records still called "unknown" that belong to the chat
// are touched; the id carries the chat id between its underscores.
function renameChat(chatId, name) {
  const needle = '_' + chatId + '_';
  let changed = 0;
  for (const r of records) {
    if (r.chat === 'unknown' && String(r.id).includes(needle)) { r.chat = name; changed++; }
  }
  if (!changed) return 0;
  const tmp = cfg.INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, records.slice().sort((a, b) => a.ts - b.ts).map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, cfg.INDEX_FILE);
  return changed;
}

// Records taken out for good — the one case the append-only index is
// rewritten with something missing. Used where a record should never have
// existed (the same picture saved twice), not for anything a person might
// want back: that is what quarantine is for.
function removeRecords(ids) {
  const drop = new Set(ids);
  const before = records.length;
  records = records.filter((r) => !drop.has(r.id));
  if (records.length === before) return 0;
  for (const id of drop) { seen.delete(id); byId.delete(id); hidden.delete(id); }
  saveHidden();
  const tmp = cfg.INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, records.slice().sort((a, b) => a.ts - b.ts).map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, cfg.INDEX_FILE);
  return before - records.length;
}

module.exports = { renameChat, ensureDirs, loadAll, has, get, addRecord, removeRecords, listRecords, counts, hide, unhide, hiddenIds };
