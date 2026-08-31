'use strict';
// The clockwork. A minute tick walks the slots; a due slot composes its post
// from its source (queue, watched folder, album rotation, or the AI writer),
// renders what needs rendering, and hands one thing to sendStatus().
//
// Everything that could surprise the user is a rule with a visible default:
// a daily cap, a minimum gap, quiet hours, a catch-up window for slots that
// were due while the PC slept, and dry-run — which does every step except the
// last one and writes "would have posted" into the same history.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const settings = require('../settings');
const wa = require('../whatsapp');
const store = require('./store');
const renderer = require('./renderer');
const statusAi = require('./ai');
const mediaStore = require('../store');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.3gp']);
const MAX_VIDEO_SEC = 90;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

const health = { consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
let running = false;   // single-flight: one post pipeline at a time

const s = () => settings.read();
const folderPath = () => (s().statusFolder && s().statusFolder.trim()) || path.join(cfg.APP_HOME, 'status-inbox');

/* ---------------- when ---------------- */
// Next occurrence of a slot, from `from`, with up to three minutes of jitter so
// a schedule doesn't stamp posts at :00 exactly — machines post on the second,
// people don't.
function computeNextRun(slot, from) {
  const base = new Date(from);
  const jitter = Math.floor(Math.random() * 180000);
  if (slot.kind === 'interval') {
    const every = Math.max(1, slot.every_hours || slot.everyHours || 6) * 3600000;
    const anchor = slot.last_run_at || from;
    return anchor + every + jitter;
  }
  const [hh, mm] = String(slot.at || '09:00').split(':').map((n) => parseInt(n, 10) || 0);
  const next = new Date(base);
  next.setHours(hh, mm, 0, 0);
  if (slot.kind === 'weekly') {
    const target = slot.weekday == null ? 1 : slot.weekday;
    while (next.getDay() !== target || next.getTime() <= from) next.setTime(next.getTime() + 86400000);
    next.setHours(hh, mm, 0, 0);
  } else if (next.getTime() <= from) {
    next.setTime(next.getTime() + 86400000);
  }
  return next.getTime() + jitter;
}

function inQuietHours(now) {
  const from = s().statusQuietFrom, to = s().statusQuietTo;
  if (!from || !to) return false;
  const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
  const n = new Date(now); const cur = n.getHours() * 60 + n.getMinutes();
  const a = mins(from), b = mins(to);
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);   // 22:00–07:00 wraps midnight
}

function capBlocked(now) {
  const max = s().statusMaxPerDay || 3;
  const gapMin = s().statusMinGapMin || 120;
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  if (store.postsSince(midnight.getTime()) >= max) return `daily cap (${max}) reached`;
  const last = store.lastPostAt();
  if (last && now - last < gapMin * 60000) return `minimum gap (${gapMin} min) not yet passed`;
  return null;
}

/* ---------------- what ---------------- */
async function validateVideo(filePath) {
  const st = fs.statSync(filePath);
  if (st.size > MAX_VIDEO_BYTES) throw new Error(`video is ${Math.round(st.size / 1048576)} MB — over the ${MAX_VIDEO_BYTES / 1048576} MB status limit`);
  const meta = await renderer.probeVideo(filePath);
  if (!meta.ok) throw new Error('video could not be read — codec WhatsApp may not accept');
  if (meta.duration > MAX_VIDEO_SEC) throw new Error(`video is ${Math.round(meta.duration)}s — statuses top out around ${MAX_VIDEO_SEC}s`);
  return meta;
}

