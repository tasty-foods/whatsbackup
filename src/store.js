'use strict';
const fs = require('fs');
const cfg = require('./config');

// In-memory, parsed index — loaded once, kept in sync on append. Avoids
// re-reading & re-parsing the whole ndjson file on every request.
let records = [];
const seen = new Set();
const byId = new Map();

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
  for (const r of records) { if (r.kind === 'image') images++; else if (r.kind === 'video') videos++; }
  return { images, videos };
}

module.exports = { ensureDirs, loadAll, has, get, addRecord, listRecords, counts };
