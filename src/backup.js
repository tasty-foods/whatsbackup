'use strict';
// Is it actually on pCloud?
//
// The product's promise is that nothing is lost. What the code did about that
// was copy an image to the cloud folder at the moment it arrived, if a setting
// was on, and swallow the error if the drive was away — and never look again.
// Videos arriving while the drive was away went to a local folder and stayed
// there. Pictures from ChatGPT and Gemini were never copied at all. The record
// carried a `cloud` flag that was only ever set on videos, and only at the
// moment of capture, so it could not be believed either way.
//
// This asks the only witness that counts: the cloud folder. A record is backed
// up when its file is there. Whatever is not there gets copied when the drive
// is reachable — after captures, on a schedule, and on demand — and the count
// of what is still only on this PC is put where it can be seen.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');

const PROBE_TTL_MS = 30 * 1000;       // how often to re-check that the drive is there
const EXIST_TTL_MS = 120 * 1000;      // how long a "yes, it is on the cloud" answer is trusted
const NUDGE_DELAY_MS = 20 * 1000;     // captures come in bursts; one sweep after the burst
const SWEEP_EVERY_MS = 30 * 60 * 1000;

const state = {
  running: false,
  startedAt: null, finishedAt: null,
  copied: 0, failed: 0, bytes: 0,
  lastError: null,
  lastSweepAt: null,
};
let probe = { at: 0, available: false };
const known = new Map();              // id -> { on: boolean, at: ms }
let nudgeTimer = null;
let periodic = null;

const log = (...a) => console.log('[backup]', ...a);

// Where a record's copy should live on the cloud. Computed from CLOUD_ROOT,
// not from VIDEO_DIR, because VIDEO_DIR is rebound to a local folder when the
// drive is away at startup and would then point at the wrong place.
function cloudPathFor(rec) {
  if (!cfg.CLOUD_ROOT) return null;
  if (rec.kind === 'video') return path.join(cfg.CLOUD_ROOT, 'Videos', rec.filename);
  if (rec.kind === 'image' || rec.kind === 'sticker') return path.join(cfg.CLOUD_ROOT, 'Images', rec.filename);
  return path.join(cfg.CLOUD_ROOT, 'Files', rec.filename);
}

// Where the local copy is, if there is one.
function localPathFor(rec) {
  const dirs = rec.kind === 'video' ? [cfg.LOCAL_VIDEO_DIR, cfg.VIDEO_DIR]
    : rec.kind === 'image' || rec.kind === 'sticker' ? [cfg.IMAGES_DIR]
      : [cfg.FILES_DIR];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, rec.filename);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function available() {
  if (!cfg.CLOUD_ROOT) return false;
  if (Date.now() - probe.at < PROBE_TTL_MS) return probe.available;
  let ok = false;
  try { ok = fs.statSync(cfg.CLOUD_ROOT).isDirectory(); } catch (_) { ok = false; }
  probe = { at: Date.now(), available: ok };
  return ok;
}

// The size a cloud copy must match is the file we would copy from. The
// record's size is what the message said on arrival; a re-download can
// change the bytes, and then a perfect copy would be called missing for ever.
function expectedSize(rec) {
  const src = localPathFor(rec);
  if (src) { try { return fs.statSync(src).size; } catch (_) {} }
  return rec.size || 0;
}

function onCloud(rec) {
  const hit = known.get(rec.id);
  if (hit && Date.now() - hit.at < EXIST_TTL_MS) return hit.on;
  const p = cloudPathFor(rec);
  let on = false;
  if (p) {
    try {
      const file = fs.statSync(p);
      const want = expectedSize(rec);
      on = file.isFile() && file.size > 0 && (!want || file.size === want);
    } catch (_) { on = false; }
  }
  known.set(rec.id, { on, at: Date.now() });
  return on;
}