// Composes the next post for a slot. With consume=false nothing is dequeued,
// marked or spent-from-rotation — that is what previews use. (An AI preview
// still makes the real call: showing invented text would defeat the preview.)
async function compose(slot, { consume = true } = {}) {
  const conf = slot.config || {};

  if (slot.source === 'queue') {
    const item = store.dequeue();
    if (!item) return null;
    if (consume) store.removeQueued(item.id);
    if (item.type === 'text') {
      if ((item.template || 'gradient') === 'native') {
        return { type: 'text', text: item.body, describe: `text: “${item.body.slice(0, 60)}”` };
      }
      const card = await renderer.renderCard(item.body, item.template || 'gradient', conf.footer || s().statusFooter || '');
      return { type: 'image', filePath: card, cardFile: path.basename(card), body: item.body, describe: `card: “${item.body.slice(0, 60)}”` };
    }
    if (item.type === 'video') await validateVideo(item.body);
    return { type: item.type, filePath: item.body, caption: item.caption || '', body: item.body, describe: `${item.type}: ${path.basename(item.body)}` };
  }

  if (slot.source === 'folder') {
    const dir = folderPath();
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { return null; }
    const candidates = [];
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      const isImg = IMAGE_EXT.has(ext), isVid = VIDEO_EXT.has(ext);
      if (!isImg && !isVid) continue;
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      const seen = store.seenFile(full);
      if (seen && seen.mtime === Math.floor(st.mtimeMs) && seen.size === st.size) continue;
      candidates.push({ full, st, type: isVid ? 'video' : 'image' });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);    // oldest drop first — a queue, not a lottery
    const pick = candidates[0];
    if (pick.type === 'video') await validateVideo(pick.full);
    if (consume) store.markFilePosted(pick.full, Math.floor(pick.st.mtimeMs), pick.st.size);
    return { type: pick.type, filePath: pick.full, caption: conf.caption || '', sourceRef: pick.full, describe: `${pick.type} from folder: ${path.basename(pick.full)}` };
  }

  if (slot.source === 'album') {
    const aiStore = require('../ai/store');
    const members = aiStore.membersOf ? aiStore.membersOf(conf.albumId) : [];
    const recs = members
      .map((m) => mediaStore.get(m.ref_id || m.refId))
      .filter((r) => r && (r.kind === 'image' || r.kind === 'video'));
    if (!recs.length) return null;
    const last = store.lastPostedRef(recs.map((r) => r.id));
    recs.sort((a, b) => (last.get(a.id) || 0) - (last.get(b.id) || 0));   // least-recently-posted first
    const rec = recs[0];
    const base = rec.kind === 'video' ? cfg.VIDEO_DIR : cfg.IMAGES_DIR;
    const full = path.join(base, rec.filename);
    if (!fs.existsSync(full)) return null;
    if (rec.kind === 'video') await validateVideo(full);
    return { type: rec.kind, filePath: full, caption: conf.caption || '', sourceRef: rec.id, describe: `${rec.kind} from album: ${rec.chat}` };
  }

  if (slot.source === 'ai') {
    const { text } = await statusAi.composeStatus({ promptOverride: conf.prompt });
    if ((conf.template || 'gradient') === 'native') {
      return { type: 'text', text, body: text, describe: `AI text: “${text.slice(0, 60)}”` };
    }
    const card = await renderer.renderCard(text, conf.template || 'gradient', conf.footer || s().statusFooter || '');
    return { type: 'image', filePath: card, cardFile: path.basename(card), body: text, describe: `AI card: “${text.slice(0, 60)}”` };
  }

  return null;
}

/* ---------------- the post itself ---------------- */
async function postComposed(composed, meta) {
  const dry = !!s().statusDryRun;
  const hist = {
    slotId: meta.slotId || null, source: meta.source, sourceRef: composed.sourceRef || null,
    type: composed.type, body: composed.body || composed.filePath || composed.text || '',
    caption: composed.caption || null,
    cardFile: composed.cardFile || (composed.filePath && !composed.cardFile ? renderer.keepForHistory(composed.filePath) : null),
    dry,
  };
  if (dry) {
    store.addHistory({ ...hist, ok: 1 });
    console.log(`[status] DRY RUN — would post ${composed.describe}`);
    return { ok: true, dry: true };
  }
  try {
    const r = await wa.sendStatus(composed);
    store.addHistory({ ...hist, ok: 1, waMsgId: r.id });
    health.consecutiveFailures = 0; health.lastOkAt = Date.now(); health.lastError = null;
    console.log(`[status] Posted ${composed.describe}`);
    return { ok: true, id: r.id };
  } catch (e) {
    store.addHistory({ ...hist, ok: 0, error: e.message });
    health.consecutiveFailures++; health.lastError = e.message; health.lastErrorAt = Date.now();
    console.error(`[status] Post failed: ${e.message} (${health.consecutiveFailures} in a row)`);
    return { ok: false, error: e.message };
  }
}

