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

// Documents saved before their extension was worked out properly ended in the
// tail of a long type ("…spreadsheetml.sheet"), which Windows will not open.
// Each is renamed to what it is — after the id, a single proper extension —
// and the cloud copy, if the backup already made one, follows its name.
const OFFICE = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
};
function fixDocNames({ dryRun = false } = {}) {
  const out = { dryRun, found: 0, renamed: 0, cloudRenamed: 0, names: [] };
  for (const r of store.listRecords({})) {
    if (r.kind !== 'document') continue;
    const own = /\.([A-Za-z0-9]{1,6})$/.exec(r.docName || '');
    const want = own ? own[1].toLowerCase() : OFFICE[(r.mimetype || '').split(';')[0].trim()];
    if (!want) continue;                                   // nothing better to call it
    // <stamp>__<dir>__<chat>__<id10>.<ext>: everything after the id is the extension.
    const next = r.filename.replace(/(__[A-Za-z0-9]{10})\..*$/, '$1') + '.' + want;
    if (next === r.filename) continue;
    out.found++; out.names.push(next);
    if (dryRun) continue;
    const oldName = r.filename;
    if (!store.renameFile(r.id, next, cfg.FILES_DIR)) continue;
    out.renamed++;
    if (cfg.CLOUD_ROOT) {
      const a = path.join(cfg.CLOUD_ROOT, 'Files', oldName), b = path.join(cfg.CLOUD_ROOT, 'Files', next);
      try { if (fs.existsSync(a) && !fs.existsSync(b)) { fs.renameSync(a, b); out.cloudRenamed++; } } catch (_) {}
    }
  }
  return out;
}

// Once per install, on the first start that has it.
function fixDocNamesOnce() {
  const marker = path.join(cfg.DATA_DIR, 'doc-names-fixed');
  if (fs.existsSync(marker)) return null;
  let r = null;
  try {
    r = fixDocNames();
    if (r.renamed) console.log(`[files] renamed ${r.renamed} document${r.renamed === 1 ? '' : 's'} to open properly` + (r.cloudRenamed ? ` (${r.cloudRenamed} in the cloud folder)` : ''));
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) { console.warn('[files] could not fix document names:', e.message); }
  return r;
}

module.exports = { clearGallery, fixDocNames, fixDocNamesOnce };