function status({ ids = true } = {}) {
  const configured = !!cfg.CLOUD_ROOT;
  const avail = available();
  const hidden = store.hiddenIds();
  const recs = store.listRecords({}).filter((r) => !hidden.has(r.id) && !r.sample);
  const byKind = {};
  const onlyHere = [];
  let on = 0;
  for (const r of recs) {
    const k = r.kind === 'sticker' ? 'image' : (r.kind === 'image' || r.kind === 'video') ? r.kind : 'file';
    byKind[k] = byKind[k] || { total: 0, onCloud: 0 };
    byKind[k].total++;
    // With no drive configured nothing is on the cloud and that is the answer;
    // with one configured but away, the last known answers stand.
    const here = configured && onCloud(r);
    if (here) { on++; byKind[k].onCloud++; } else onlyHere.push(r.id);
  }
  return {
    configured, available: avail, root: cfg.CLOUD_ROOT || null,
    total: recs.length, onCloud: on, onlyHere: recs.length - on,
    byKind,
    onlyHereIds: ids ? onlyHere : undefined,
    sweep: { ...state },
  };
}

// Copy everything that is only here, while the drive is there. Never moves,
// never deletes: a second copy is the point.
async function sweep({ reason = 'manual' } = {}) {
  if (state.running) return { ok: false, error: 'already running' };
  if (!cfg.CLOUD_ROOT) return { ok: false, error: 'no cloud folder set' };
  probe.at = 0;
  if (!available()) return { ok: false, error: 'cloud folder not reachable' };
  known.clear();
  state.running = true; state.startedAt = Date.now(); state.finishedAt = null;
  state.copied = 0; state.failed = 0; state.bytes = 0; state.lastError = null;
  const hidden = store.hiddenIds();
  const recs = store.listRecords({}).filter((r) => !hidden.has(r.id) && !r.sample);
  let i = 0;
  try {
    for (const r of recs) {
      if (onCloud(r)) continue;
      const src = localPathFor(r);
      const dst = cloudPathFor(r);
      if (!src || !dst) {
        state.failed++; state.lastError = 'An original file is missing. Check your media folder.';
        continue;
      }
      const temporary = dst + '.whatsbackup-part';
      try {
        if (path.resolve(src) === path.resolve(dst)) throw new Error('The cloud file is incomplete and no separate local copy is available.');
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, temporary);
        const size = fs.statSync(temporary).size;
        const want = fs.statSync(src).size;
        if (!size || size !== want) throw new Error('The copy came out a different size from the original.');
        fs.renameSync(temporary, dst);
        state.copied++;
        try { state.bytes += fs.statSync(dst).size; } catch (_) {}
        known.set(r.id, { on: true, at: Date.now() });
      } catch (e) {
        try { fs.rmSync(temporary, { force: true }); } catch (_) {}
        state.failed++; state.lastError = e.message;
        // The drive going away mid-sweep looks like a run of failures; stop
        // rather than fail every remaining item one by one.
        probe.at = 0;
        if (!available()) break;
      }
      // Yield now and then so a big first sweep does not stall the server.
      if (++i % 25 === 0) await new Promise((res) => setImmediate(res));
    }
  } finally {
    state.running = false; state.finishedAt = Date.now(); state.lastSweepAt = Date.now();
    probe.at = 0;                                 // re-probe next time
  }
  if (state.copied || state.failed) log(`sweep (${reason}): ${state.copied} copied, ${state.failed} failed${state.lastError ? ' — ' + state.lastError : ''}`);
  return { ok: true, copied: state.copied, failed: state.failed, bytes: state.bytes };
}

// Called after something new is saved. Captures arrive in bursts, so wait for
// the burst to end and sweep once.
function nudge() {
  if (!cfg.CLOUD_ROOT) return;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { sweep({ reason: 'new items' }); }, NUDGE_DELAY_MS);
  if (nudgeTimer.unref) nudgeTimer.unref();
}

function init() {
  if (!cfg.CLOUD_ROOT) { log('no cloud folder set — nothing to mirror to'); return; }
  // A minute after start, once the drive has had its chance to mount.
  const t = setTimeout(() => { sweep({ reason: 'startup' }); }, 60 * 1000);
  if (t.unref) t.unref();
  periodic = setInterval(() => { sweep({ reason: 'scheduled' }); }, SWEEP_EVERY_MS);
  if (periodic.unref) periodic.unref();
}

module.exports = { init, status, sweep, nudge, onCloud, available };