async function runSlot(slot, now) {
  const blocked = capBlocked(now);
  if (blocked) {
    store.addHistory({ slotId: slot.id, source: slot.source, ok: 0, dry: 0, error: 'skipped: ' + blocked, type: 'skip' });
    store.updateSlot(slot.id, { nextRunAt: now + 30 * 60000 });   // try again after the gap has had a chance to pass
    return;
  }
  if (inQuietHours(now)) {
    store.updateSlot(slot.id, { nextRunAt: now + 15 * 60000 });
    return;
  }
  let composed = null, err = null;
  try { composed = await compose(slot, { consume: true }); }
  catch (e) { err = e; }
  if (err) {
    store.addHistory({ slotId: slot.id, source: slot.source, ok: 0, error: err.message, type: 'error' });
    health.consecutiveFailures++; health.lastError = err.message; health.lastErrorAt = Date.now();
  } else if (!composed) {
    // An empty source is quietly fine — an empty queue shouldn't cry wolf.
    console.log(`[status] Slot ${slot.id}: nothing to post (${slot.source} is empty)`);
  } else {
    await postComposed(composed, { slotId: slot.id, source: slot.source });
  }
  store.updateSlot(slot.id, { lastRunAt: now, nextRunAt: computeNextRun({ ...slot, last_run_at: now }, now) });
}

/* ---------------- the loop ---------------- */
async function tick() {
  const st = s();
  if (!st.statusEnabled || !st.statusConsent || st.statusPaused) return;
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const catchup = (st.statusCatchupMin || 120) * 60000;
    for (const slot of store.listSlots()) {
      if (!slot.enabled) continue;
      if (!slot.next_run_at) { store.updateSlot(slot.id, { nextRunAt: computeNextRun(slot, now) }); continue; }
      if (now < slot.next_run_at) continue;
      if (now - slot.next_run_at > catchup) {
        // Due while the PC was off, and too long ago to still make sense.
        store.addHistory({ slotId: slot.id, source: slot.source, ok: 0, type: 'skip', error: `skipped: missed by more than ${Math.round(catchup / 60000)} min` });
        store.updateSlot(slot.id, { nextRunAt: computeNextRun(slot, now) });
        continue;
      }
      await runSlot(slot, now);
    }
  } catch (e) {
    console.error('[status] tick failed:', e.message);
  } finally { running = false; }
}

let timer = null;
function init() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 60000);
  console.log('[status] scheduler armed (checks every minute)');
}

/* ---------------- surface for the API ---------------- */
const summary = () => ({
  enabled: !!s().statusEnabled, consent: !!s().statusConsent,
  paused: !!s().statusPaused, dryRun: !!s().statusDryRun,
  folder: folderPath(),
  postsToday: (() => { const m = new Date(); m.setHours(0, 0, 0, 0); return store.postsSince(m.getTime()); })(),
  lastPostAt: store.lastPostAt(),
  health: { ...health, ok: health.consecutiveFailures < 3 },
  slots: store.listSlots().map((x) => ({ ...x, config: x.config })),
});

// The Post-now button and the preview pane share the slot pipeline, so what a
// preview shows is what a real run would do.
async function postNow(input) {
  const fake = { id: null, source: input.source || 'queue', config: input.config || {} };
  let composed;
  if (input.direct) {
    if (input.direct.type === 'text' && (input.direct.template || 'gradient') !== 'native') {
      const card = await renderer.renderCard(input.direct.text, input.direct.template || 'gradient', s().statusFooter || '');
      composed = { type: 'image', filePath: card, cardFile: path.basename(card), body: input.direct.text, describe: `card: “${String(input.direct.text).slice(0, 60)}”` };
    } else if (input.direct.type === 'text') {
      composed = { type: 'text', text: input.direct.text, body: input.direct.text, describe: 'text status' };
    } else {
      if (input.direct.type === 'video') await validateVideo(input.direct.filePath);
      composed = { type: input.direct.type, filePath: input.direct.filePath, caption: input.direct.caption || '', describe: `${input.direct.type}: ${path.basename(input.direct.filePath)}` };
    }
  } else {
    composed = await compose(fake, { consume: true });
    if (!composed) return { ok: false, error: 'Nothing to post from that source.' };
  }
  return postComposed(composed, { slotId: null, source: input.source || 'manual' });
}

async function preview(input) {
  const fake = { id: null, source: input.source, config: input.config || {} };
  const composed = await compose(fake, { consume: false });
  if (!composed) return { empty: true };
  return {
    type: composed.type, text: composed.body || composed.text || null,
    describe: composed.describe,
    cardFile: composed.cardFile || null,
    file: composed.filePath ? path.basename(composed.filePath) : null,
  };
}

module.exports = { init, tick, summary, postNow, preview, computeNextRun, capBlocked, inQuietHours };
