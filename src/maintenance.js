'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');

// Clear gallery entries. Default: only welcome samples. { all:true } wipes every
// image record + local image file. Video files in pCloud are left in place.
function clearGallery({ all = false } = {}) {
  let records = [];
  try { records = fs.readFileSync(cfg.INDEX_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) {}
  const remove = records.filter((r) => all || r.sample);
  const keep = records.filter((r) => !(all || r.sample));
  let deleted = 0;
  for (const r of remove) {
    if (r.kind === 'image') {
      const p = path.join(cfg.IMAGES_DIR, r.filename);
      try { if (fs.existsSync(p)) { fs.unlinkSync(p); deleted++; } } catch (_) {}
    }
  }
  fs.writeFileSync(cfg.INDEX_FILE, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
  try { store.loadAll(); } catch (_) {} // re-sync in-memory index (also refreshes counts)
  return { removed: remove.length, deleted, kept: keep.length };
}

module.exports = { clearGallery };
