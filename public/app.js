'use strict';

const els = {
  sub: document.getElementById('sub'),
  link: document.getElementById('link'),
  linkTitle: document.getElementById('link-title'),
  qrwrap: document.getElementById('qrwrap'),
  gallery: document.getElementById('gallery'),
  empty: document.getElementById('empty'),
  search: document.getElementById('search'),
  tabs: document.getElementById('tabs'),
  zip: document.getElementById('zip'),
  lightbox: document.getElementById('lightbox'),
  lbStage: document.getElementById('lb-stage'),
  lbMeta: document.getElementById('lb-meta'),
  lbClose: document.getElementById('lb-close'),
  lbPrev: document.getElementById('lb-prev'),
  lbNext: document.getElementById('lb-next'),
};

let filter = 'all';        // all | image | video | in | out
let query = '';
let allItems = [];         // full list, newest first
// Filter state lives up here with the rest: render() runs during the first
// load, long before the bottom of this file has executed, and a const declared
// down there is still in its dead zone when the first render reaches it.
const F = {
  kind: '', dir: '', album: '', project: '', tag: '', from: '', to: '', sort: 'new',
};
const fEl = (id) => document.getElementById(id);

let filteredCache = [];    // allItems with the current filter applied
let renderedCount = 0;     // how many of filteredCache are in the DOM
let lastDayRendered = null;
let sentinel = null;
let io = null;
let newestTs = 0;
let lbId = null;           // id of the item currently open in the lightbox
const CHUNK = 140;

function fmtTime(ms) { return new Date(ms).toLocaleString([], { hour: '2-digit', minute: '2-digit' }); }
function dayKey(ms) { return new Date(ms).toDateString(); }
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (same(d, now)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Stickers sit with images; voice notes, audio and documents are "files".
const FILE_KINDS = new Set(['voice', 'audio', 'document']);
const KIND_ICON = { voice: '🎤', audio: '🎵', document: '📄', sticker: '🌟' };
const KIND_LABEL = { voice: 'Voice note', audio: 'Audio', document: 'Document', sticker: 'Sticker' };

function matchesFilter(r) {
  // Search matches the chat name or, once labelled, what is actually in the picture.
  if (query && !((r.chat || '').toLowerCase().includes(query))
    && !(typeof AI !== 'undefined' && AI.matchesText(r, query))) return false;
  if (typeof AI !== 'undefined' && !AI.passes(r)) return false;
  if (typeof matchesAdvanced === 'function' && !matchesAdvanced(r)) return false;
  if (filter === 'all') return true;
  if (filter === 'image') return r.kind === 'image' || r.kind === 'sticker';
  if (filter === 'video') return r.kind === 'video';
  if (filter === 'file') return FILE_KINDS.has(r.kind);
  if (filter === 'in' || filter === 'out') return r.dir === filter;
  return true;
}

function makeDayLabel(ms) {
  const el = document.createElement('div');
  el.className = 'day-label';
  el.dataset.day = dayKey(ms);
  el.textContent = dayLabel(ms);
  return el;
}

function tile(r) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = r.id;
  const badge = r.dir === 'out' ? '<span class="badge out">↑ Sent</span>' : '<span class="badge in">↓ Received</span>';
  const lbl = typeof AI !== 'undefined' ? AI.labelFor(r.id) : null;
  const albumTag = lbl && lbl.groupName
    ? `<span class="albumtag">${escapeHtml(lbl.groupEmoji || '📁')} ${escapeHtml(lbl.groupName)}</span>` : '';
  const cap = `<div class="cap"><span class="chat">${escapeHtml(r.chat)}</span><span class="time">${fmtTime(r.ts)}</span></div>${albumTag}`;
  if (r.kind === 'image' || r.kind === 'sticker') {
    el.innerHTML = `<img loading="lazy" src="${r.serve}" alt="" onerror="this.classList.add('imgerr')" />${badge}${cap}`;
  } else if (r.kind === 'video') {
    // A real video rather than a placeholder glyph, so the grid shows what the
    // clip actually is. The #t= fragment makes the browser paint that frame as
    // the still, which saves generating and storing poster images for every
    // video — and these sit on a cloud drive where writing thumbnails back
    // would be slow and untidy.
    el.innerHTML = `<div class="videotile">
        <video class="tile-vid" muted playsinline loop preload="none" data-src="${r.serve}#t=${PREVIEW_AT}"></video>
        <div class="play">▶</div>
        <div class="mutehint" title="Muted while previewing — click to open it with sound">🔇</div>
      </div>${badge}${cap}`;
  } else {
    const name = r.docName || decodeURIComponent((r.serve || '').split('/').pop() || '');
    el.innerHTML = `<div class="filetile"><div class="fileicon">${KIND_ICON[r.kind] || '📎'}</div>
        <div class="filename">${escapeHtml(name)}</div>
        <div class="filekind">${escapeHtml(KIND_LABEL[r.kind] || r.kind)}</div></div>${badge}${cap}`;
  }
  el.addEventListener('click', () => openLightbox(r));
  if (r.kind === 'video') wireVideoPreview(el);
  return el;
}

/* ---------- Hover previews -----------------------------------------------
   Point at a video and it plays silently in place, the way a feed does;
   click and it opens with sound. Silent because a grid that starts talking
   when the pointer crosses it is unbearable — and because browsers refuse
   to autoplay with sound anyway. */
const PREVIEW_AT = 0.5;          // seconds in: past any black leading frame

function loadTileVideo(v) {
  if (!v || v.dataset.loaded === '1') return;
  v.dataset.loaded = '1';
  v.preload = 'metadata';
  v.src = v.dataset.src;         // carries #t=, so a frame is painted, not a black box
}

// Metadata is fetched when a tile nears the viewport rather than for the whole
// library at once: each one is a request to the cloud drive, and there can be
// hundreds of them.
const tileVideoIO = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        loadTileVideo(e.target.querySelector('.tile-vid'));
        tileVideoIO.unobserve(e.target);
      }
    }, { rootMargin: '250px' })
  : null;

// Someone who has asked the system for less motion should not get video
// starting under the pointer; they still get the still frame and the click.
const wantsStill = (() => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
})();

function wireVideoPreview(el) {
  const v = el.querySelector('.tile-vid');
  if (!v) return;
  if (wantsStill) { if (tileVideoIO) tileVideoIO.observe(el); return; }
  let hold = null;
  el.addEventListener('mouseenter', () => {
    loadTileVideo(v);            // also covers the case where the observer never ran
    clearTimeout(hold);
    // A beat before starting, so sweeping the pointer across the grid doesn't
    // kick off a dozen downloads that are all abandoned immediately.
    hold = setTimeout(() => {
      try { v.currentTime = 0; } catch (_) {}
      v.play().then(() => el.classList.add('previewing')).catch(() => {});
    }, 180);
  });
  el.addEventListener('mouseleave', () => {
    clearTimeout(hold);
    el.classList.remove('previewing');
    try { v.pause(); v.currentTime = PREVIEW_AT; } catch (_) {}   // back to the still
  });
  if (tileVideoIO) tileVideoIO.observe(el);
}

/* ---------- Chunked rendering (only materialize what's needed) ---------- */
function ensureSentinel() {
  if (!sentinel) { sentinel = document.createElement('div'); sentinel.id = 'sentinel'; }
  els.gallery.appendChild(sentinel);
  if (io) io.observe(sentinel);
}
function appendChunk() {
  if (sentinel && sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
  const next = filteredCache.slice(renderedCount, renderedCount + CHUNK);
  const frag = document.createDocumentFragment();
  for (const r of next) {
    const dk = dayKey(r.ts);
    if (dk !== lastDayRendered) { frag.appendChild(makeDayLabel(r.ts)); lastDayRendered = dk; }
    frag.appendChild(tile(r));
  }
  els.gallery.appendChild(frag);
  renderedCount += next.length;
  ensureSentinel();
}
function fillViewport() {
  let guard = 0;
  while (renderedCount < filteredCache.length && guard++ < 40) {
    const rect = sentinel ? sentinel.getBoundingClientRect() : null;
    if (rect && rect.top > window.innerHeight + 900) break;
    appendChunk();
  }
}
function render(all) {
  if (all !== undefined) allItems = all;
  filteredCache = allItems.filter(matchesFilter);
  if (typeof sortRecords === 'function') sortRecords(filteredCache);
  if (typeof updateFilterCount === 'function') updateFilterCount(filteredCache.length, allItems.length);
  els.gallery.innerHTML = '';
  renderedCount = 0; lastDayRendered = null; sentinel = null;
  els.empty.classList.toggle('hidden', filteredCache.length > 0);
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && renderedCount < filteredCache.length) appendChunk();
  }, { rootMargin: '900px' });
  appendChunk();
  fillViewport();
}

// Prepend genuinely new (newest) items without rebuilding the whole gallery.
function prependNew(items) {
  const matching = items.filter(matchesFilter);
  if (!matching.length) return;
  filteredCache = matching.concat(filteredCache);
  const oldFirstLabel = els.gallery.querySelector('.day-label');
  const lastNewDay = dayKey(matching[matching.length - 1].ts);
  const frag = document.createDocumentFragment();
  let ld = null;
  for (const r of matching) {
    const dk = dayKey(r.ts);
    if (dk !== ld) { frag.appendChild(makeDayLabel(r.ts)); ld = dk; }
    frag.appendChild(tile(r));
  }
  els.gallery.insertBefore(frag, els.gallery.firstChild);
  if (oldFirstLabel && oldFirstLabel.dataset.day === lastNewDay) oldFirstLabel.remove();
  renderedCount += matching.length;
  els.empty.classList.add('hidden');
}

/* ---------- Lightbox (tracked by id so it survives live updates) ---------- */
function currentIndex() { return filteredCache.findIndex((r) => r.id === lbId); }
function openLightbox(r) { lbId = r.id; els.lightbox.classList.remove('hidden'); showCurrent(); }
function closeLightbox() { els.lightbox.classList.add('hidden'); els.lbStage.innerHTML = ''; lbId = null; }
function showCurrent() {
  const i = currentIndex();
  if (i < 0) return;
  const r = filteredCache[i];
  els.lbStage.innerHTML = '';
  let el;
  if (r.kind === 'image' || r.kind === 'sticker') { el = document.createElement('img'); el.src = r.serve; }
  else if (r.kind === 'video') { el = document.createElement('video'); el.src = r.serve; el.controls = true; el.autoplay = true; el.playsInline = true; }
  else if (r.kind === 'voice' || r.kind === 'audio') { el = document.createElement('audio'); el.src = r.serve; el.controls = true; el.autoplay = true; }
  else {
    el = document.createElement('div');
    el.className = 'lb-file';
    el.innerHTML = `<div class="fileicon big">${KIND_ICON[r.kind] || '📎'}</div>
      <div class="filename">${escapeHtml(r.docName || decodeURIComponent((r.serve || '').split('/').pop() || ''))}</div>`;
  }
  el.onerror = () => {
    els.lbStage.innerHTML = `<div class="lb-unavailable">⚠ This ${escapeHtml(r.kind)} can't be loaded right now.` +
      (r.kind === 'video' ? '<br><span>If it’s stored in a cloud folder, the drive may be offline.</span>' : '') + '</div>';
  };
  els.lbStage.appendChild(el);
  const sizeKb = r.size ? (r.size / 1024).toFixed(0) + ' KB' : '';
  const cloudTag = r.kind === 'video' && r.cloud ? ' · <span class="m-sub">saved to your cloud folder</span>' : '';
  const lbl = typeof AI !== 'undefined' ? AI.labelFor(r.id) : null;
  const l = lbl && lbl.label;
  const aiBlock = l ? `<span class="m-ai">${escapeHtml(l.caption || l.summary || '')}
      ${(l.tags || []).slice(0, 6).map((t) => `<em>${escapeHtml(t)}</em>`).join('')}
      ${l.text_in_image ? `<span class="m-ocr">reads: “${escapeHtml(String(l.text_in_image).slice(0, 120))}”</span>` : ''}
      ${l.visual === false ? '<span class="m-ocr">described from its chat — videos aren\'t shown to the AI</span>' : ''}
    </span>` : '';
  els.lbMeta.innerHTML = `<span class="m-chat">${escapeHtml(r.chat)}</span>
    <span class="m-sub">${r.dir === 'out' ? 'Sent' : 'Received'} · ${new Date(r.ts).toLocaleString()} · ${sizeKb}${cloudTag}</span>
    ${aiBlock}
    ${typeof AI !== 'undefined' && AI.groups().length ? AI.albumPicker(r) : ''}
    <a href="${r.serve}" download>⭳ Download</a>
    ${(r.kind === 'image' || r.kind === 'video') ? '<a href="#" id="lb-queue-status" title="Add to the status queue">📣 Queue as status</a>' : ''}`;
  if (typeof AI !== 'undefined') AI.bindAlbumPicker(r);
  const qs = document.getElementById('lb-queue-status');
  if (qs) qs.addEventListener('click', async (e) => {
    e.preventDefault();
    const resp = await fetch('/api/status/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId: r.id }) }).then((x) => x.json());
    qs.textContent = resp.ok ? '✓ In the status queue' : ('✗ ' + (resp.error || 'failed'));
  });
  els.lbPrev.style.visibility = i > 0 ? 'visible' : 'hidden';
  els.lbNext.style.visibility = i < filteredCache.length - 1 ? 'visible' : 'hidden';
}
function step(d) {
  const i = currentIndex();
  if (i < 0) return;
  const j = i + d;
  if (j < 0 || j >= filteredCache.length) return;
  lbId = filteredCache[j].id;
  showCurrent();
}
els.lbClose.addEventListener('click', closeLightbox);
els.lbPrev.addEventListener('click', () => step(-1));
els.lbNext.addEventListener('click', () => step(1));
els.lightbox.addEventListener('click', (e) => { if (e.target === els.lightbox) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  if (els.lightbox.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

/* ---------- Controls ---------- */
els.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...els.tabs.children].forEach((c) => c.classList.remove('active'));
  b.classList.add('active');
  filter = b.dataset.f;
  render(allItems);
});
let searchT;
els.search.addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { query = els.search.value.trim().toLowerCase(); render(allItems); }, 150);
});

/* ---------- Data + live updates ---------- */
async function loadState() {
  try {
    const s = await (await fetch('/api/state')).json();
    if (typeof updateConn === 'function') updateConn(s);
    // Which version this is doesn't depend on whether WhatsApp is linked.
    if (typeof showVersion === 'function') showVersion(s.version);
    const status = s.status;
    if (status === 'ready') {
      els.link.classList.add('hidden');
      const cloud = s.cloudAvailable ? 'videos → pCloud' : 'videos → local (cloud drive offline)';
      const synced = typeof syncLine === 'function' ? syncLine(s) : '';
      els.sub.innerHTML = `<span class="dot ok"></span>Linked${s.me ? ' as ' + escapeHtml(s.me) : ''} · ${s.counts.images} images · ${s.counts.videos} videos · ${cloud}${synced}`;
    } else if (status === 'qr') {
      els.link.classList.remove('hidden');
      els.linkTitle.textContent = 'Link your WhatsApp';
      els.qrwrap.innerHTML = s.qr ? `<img src="${s.qr}" alt="QR code" />` : '<div class="spinner"></div>';
      els.sub.innerHTML = `<span class="dot warn"></span>Waiting for you to scan the QR code`;
    } else if (status === 'authenticated' || status === 'starting') {
      els.sub.innerHTML = `<span class="dot warn"></span>Connecting…`;
      if (status === 'authenticated') els.link.classList.add('hidden');
    } else if (s.needsRelink) {
      els.sub.innerHTML = `<span class="dot bad"></span>Device unlinked — open ⚙︎ Settings → Restart app, then re-scan the QR`;
    } else {
      els.sub.innerHTML = `<span class="dot bad"></span>${escapeHtml(status)}${s.lastError ? ' — ' + escapeHtml(s.lastError) : ''}`;
    }
  } catch (e) {
    els.sub.innerHTML = `<span class="dot bad"></span>Dashboard offline`;
  }
}

async function loadItems(initial) {
  try {
    const url = initial ? '/api/list' : '/api/list?since=' + newestTs;
    const rows = await (await fetch(url)).json();
    if (initial) {
      allItems = rows;
      if (allItems.length) newestTs = allItems[0].ts;
      render(allItems);
      return;
    }
    if (!rows.length) return;
    const ids = new Set(allItems.map((r) => r.id));
    const fresh = rows.filter((r) => !ids.has(r.id));
    if (!fresh.length) return;
    allItems = fresh.concat(allItems);
    newestTs = allItems[0].ts;
    prependNew(fresh);
  } catch (e) { /* transient */ }
}
/* ---------- Desktop bridge (absent when opened in a plain browser) ---------- */
const bridge = window.desktop && window.desktop.available ? window.desktop : null;
let appInfo = null;

/* ---------- Settings ---------- */
const $ = (id) => document.getElementById(id);

// Every simple setting is <input id="set-<key>">; the type says how to read it.
const FIELDS = {
  captureImages: 'bool', captureVideos: 'bool', captureVoice: 'bool', captureAudio: 'bool',
  captureDocuments: 'bool', captureStickers: 'bool',
  captureSent: 'bool', captureReceived: 'bool', captureGroups: 'bool', captureConversations: 'bool',
  mirrorImages: 'bool', startWithWindows: 'bool', startMinimized: 'bool', closeToTray: 'bool',
  notifyOnProblem: 'bool', autoUpdate: 'bool',
  mediaRoot: 'text', cloudRoot: 'text', excludedChats: 'lines',
  retentionDays: 'int', port: 'int', downloadTimeoutSec: 'int', logMaxMB: 'int',
  autoImportHours: 'int',
  aiEnabled: 'bool', aiConsent: 'bool', aiAnalyseImages: 'bool', aiAnalyseChats: 'bool', aiChainEnabled: 'bool',
  aiProvider: 'text', aiModel: 'text', aiBaseUrl: 'text', aiMode: 'text', aiMonthlyBudget: 'int',
};

const S = {
  open: $('open-settings'), modal: $('settings'), close: $('settings-close'),
  tabs: $('settabs'),
  conn: $('conn-status'), health: $('health-status'),
  limit: $('backfill-limit'), btnBackfill: $('btn-backfill'),
  backfillStatus: $('backfill-status'), progress: $('backfill-progress'), bar: $('backfill-bar'),
  pathStatus: $('path-status'), paths: $('paths'), storage: $('storage-table'),
  btnExport: $('btn-export'), exportStatus: $('export-status'),
  restartNote: $('restart-note'), version: $('version-line'),
  save: $('settings-save'), saveStatus: $('save-status'),
};

function readField(key, type) {
  const el = $('set-' + key);
  if (!el) return undefined;
  if (type === 'bool') return el.checked;
  if (type === 'int') { const n = parseInt(el.value, 10); return Number.isFinite(n) ? n : undefined; }
  if (type === 'lines') return el.value.split('\n').map((x) => x.trim()).filter(Boolean);
  return el.value.trim();
}
function writeField(key, type, value) {
  const el = $('set-' + key);
  if (!el) return;
  if (type === 'bool') el.checked = !!value;
  else if (type === 'lines') el.value = (value || []).join('\n');
  else el.value = value === undefined || value === null ? '' : value;
}

function openSettings() { S.modal.classList.remove('hidden'); loadSettings(); }
function closeSettings() { S.modal.classList.add('hidden'); }
S.open.addEventListener('click', openSettings);
S.close.addEventListener('click', closeSettings);
S.modal.addEventListener('click', (e) => { if (e.target === S.modal) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !S.modal.classList.contains('hidden')) closeSettings(); });

S.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...S.tabs.children].forEach((c) => c.classList.toggle('active', c === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.t));
  if (b.dataset.t === 'storage') loadStorage();
  if (b.dataset.t === 'ai') { AI.loadSettingsTab(); if (typeof Chain !== 'undefined') Chain.refresh(); }
});

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
};

async function loadSettings() {
  try {
    const d = await (await fetch('/api/settings')).json();
    for (const [key, type] of Object.entries(FIELDS)) writeField(key, type, d.settings[key]);
    S.limit.value = d.settings.backfillLimit;

    S.pathStatus.innerHTML = !d.cloudConfigured
      ? '<span class="muted">No cloud folder set — everything stays on this PC.</span>'
      : d.cloudAvailable
        ? `<span class="ok-text">● Connected — videos saving to ${escapeHtml(d.paths.videos)}</span>`
        : `<span class="bad-text">● Folder not reachable — videos saving locally to ${escapeHtml(d.paths.videos)}</span>`;

    const p = d.paths;
    S.paths.innerHTML = [
      ['App data folder', p.home], ['Images', p.images], ['Videos', p.videos], ['Files', p.files],
      ['Message database', p.data], ['Settings file', p.settingsFile], ['Log file', p.log],
      ['WhatsApp link', p.auth], ['Dashboard address', 'http://localhost:' + d.port],
    ].map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${escapeHtml(v)}</td></tr>`).join('');

    if (bridge && !appInfo) appInfo = await bridge.info();
    if (appInfo) {
      S.version.textContent = `Version ${appInfo.version}${appInfo.packaged ? '' : ' (running from source)'}`;
      writeField('startWithWindows', 'bool', appInfo.startWithWindows);
    } else {
      S.version.textContent = 'Running in a browser — bridge features are in the app window.';
    }
  } catch (e) { S.saveStatus.textContent = 'Could not load settings'; }
}

async function loadStorage() {
  S.storage.innerHTML = '<tr><td class="k">Measuring…</td><td class="v"></td></tr>';
  try {
    const s = await (await fetch('/api/storage')).json();
    S.storage.innerHTML = [
      ['Images', `${fmtBytes(s.images.bytes)} · ${s.images.files} files`],
      ['Videos', `${fmtBytes(s.videos.bytes)} · ${s.videos.files} files${s.videos.cloud ? ' (cloud folder)' : ''}`],
      ['Voice, audio, documents', `${fmtBytes(s.files.bytes)} · ${s.files.files} files`],
      ['Messages & index', fmtBytes(s.data.bytes)],
      ['Total', fmtBytes(s.total)],
    ].map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${escapeHtml(v)}</td></tr>`).join('');
  } catch (e) { S.storage.innerHTML = '<tr><td class="k">Could not measure</td><td class="v"></td></tr>'; }
}

S.save.addEventListener('click', async () => {
  S.saveStatus.textContent = 'Saving…';
  const body = { backfillLimit: parseInt(S.limit.value, 10) || 400 };
  for (const [key, type] of Object.entries(FIELDS)) {
    const v = readField(key, type);
    if (v !== undefined) body[key] = v;
  }
  try {
    if (bridge) await bridge.setStartup(body.startWithWindows);
    const r = await (await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    S.saveStatus.innerHTML = '<span class="ok-text">Saved ✓</span>';
    S.restartNote.textContent = r.restartRequired
      ? 'Some changes (folders, port, timeouts) apply after a restart — use “Restart capture” on the App tab.'
      : '';
    setTimeout(() => { S.saveStatus.textContent = ''; }, 2500);
  } catch (e) { S.saveStatus.textContent = 'Save failed'; }
});

/* ---------- Folder pickers ---------- */
async function pickInto(inputId, title) {
  const el = $(inputId);
  if (!bridge) { el.focus(); return; }
  const dir = await bridge.pickFolder({ title, defaultPath: el.value || undefined });
  if (dir) el.value = dir;
}
$('btn-browse-media').addEventListener('click', () => pickInto('set-mediaRoot', 'Where should media be saved?'));
$('btn-browse-cloud').addEventListener('click', () => pickInto('set-cloudRoot', 'Choose your cloud folder'));
$('btn-open-media').addEventListener('click', async () => {
  const target = $('set-mediaRoot').value.trim() || (appInfo && appInfo.paths.images);
  if (bridge && target) bridge.openPath(target);
});
$('btn-checkpath').addEventListener('click', async () => {
  const value = $('set-cloudRoot').value.trim();
  if (!value) { S.pathStatus.innerHTML = '<span class="muted">No cloud folder set.</span>'; return; }
  S.pathStatus.textContent = 'Checking…';
  try {
    const r = await (await fetch('/api/check-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: value }) })).json();
    S.pathStatus.innerHTML = `<span class="${r.writable ? 'ok-text' : 'bad-text'}">${escapeHtml(r.message)}</span>`;
  } catch (e) { S.pathStatus.textContent = 'Check failed'; }
});

/* ---------- Connection actions ---------- */
$('btn-reconnect').addEventListener('click', async () => {
  S.conn.textContent = 'Reconnecting…';
  try { await fetch('/api/reconnect', { method: 'POST' }); } catch (e) {}
});
$('btn-unlink').addEventListener('click', async () => {
  if (!confirm('Unlink this PC from WhatsApp?\n\nYour saved photos, videos and messages stay exactly where they are. You will need to scan a QR code again to keep capturing.')) return;
  S.conn.textContent = 'Unlinking…';
  try { await fetch('/api/unlink', { method: 'POST' }); } catch (e) {}
});

/* ---------- App actions ---------- */
$('btn-check-updates').addEventListener('click', () => {
  if (bridge) bridge.checkUpdates();
  else alert('Updates are handled by the bridge app.');
});
$('btn-open-logs').addEventListener('click', async () => {
  if (!bridge) return;
  const info = appInfo || (appInfo = await bridge.info());
  bridge.openPath(info.paths.logs);
});
$('btn-copy-diag').addEventListener('click', async () => {
  if (bridge) { await bridge.copyDiagnostics(); S.restartNote.textContent = 'Diagnostic report copied to the clipboard — paste it into an email.'; }
});
$('btn-restart').addEventListener('click', async () => {
  if (!confirm('Restart the capture engine? It reconnects using your saved link (no re-scan).')) return;
  S.restartNote.textContent = 'Restarting… the dashboard reconnects in a few seconds.';
  if (bridge) bridge.restart();
  else { try { await fetch('/api/restart', { method: 'POST' }); } catch (e) {} }
});
$('btn-remove-samples').addEventListener('click', async () => {
  try {
    const r = await (await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: false }) })).json();
    S.saveStatus.innerHTML = `<span class="ok-text">Removed ${r.removed} sample(s)</span>`;
    loadItems(true);
    setTimeout(() => { S.saveStatus.textContent = ''; }, 2500);
  } catch (e) {}
});

/* ---------- History import ---------- */
let backfillPoll = null;
S.btnBackfill.addEventListener('click', async () => {
  S.btnBackfill.disabled = true;
  S.backfillStatus.textContent = 'Starting…';
  try {
    const r = await (await fetch('/api/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: parseInt(S.limit.value, 10) || undefined }) })).json();
    if (!r.ok) { S.backfillStatus.textContent = r.message || 'Could not start'; S.btnBackfill.disabled = false; return; }
    S.progress.classList.remove('hidden');
    watchBackfill();
  } catch (e) { S.backfillStatus.textContent = 'Failed to start'; S.btnBackfill.disabled = false; }
});

function watchBackfill() {
  if (backfillPoll) clearInterval(backfillPoll);
  backfillPoll = setInterval(async () => {
    try {
      const s = await (await fetch('/api/state')).json();
      const bf = s.backfill || {};
      const pct = bf.totalChats ? Math.round((bf.doneChats / bf.totalChats) * 100) : 0;
      S.bar.style.width = pct + '%';
      if (bf.running) {
        S.backfillStatus.textContent = `Scanning chats ${bf.doneChats}/${bf.totalChats} · ${bf.saved} new items found`;
      } else {
        clearInterval(backfillPoll); backfillPoll = null;
        S.bar.style.width = '100%';
        if (bf.error) S.backfillStatus.innerHTML = `<span class="bad-text">${escapeHtml(bf.error)}</span>`;
        else if (!bf.finishedAt) S.backfillStatus.innerHTML = '<span class="bad-text">Import was interrupted. Click “Import history now” to continue.</span>';
        else S.backfillStatus.innerHTML = `<span class="ok-text">Done — imported ${bf.saved} item(s) from ${bf.totalChats} chats${bf.skipped ? `, ${bf.skipped} skipped (mostly media WhatsApp no longer stores)` : ''}.</span>`;
        S.btnBackfill.disabled = false;
        loadItems(true);
      }
    } catch (e) { /* keep polling */ }
  }, 1500);
}

/* ---------- Export transcript ---------- */
S.btnExport.addEventListener('click', async () => {
  S.btnExport.disabled = true; S.exportStatus.textContent = 'Exporting…';
  try {
    const r = await (await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    S.exportStatus.innerHTML = r.ok
      ? `<span class="ok-text">Saved ${r.messages} messages from ${r.chats} chats →</span> <span class="small">${escapeHtml(r.dir)}</span>`
      : `<span class="bad-text">${escapeHtml(r.error || 'failed')}</span>`;
    if (r.ok && bridge) bridge.openPath(r.dir);
  } catch (e) { S.exportStatus.textContent = 'Export failed'; }
  S.btnExport.disabled = false;
});

/* ---------- Connection + health summary ---------- */
const healthBanner = $('health-banner');
let healthDismissed = false;
$('health-dismiss').addEventListener('click', () => { healthDismissed = true; healthBanner.classList.add('hidden'); });
$('health-update').addEventListener('click', () => { if (bridge) bridge.checkUpdates(); });

function updateConn(s) {
  if (S.conn) {
    if (s.status === 'ready') S.conn.innerHTML = `<span class="ok-text">● Linked${s.me ? ' as ' + escapeHtml(s.me) : ''}</span> · ${s.counts.images} images · ${s.counts.videos} videos saved`;
    else if (s.status === 'qr') S.conn.innerHTML = '<span class="bad-text">● Not linked</span> — scan the QR code on the main screen';
    else if (s.needsRelink) S.conn.innerHTML = '<span class="bad-text">● Unlinked from your phone</span> — scan the QR code again';
    else S.conn.textContent = s.status;
  }
  const h = s.health;
  if (S.health && h) {
    S.health.innerHTML = h.ok
      ? `Downloads working${h.lastCaptureAt ? ' · last saved ' + new Date(h.lastCaptureAt).toLocaleString() : ''}`
      : `<span class="bad-text">${h.consecutiveFailures} downloads failed in a row${h.lastError ? ' — ' + escapeHtml(h.lastError) : ''}</span>`;
  }
  if (h && !h.ok && !healthDismissed) {
    $('health-text').textContent = `Capture may be broken — ${h.consecutiveFailures} downloads failed in a row. WhatsApp may have changed something.`;
    healthBanner.classList.remove('hidden');
  } else if (h && h.ok) {
    healthBanner.classList.add('hidden');
  }
}

/* ---------- First run ---------- */
const WZ = {
  root: $('wizard'),
  history: [],
  current: null,
  step: (name) => document.querySelector(`.wz-step[data-step="${name}"]`),
  // The flow branches — an old install inserts an import step — so Back follows
  // the steps actually visited rather than a fixed running order.
  show(name, { push = true } = {}) {
    if (push && WZ.current && WZ.current !== name) WZ.history.push(WZ.current);
    WZ.current = name;
    document.querySelectorAll('.wz-step').forEach((s) => s.classList.toggle('hidden', s.dataset.step !== name));
    // Nothing to go back to on the first step, so the control stays out of the way.
    document.querySelectorAll('.wz-back').forEach((b) => b.classList.toggle('hidden', WZ.history.length === 0));
    WZ.root.classList.remove('hidden');
  },
  back() {
    if (!WZ.history.length) return;
    WZ.show(WZ.history.pop(), { push: false });
  },
  done() { WZ.root.classList.add('hidden'); },
};

// One delegated handler covers every step's Back button.
if (WZ.root) WZ.root.addEventListener('click', (e) => { if (e.target.closest('.wz-back')) WZ.back(); });

async function maybeRunWizard() {
  let d;
  try { d = await (await fetch('/api/settings')).json(); } catch (e) { return; }
  if (d.settings.setupComplete) return;

  if (bridge) appInfo = appInfo || await bridge.info();
  $('wz-default-path').textContent = appInfo ? appInfo.paths.mediaRoot : '';

  WZ.show('welcome');

  $('wz-consent').addEventListener('change', (e) => { $('wz-consent-next').disabled = !e.target.checked; });
  $('wz-consent-next').addEventListener('click', async () => {
    await saveWizard({ consentAccepted: true });
    const old = appInfo && appInfo.oldInstall;
    if (old) {
      $('wz-found').innerHTML = `<b>${escapeHtml(old.path)}</b><br>
        ${old.images} images · ${old.records} gallery entries · ${old.messages} messages
        ${old.hasSession ? '· <span class="ok-text">WhatsApp link found</span>' : ''}`;
      WZ.show('import');
    } else WZ.show('storage');
  });

  $('wz-import-skip').addEventListener('click', () => WZ.show('storage'));
  $('wz-import-go').addEventListener('click', async () => {
    const btn = $('wz-import-go');
    btn.disabled = true;
    const status = $('wz-import-status');
    status.innerHTML = 'Copying… this can take a few minutes for the WhatsApp link.';
    if (bridge.onMigrateProgress) bridge.onMigrateProgress((m) => { status.textContent = `Copying ${m.step}…`; });
    const r = await bridge.migrate(appInfo.oldInstall.path);
    btn.disabled = false;
    status.innerHTML = r.ok ? `<span class="ok-text">${escapeHtml(r.message)}</span>` : `<span class="bad-text">${escapeHtml(r.message)}</span>`;
    if (r.ok) {
      // Imported settings decide storage, so the rest of the wizard is moot.
      setTimeout(() => { WZ.done(); location.reload(); }, 2500);
    }
  });

  document.querySelectorAll('input[name="wz-loc"]').forEach((r) => r.addEventListener('change', () => {
    $('wz-custom-row').style.display = document.querySelector('input[name="wz-loc"]:checked').value === 'custom' ? '' : 'none';
  }));
  $('wz-browse-media').addEventListener('click', async () => {
    if (!bridge) return;
    const dir = await bridge.pickFolder({ title: 'Where should media be saved?' });
    if (dir) $('wz-media-root').value = dir;
  });
  $('wz-storage-next').addEventListener('click', async () => {
    const custom = document.querySelector('input[name="wz-loc"]:checked').value === 'custom';
    const dir = custom ? $('wz-media-root').value.trim() : '';
    if (custom && !dir) { $('wz-media-status').textContent = 'Choose a folder first.'; return; }
    if (custom) {
      const r = await (await fetch('/api/check-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, sub: 'images' }) })).json();
      if (!r.writable) { $('wz-media-status').innerHTML = `<span class="bad-text">${escapeHtml(r.message)}</span>`; return; }
    }
    await saveWizard({ mediaRoot: dir });
    WZ.show('cloud');
  });

  $('wz-browse-cloud').addEventListener('click', async () => {
    if (!bridge) return;
    const dir = await bridge.pickFolder({ title: 'Choose your cloud folder' });
    if (dir) $('wz-cloud-root').value = dir;
  });
  $('wz-cloud-skip').addEventListener('click', async () => { await saveWizard({ cloudRoot: '', mirrorImages: false }); WZ.show('startup'); });
  $('wz-cloud-next').addEventListener('click', async () => {
    const dir = $('wz-cloud-root').value.trim();
    if (dir) {
      const r = await (await fetch('/api/check-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json();
      if (!r.writable) { $('wz-cloud-status').innerHTML = `<span class="bad-text">${escapeHtml(r.message)}</span>`; return; }
    }
    await saveWizard({ cloudRoot: dir, mirrorImages: $('wz-mirror').checked });
    WZ.show('startup');
  });

  $('wz-finish').addEventListener('click', async () => {
    const startup = $('wz-startup').checked;
    if (bridge) await bridge.setStartup(startup);
    await saveWizard({
      startWithWindows: startup,
      captureConversations: $('wz-convos').checked,
      setupComplete: true,
    });
    WZ.done();
    if (bridge) bridge.restart();     // folders only take effect on a fresh start
  });
}

async function saveWizard(patch) {
  try {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  } catch (e) {}
}
/* ---------- Open one media item in the lightbox (from a message bubble) ---------- */
function openSingleMedia(serve, kind) {
  lbId = null;
  els.lightbox.classList.remove('hidden');
  els.lbStage.innerHTML = '';
  // Branch on kind like the gallery lightbox does — a voice note or document is
  // served from /media/files and would render as a broken <img> ("unavailable")
  // even though the file is right there on disk.
  let el;
  if (kind === 'video') { el = document.createElement('video'); el.src = serve; el.controls = true; el.autoplay = true; el.playsInline = true; }
  else if (kind === 'voice' || kind === 'audio') { el = document.createElement('audio'); el.src = serve; el.controls = true; el.autoplay = true; }
  else if (kind === 'image' || kind === 'sticker') { el = document.createElement('img'); el.src = serve; }
  else {
    el = document.createElement('div');
    el.className = 'lb-file';
    el.innerHTML = `<div class="fileicon big">${KIND_ICON[kind] || '📎'}</div>
      <div class="filename">${escapeHtml(decodeURIComponent((serve || '').split('/').pop() || ''))}</div>`;
  }
  el.onerror = () => { els.lbStage.innerHTML = '<div class="lb-unavailable">⚠ Media unavailable.</div>'; };
  els.lbStage.appendChild(el);
  els.lbMeta.innerHTML = `<a href="${serve}" download>⭳ Download</a>`;
  els.lbPrev.style.visibility = 'hidden';
  els.lbNext.style.visibility = 'hidden';
}

/* ---------- View switching (Media / Conversations) ---------- */
const V = {
  media: document.getElementById('view-media'),
  convo: document.getElementById('view-convo'),
  toggle: document.getElementById('viewtoggle'),
};
let currentView = 'media';
V.toggle.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
function setView(v) {
  currentView = v;
  [...V.toggle.children].forEach((c) => c.classList.toggle('active', c.dataset.v === v));
  V.media.classList.toggle('hidden', v !== 'media');
  V.convo.classList.toggle('hidden', v !== 'convo');
  const statusEl = document.getElementById('view-status');
  if (statusEl) statusEl.classList.toggle('hidden', v !== 'status');
  document.body.classList.toggle('convo-active', v === 'convo');
  document.body.classList.toggle('status-active', v === 'status');
  els.search.classList.toggle('hidden', v !== 'media');
  if (v === 'convo') Convo.enter();
  if (v === 'status' && typeof StatusView !== 'undefined') StatusView.enter();
}

/* ---------- Conversations ---------- */
const Convo = (function () {
  const chatsEl = document.getElementById('chats');
  const searchEl = document.getElementById('convo-search');
  const headEl = document.getElementById('thread-head');
  const bodyEl = document.getElementById('thread-body');
  let activeChat = null;
  let oldestTs = null;
  let oldestId = null;      // (ts, id) cursor — ts alone loses rows cut mid-second by LIMIT
  let newestTs = 0;
  let canLoadOlder = false;
  let loading = false;
  const seenIds = new Set();  // the live poll asks ts >= newest, so dedupe by id
  let entered = false;
  let searchMode = false;

  const fmtT = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const TYPE_LABEL = { ptt: '🎤 voice message', audio: '🎵 audio', document: '📄 document', sticker: '🌟 sticker', location: '📍 location', vcard: '👤 contact', multi_vcard: '👤 contacts', call_log: '📞 call' };
  const prettyType = (t) => TYPE_LABEL[t] || `[${escapeHtml(t)}]`;
  function shortDay(ms) {
    const d = new Date(ms), n = new Date();
    if (d.toDateString() === n.toDateString()) return fmtT(ms);
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  async function enter() { if (!entered) { entered = true; await loadChats(); } else if (!searchMode) loadChats(); }
  async function loadChats() {
    try { renderChats(await (await fetch('/api/chats')).json()); } catch (e) {}
  }
  function refreshChats() { if (!searchMode) loadChats(); }

  function renderChats(chats) {
    if (!chats.length) { chatsEl.innerHTML = '<div class="convo-empty" style="padding:24px">No conversations stored yet. Turn on “Capture message text” in ⚙︎ Settings, then Import history.</div>'; return; }
    chatsEl.innerHTML = '';
    // Once the AI has grouped them, the list is ordered by project rather than
    // by recency alone — chats without a project fall to the bottom.
    const projectOf = (id) => (typeof AI !== 'undefined' && AI.chatLabelFor(id)) || null;
    const grouped = chats.some((c) => projectOf(c.chatId) && projectOf(c.chatId).groupName);
    if (grouped) {
      chats = chats.slice().sort((a, b) => {
        const pa = projectOf(a.chatId), pb = projectOf(b.chatId);
        const na = (pa && pa.groupName) || '￿', nb = (pb && pb.groupName) || '￿';
        return na === nb ? (b.lastTs || 0) - (a.lastTs || 0) : na.localeCompare(nb);
      });
    }
    let lastProject = null;
    for (const c of chats) {
      if (grouped) {
        const p = projectOf(c.chatId);
        const name = (p && p.groupName) || 'Not in a project';
        if (name !== lastProject) {
          lastProject = name;
          const h = document.createElement('div');
          h.className = 'projecthead';
          h.textContent = ((p && p.groupEmoji) ? p.groupEmoji + ' ' : '') + name;
          chatsEl.appendChild(h);
        }
      }
      const el = document.createElement('div');
      el.className = 'chatitem' + (activeChat && activeChat.chatId === c.chatId ? ' active' : '');
      el.dataset.chat = c.chatId;
      const last = (c.lastType && c.lastType !== 'chat' && !c.lastBody) ? '[' + c.lastType + ']' : (c.lastBody || '');
      el.innerHTML = `<div class="ci-top"><span class="ci-name">${escapeHtml(c.chatName || c.chatId)}</span><span class="ci-time">${c.lastTs ? shortDay(c.lastTs) : ''}</span></div>
        <div class="ci-last">${c.lastFromMe ? 'You: ' : ''}${escapeHtml(last).slice(0, 90)}</div>`;
      el.addEventListener('click', () => openChat(c));
      chatsEl.appendChild(el);
    }
  }

  async function fetchThread(chatId, before, beforeId) {
    const url = '/api/thread?chat=' + encodeURIComponent(chatId)
      + (before ? '&before=' + before + '&beforeId=' + encodeURIComponent(beforeId || '') : '') + '&limit=200';
    try { return await (await fetch(url)).json(); } catch (e) { return []; }
  }

  async function openChat(c) {
    activeChat = { chatId: c.chatId, chatName: c.chatName || c.chatId };
    [...chatsEl.children].forEach((x) => x.classList.toggle('active', x.dataset.chat === c.chatId));
    headEl.innerHTML = `<span class="th-name">${escapeHtml(activeChat.chatName)}</span>`;
    bodyEl.innerHTML = '<div class="convo-empty">Loading…</div>';
    oldestTs = null; oldestId = null; newestTs = 0; seenIds.clear();
    const rows = await fetchThread(activeChat.chatId, null);
    bodyEl.innerHTML = '';
    if (!rows.length) { bodyEl.innerHTML = '<div class="convo-empty">No messages stored for this chat.</div>'; return; }
    oldestTs = rows[0].ts; oldestId = rows[0].id; newestTs = rows[rows.length - 1].ts;
    for (const r of rows) seenIds.add(r.id);
    canLoadOlder = rows.length >= 200;
    bodyEl.appendChild(buildBubbles(rows));
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  async function loadOlder() {
    if (loading || !activeChat || !canLoadOlder) return;
    loading = true;
    const rows = await fetchThread(activeChat.chatId, oldestTs, oldestId);
    loading = false;
    if (!rows.length) { canLoadOlder = false; return; }
    canLoadOlder = rows.length >= 200;
    const prevH = bodyEl.scrollHeight, prevTop = bodyEl.scrollTop;
    oldestTs = rows[0].ts; oldestId = rows[0].id;
    for (const r of rows) seenIds.add(r.id);
    bodyEl.insertBefore(buildBubbles(rows), bodyEl.firstChild);
    bodyEl.scrollTop = prevTop + (bodyEl.scrollHeight - prevH);
  }

  function buildBubbles(rows) {
    const frag = document.createDocumentFragment();
    let lastDay = null;
    for (const m of rows) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { const s = document.createElement('div'); s.className = 'day-sep'; s.textContent = day; frag.appendChild(s); lastDay = day; }
      const b = document.createElement('div');
      b.className = 'bubble' + (m.fromMe ? ' out' : '');
      let media = '';
      if (m.mediaServe && m.mediaKind === 'image') media = `<div class="b-media"><img loading="lazy" src="${m.mediaServe}" onerror="this.classList.add('imgerr')"></div>`;
      else if (m.mediaServe && m.mediaKind === 'video') media = `<div class="b-mediatag">▶ video</div>`;
      else if (m.mediaKind === 'image' || m.mediaKind === 'video') media = `<div class="b-mediatag">[${m.mediaKind} — not saved]</div>`;
      else if (m.type && m.type !== 'chat') media = `<div class="b-mediatag">${prettyType(m.type)}</div>`;
      const author = (!m.fromMe && m.author && m.author !== 'me') ? `<div class="b-author">${escapeHtml(m.author)}</div>` : '';
      const rawCard = m.type === 'vcard' || m.type === 'multi_vcard';
      const text = (m.body && !rawCard) ? `<div class="b-text">${escapeHtml(m.body)}</div>` : '';
      b.innerHTML = `${author}${media}${text}<div class="b-meta">${fmtT(m.ts)}</div>`;
      if (m.mediaServe) {
        const mt = b.querySelector('.b-media, .b-mediatag');
        if (mt) mt.addEventListener('click', () => openSingleMedia(m.mediaServe, m.mediaKind));
      }
      frag.appendChild(b);
    }
    return frag;
  }

  async function pollActive() {
    if (currentView !== 'convo' || !activeChat || searchMode) return;
    try {
      const got = await (await fetch('/api/thread?chat=' + encodeURIComponent(activeChat.chatId) + '&after=' + newestTs + '&limit=200')).json();
      // The server returns ts >= newest so same-second arrivals aren't lost;
      // rows already rendered come back too and are dropped here by id.
      const rows = got.filter((r) => !seenIds.has(r.id));
      if (rows.length) {
        for (const r of rows) seenIds.add(r.id);
        const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 100;
        bodyEl.appendChild(buildBubbles(rows));
        newestTs = rows[rows.length - 1].ts;
        if (nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
      }
    } catch (e) {}
  }

  let searchT2;
  searchEl.addEventListener('input', () => { clearTimeout(searchT2); searchT2 = setTimeout(runSearch, 220); });
  async function runSearch() {
    const q = searchEl.value.trim();
    if (q.length < 2) { searchMode = false; loadChats(); return; }
    searchMode = true;
    const ql = q.toLowerCase();
    // Two different questions, asked at once: which conversations are about
    // this, and which messages say it. The first is the one the sorting was
    // for, so it is answered first and separately.
    let chats = [], msgs = [];
    if (typeof AI !== 'undefined') { try { await AI.ensureChatGroups(); } catch (e) {} }
    try { chats = await (await fetch('/api/chats')).json(); } catch (e) {}
    try { msgs = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json(); } catch (e) {}
    const about = (typeof AI === 'undefined') ? []
      : chats.filter((c) => AI.matchesChat(c.chatId, ql));
    renderSearch(msgs, q, about);
  }
  // Two answers, kept apart on purpose. What a conversation is about comes
  // from the sorting; what a message says comes from the words. Mixing them
  // would bury the first under the second, and the first is the point.
  function renderSearch(res, q, about) {
    about = about || [];
    if (!res.length && !about.length) {
      chatsEl.innerHTML = '<div class="convo-empty" style="padding:24px">Nothing matches “' + escapeHtml(q) + '”.</div>';
      return;
    }
    chatsEl.innerHTML = '';

    if (about.length) {
      const head = document.createElement('div');
      head.className = 'projecthead';
      head.textContent = 'Conversations about this (' + about.length + ')';
      chatsEl.appendChild(head);
      for (const c of about) {
        const row = (typeof AI !== 'undefined' && AI.chatLabelFor(c.chatId)) || null;
        const l = (row && row.label) || {};
        const topics = (l.topics || []).slice(0, 4).join(' · ');
        const el = document.createElement('div');
        el.className = 'chatitem';
        el.innerHTML = '<div class="ci-top"><span class="ci-name">' + escapeHtml(c.chatName || c.chatId) + '</span>'
          + (row && row.groupName ? '<span class="ci-time">' + escapeHtml(row.groupName) + '</span>' : '')
          + '</div><div class="ci-last">' + escapeHtml(String(l.summary || '').slice(0, 130)) + '</div>'
          + (topics ? '<div class="ci-last" style="opacity:.65">' + escapeHtml(topics) + '</div>' : '');
        el.addEventListener('click', () => { searchEl.value = ''; searchMode = false; openChat({ chatId: c.chatId, chatName: c.chatName }); loadChats(); });
        chatsEl.appendChild(el);
      }
    }

    if (res.length) {
      const head = document.createElement('div');
      head.className = 'projecthead';
      head.textContent = 'Messages that say it (' + res.length + ')';
      chatsEl.appendChild(head);
      for (const m of res) {
        const el = document.createElement('div');
        el.className = 'chatitem';
        el.innerHTML = '<div class="ci-top"><span class="ci-name">' + escapeHtml(m.chatName || m.chatId) + '</span>'
          + '<span class="ci-time">' + shortDay(m.ts) + '</span></div>'
          + '<div class="ci-last">' + escapeHtml((m.body || '').slice(0, 100)) + '</div>';
        el.addEventListener('click', () => { searchEl.value = ''; searchMode = false; openChat({ chatId: m.chatId, chatName: m.chatName }); loadChats(); });
        chatsEl.appendChild(el);
      }
    }
  }

  bodyEl.addEventListener('scroll', () => { if (bodyEl.scrollTop < 60) loadOlder(); });

  return { enter, pollActive, refreshChats };
})();


/* ---------- AI sorting ---------- */
const AI = (function () {
  const state = { labels: new Map(), groups: [], chatGroups: new Map(), status: null, presets: [] };
  let album = 'all';          // 'all' | group id | 'unsorted'
  let pollTimer = null;

  const bar = $('albumbar');
  const $$ = (id) => document.getElementById(id);

  /* --- data --- */
  async function loadLabels() {
    try {
      const rows = await (await fetch('/api/ai/labels?kind=media')).json();
      state.labels = new Map(rows.map((r) => [r.refId, r]));
      const g = await (await fetch('/api/ai/groups?kind=media')).json();
      state.groups = g.groups || [];
    } catch (e) { /* AI not set up */ }
    renderAlbumBar();
    // The menus are built from the labels, so they are rebuilt when the labels
    // change — a run that invents a new album or a new tag offers it straight
    // away, without waiting for the panel to be opened again.
    if (typeof refreshFilterOptions === 'function') refreshFilterOptions();
    // Tiles are built before labels arrive on first load, so redraw once the
    // album each photo belongs to is actually known.
    if (state.labels.size) render(allItems);
  }

  async function loadChatGroups() {
    try {
      const rows = await (await fetch('/api/ai/labels?kind=chat')).json();
      state.chatGroups = new Map(rows.map((r) => [r.refId, r]));
    } catch (e) {}
  }

  /* --- album bar over the gallery --- */
  function renderAlbumBar() {
    if (!state.groups.length) { bar.classList.add('hidden'); return; }
    const unsorted = allItems.filter((r) => !(state.labels.get(r.id) || {}).groupId).length;
    const chip = (id, emoji, name, count) =>
      `<button class="chip${album === id ? ' active' : ''}" data-album="${id}">${emoji ? escapeHtml(emoji) + ' ' : ''}${escapeHtml(name)}<span class="n">${count}</span></button>`;
    bar.innerHTML = chip('all', '', 'All', allItems.length)
      + state.groups.map((g) => chip(g.id, g.emoji, g.name, g.items.length)).join('')
      + (unsorted ? chip('unsorted', '', 'Not sorted', unsorted) : '');
    bar.classList.remove('hidden');
  }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-album]');
    if (!b) return;
    album = b.dataset.album;
    renderAlbumBar();
    render(allItems);
  });

  // Called by matchesFilter so albums and text search compose with the
  // existing kind/direction filters instead of replacing them.
  function passes(r) {
    if (album !== 'all') {
      const g = (state.labels.get(r.id) || {}).groupId || null;
      if (album === 'unsorted' ? g : g !== album) return false;
    }
    return true;
  }

  // Text search should find a photo by what is in it, not just by chat name.
  function matchesText(r, q) {
    const l = (state.labels.get(r.id) || {}).label;
    if (!l) return false;
    return [l.caption, l.scene, l.text_in_image, (l.tags || []).join(' '), (l.subjects || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  // The same idea for a conversation: search what the AI understood it to be
  // about, not the words that happen to appear in it. A chat about a late
  // delivery is findable by "delivery" even when nobody typed the word.
  function matchesChat(chatId, q) {
    const row = state.chatGroups.get(chatId);
    if (!row) return false;
    const l = row.label || {};
    return [l.summary, l.category, (l.topics || []).join(' '), row.groupName]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  // A search typed before the chat labels have arrived would quietly match
  // nothing and look like the sorting had not worked. Wait for them once.
  let chatGroupsOnce = null;
  function ensureChatGroups() {
    if (state.chatGroups.size) return Promise.resolve();
    if (!chatGroupsOnce) chatGroupsOnce = loadChatGroups();
    return chatGroupsOnce;
  }

  // The tags are not a fixed list — the model invents them as it reads, so the
  // only honest source for a tag menu is what is actually on the photos right
  // now. Counted fresh whenever labels load, which is once per run.
  function tagCounts(minUses) {
    const n = new Map();
    for (const row of state.labels.values()) {
      const tags = (row && row.label && row.label.tags) || [];
      const seen = new Set();
      for (const raw of tags) {
        const k = String(raw || '').toLowerCase().trim();
        if (!k || seen.has(k)) continue;      // one photo counts once per tag
        seen.add(k);
        n.set(k, (n.get(k) || 0) + 1);
      }
    }
    const min = minUses || 2;
    return [...n.entries()].filter((e) => e[1] >= min)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map((e) => ({ tag: e[0], count: e[1] }));
  }

  const hasTag = (id, tag) => {
    const row = state.labels.get(id);
    if (!row || !row.label) return false;
    return (row.label.tags || []).some((x) => String(x || '').toLowerCase().trim() === tag);
  };

  const labelFor = (id) => state.labels.get(id) || null;
  const chatLabelFor = (chatId) => state.chatGroups.get(chatId) || null;

  // Media records carry the chat's display name, chat labels are keyed by chat
  // id — so the project filter matches on the name the two have in common.
  const chatGroupIdForName = (chatName) => {
    if (!chatName) return null;
    for (const row of state.chatGroups.values()) {
      if (row && row.chatName === chatName) return row.groupId || null;
    }
    return null;
  };

  // The distinct projects, for the filter menu.
  const chatGroups = () => {
    const seen = new Map();
    for (const row of state.chatGroups.values()) {
      if (row && row.groupId && !seen.has(row.groupId)) {
        seen.set(row.groupId, { id: row.groupId, name: row.groupName || 'Project', emoji: row.groupEmoji || '' });
      }
    }
    return [...seen.values()];
  };

  /* --- settings tab --- */
  async function loadSettingsTab() {
    const [st, pre] = await Promise.all([
      fetch('/api/ai/status').then((r) => r.json()).catch(() => null),
      fetch('/api/ai/presets').then((r) => r.json()).catch(() => ({ presets: [] })),
    ]);
    state.status = st;
    state.presets = pre.presets || [];

    const sel = $$('set-aiProvider');
    if (sel && !sel.options.length) {
      sel.innerHTML = state.presets.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
      sel.addEventListener('change', onProviderChange);
    }
    // The general settings load runs before these options exist, so the saved
    // provider has to be applied here rather than left blank.
    try {
      const d = await (await fetch('/api/settings')).json();
      const s = d.settings || {};
      if (s.aiProvider) sel.value = s.aiProvider;
      if (s.aiModel) $$('set-aiModel').value = s.aiModel;
      if (s.aiBaseUrl) $$('set-aiBaseUrl').value = s.aiBaseUrl;
      if (s.aiMode) $$('set-aiMode').value = s.aiMode;
      $$('set-aiEnabled').checked = !!s.aiEnabled;
      $$('set-aiConsent').checked = !!s.aiConsent;
      $$('set-aiAnalyseImages').checked = s.aiAnalyseImages !== false;
      $$('set-aiAnalyseChats').checked = s.aiAnalyseChats !== false;
      $$('set-aiMonthlyBudget').value = s.aiMonthlyBudget != null ? s.aiMonthlyBudget : 5;
    } catch (e) {}
    onProviderChange();
    showSpend(st);
    refreshEstimate();
    if (bridge) {
      const k = await bridge.hasAiKey();
      $$('ai-key').placeholder = k.stored ? '•••••••• (saved on this PC)' : 'Paste your key';
    }
  }

  // Setting a cap is no use without being able to see what has gone against it.
  // The two figures differ only when a model with no published price was used,
  // and in that case saying so is better than quietly showing a smaller number.
  function showSpend(st) {
    const el = $$('ai-spend');
    if (!el) return;
    if (!st || !st.lastRun) { el.innerHTML = '&nbsp;'; return; }
    const money = (n) => (n < 0.01 && n > 0 ? 'under a cent' : '$' + n.toFixed(2));
    const used = st.budgetUsed || 0, known = st.spendThisMonth || 0;
    let line = `Spent this month: ${money(known)}.`;
    if (used - known > 0.005) {
      line += ` Plus work on a model with no published price, counted as ${money(used - known)} against the limit.`;
    }
    if (st.budget) line += ` Limit ${money(st.budget)}.`;
    el.textContent = line;
  }

  function preset() { return state.presets.find((p) => p.id === $$('set-aiProvider').value) || {}; }

  function onProviderChange() {
    const p = preset();
    $$('ai-key-hint').textContent = p.keyHint || '';
    $$('ai-key-row').style.display = p.keyRequired === false && p.local ? 'none' : '';
    $$('ai-baseurl-row').style.display = p.baseUrl === '' && p.id !== 'custom' ? 'none' : '';
    if (!$$('set-aiBaseUrl').value && p.baseUrl) $$('set-aiBaseUrl').value = p.baseUrl;
    $$('ai-model-list').innerHTML = (p.models || []).map((m) => `<option value="${m}">`).join('');
    if (!$$('set-aiModel').value && p.defaultModel) $$('set-aiModel').value = p.defaultModel;
    // With a model running on this machine nothing actually leaves it, and
    // saying otherwise would be the wrong kind of scary.
    const note = $$('ai-local-note');
    if (note) note.classList.toggle('hidden', !p.local);
  }

  async function refreshEstimate() {
    const el = $$('ai-estimate');
    el.textContent = 'Working out what this would cost…';
    try {
      const e = await (await fetch('/api/ai/estimate')).json();
      const skipped = Object.entries(e.census.images.skipped || {});
      const parts = [];
      if (e.todo.images) parts.push(`${e.todo.images} photos`);
      if (e.todo.videos) parts.push(`${e.todo.videos} videos`);
      if (e.todo.chats) parts.push(`${e.todo.chats} conversations`);
      if (!parts.length) { el.innerHTML = '<span class="ok-text">Everything is already sorted.</span>'; return; }
      const cost = e.costKnown
        ? (e.cost < 0.01 ? 'under a cent' : '≈ $' + e.cost.toFixed(2))
        : 'an unknown amount (this model has no published price)';
      el.innerHTML = `To do: ${parts.join(', ')} — ${cost} with ${escapeHtml(e.model)}.`
        + (skipped.length ? `<br><span class="muted">Skipping ${skipped.map(([k, v]) => `${v} ${k}`).join(', ')} — no charge for those.</span>` : '');
    } catch (err) { el.textContent = 'Could not work out an estimate.'; }
  }

  /* --- probes --- */
  async function test() {
    const btn = $$('btn-ai-test');
    btn.disabled = true;
    $$('ai-test-status').textContent = 'Asking the service three questions…';
    $$('ai-probe').classList.add('hidden');
    try {
      await saveAiSettings();
      const r = await (await fetch('/api/ai/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      const line = (label, s) => s ? `<div class="probe-line ${s.ok ? 'ok' : 'bad'}"><b>${s.ok ? '✓' : '✕'} ${label}</b><span>${escapeHtml(s.detail || '')}</span></div>` : '';
      $$('ai-probe').innerHTML = line('Connected', r.reachable) + line('Structured replies', r.json) + line('Can see images', r.vision);
      $$('ai-probe').classList.remove('hidden');
      $$('ai-test-status').innerHTML = r.reachable && r.reachable.ok
        ? '<span class="ok-text">Ready.</span>' : '<span class="bad-text">Not usable yet.</span>';
      // Remember what the probe found so calls are shaped to what this model honours.
      if (r.json) await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiJsonSchema: !!r.json.ok }) });
    } catch (e) { $$('ai-test-status').textContent = 'Test failed: ' + e.message; }
    btn.disabled = false;
  }

  async function saveAiSettings() {
    const body = {
      aiEnabled: $$('set-aiEnabled').checked,
      aiConsent: $$('set-aiConsent').checked,
      aiProvider: $$('set-aiProvider').value,
      aiModel: $$('set-aiModel').value.trim(),
      aiBaseUrl: $$('set-aiBaseUrl').value.trim(),
      aiMode: $$('set-aiMode').value,
      aiAnalyseImages: $$('set-aiAnalyseImages').checked,
      aiAnalyseChats: $$('set-aiAnalyseChats').checked,
      aiMonthlyBudget: parseInt($$('set-aiMonthlyBudget').value, 10) || 0,
    };
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  /* --- running --- */
  async function run(arrangeOnly) {
    await saveAiSettings();
    const r = await (await fetch('/api/ai/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arrangeOnly }) })).json();
    if (!r.ok) { $$('ai-run-status').innerHTML = `<span class="bad-text">${escapeHtml(r.message)}</span>`; return; }
    $$('ai-progress').classList.remove('hidden');
    watch();
  }

  function watch() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      let s;
      try { s = await (await fetch('/api/ai/status')).json(); } catch (e) { return; }
      state.status = s;
      const total = Math.max(1, s.done + s.failed + s.skipped + s.jobs.queued);
      $$('ai-bar').style.width = Math.round(((s.done + s.failed + s.skipped) / total) * 100) + '%';
      const spend = s.cost ? ` · $${s.cost.toFixed(3)} so far` : '';
      if (s.running) {
        $$('ai-run-status').textContent = s.phase === 'arranging'
          ? 'Working out the groups…'
          : `Looked at ${s.done} of ${total}${s.skipped ? `, skipped ${s.skipped}` : ''}${s.failed ? `, ${s.failed} failed` : ''}${spend}`;
      } else {
        clearInterval(pollTimer); pollTimer = null;
        $$('ai-bar').style.width = '100%';
        $$('ai-run-status').innerHTML = s.error
          ? `<span class="bad-text">${escapeHtml(s.error)}</span>`
          : `<span class="ok-text">Done — ${escapeHtml(s.message || 'sorted')}${spend}</span>`;
        refreshEstimate();
        showSpend(s);
        loadLabels(); loadChatGroups();
        if (currentView === 'convo') Convo.refreshChats();
      }
    }, 1200);
  }

  /* --- wiring --- */
  $$('btn-ai-test').addEventListener('click', test);
  $$('btn-ai-run').addEventListener('click', () => run(false));
  $$('btn-ai-arrange').addEventListener('click', () => run(true));
  $$('btn-ai-cancel').addEventListener('click', () => fetch('/api/ai/cancel', { method: 'POST' }));
  $$('btn-ai-savekey').addEventListener('click', async () => {
    if (!bridge) return;
    const v = $$('ai-key').value.trim();
    if (!v) return;
    // Save it against the provider on screen, so a chain can hold one key each.
    const who = ($$('set-aiProvider') && $$('set-aiProvider').value) || '';
    const r = await bridge.setAiKey(v, who);
    $$('ai-key').value = '';
    $$('ai-key').placeholder = r.ok ? '•••••••• (saved on this PC)' : 'Paste your key';
    $$('ai-test-status').innerHTML = r.ok
      ? `<span class="ok-text">Key saved for ${escapeHtml(who || 'this provider')}, encrypted with your Windows account.</span>`
      : `<span class="bad-text">${escapeHtml(r.message || 'Could not save the key')}</span>`;
    if (typeof Chain !== 'undefined') Chain.refresh();
  });
  $$('btn-ai-clearkey').addEventListener('click', async () => {
    if (!bridge) return;
    await bridge.setAiKey('');
    $$('ai-key').placeholder = 'Paste your key';
    $$('ai-test-status').textContent = 'Key removed from this PC.';
  });
  $$('btn-ai-preview').addEventListener('click', async () => {
    const el = $$('ai-preview');
    el.classList.remove('hidden');
    el.textContent = 'Loading…';
    try {
      const p = await (await fetch('/api/ai/preview')).json();
      el.textContent = [
        p.image ? `— for one photo —\nthe image file ${p.image.file} (${Math.round(p.image.sentBytes / 1024)} KB)\n${p.image.text}` : '',
        p.chat ? `\n\n— for one conversation (“${p.chat.name}”) —\n${p.chat.text}` : '',
        '\n\nNothing else is sent. No file paths, no phone numbers, no other chats.',
      ].join('');
    } catch (e) { el.textContent = 'Could not build the preview.'; }
  });
  $$('btn-ai-wipe').addEventListener('click', async () => {
    if (!confirm('Delete every AI label and album?\n\nYour photos, videos and messages are not touched. You can run the sorting again afterwards.')) return;
    await fetch('/api/ai/wipe', { method: 'POST' });
    state.labels = new Map(); state.groups = []; state.chatGroups = new Map();
    album = 'all'; renderAlbumBar(); render(allItems); refreshEstimate();
  });

  /* --- correcting the AI, from the lightbox --- */
  // A move is not just a change of album — it is recorded and replayed as a
  // house rule the next time the groups are worked out.
  function albumPicker(r) {
    const cur = (state.labels.get(r.id) || {}).groupId || '';
    return `<span class="m-album"><label>Album</label><select id="lb-album">
      <option value="">— not in an album —</option>
      ${state.groups.map((g) => `<option value="${g.id}"${g.id === cur ? ' selected' : ''}>${escapeHtml((g.emoji ? g.emoji + ' ' : '') + g.name)}</option>`).join('')}
    </select></span>`;
  }

  function bindAlbumPicker(r) {
    const sel = document.getElementById('lb-album');
    if (!sel) return;
    sel.addEventListener('change', async () => {
      const kind = r.kind === 'video' ? 'video' : 'image';
      await fetch('/api/ai/group/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, refId: r.id, groupId: sel.value || null }),
      });
      await loadLabels();
      render(allItems);
    });
  }

  return {
    loadLabels, loadChatGroups, ensureChatGroups, loadSettingsTab, refreshEstimate, passes, matchesText, matchesChat,
    labelFor, chatLabelFor, renderAlbumBar, saveAiSettings, albumPicker, bindAlbumPicker, tagCounts, hasTag,
    groups: () => state.groups,
    chatGroups, chatGroupIdForName,
  };
})();

/* ---------- Boot + polling ---------- */
maybeRunWizard();
loadState();
loadItems(true).then(() => { AI.loadLabels(); AI.loadChatGroups(); });
if (typeof bindFilters === 'function') bindFilters();
setInterval(loadState, 3000);
setInterval(() => { if (currentView === 'media') loadItems(false); }, 4000);
setInterval(() => Convo.pollActive(), 4000);
setInterval(() => { if (currentView === 'convo') Convo.refreshChats(); }, 9000);

/* ---------- Quick play ---------------------------------------------------
   A vertical feed of the videos currently on screen. Scroll-snap does the
   paging; only the visible slide and its neighbours ever hold a <video>,
   because these files live on a cloud drive and mounting forty of them at
   once would spin the disk for minutes and hold the memory for as long. */
const Reels = (() => {
  const root = document.getElementById('reels');
  if (!root) return { open() {}, close() {}, isOpen: () => false };
  const track = document.getElementById('reels-track');
  const countEl = document.getElementById('reels-count');
  const hintEl = document.getElementById('reels-hint');
  const muteBtn = document.getElementById('reels-mute');

  let items = [];
  let current = -1;
  let muted = true;          // browsers refuse an unmuted autoplay; the button opts back in

  const slideAt = (i) => track.children[i];
  const videoAt = (i) => { const s = slideAt(i); return s ? s.querySelector('video') : null; };

  function mount(i) {
    const slide = slideAt(i);
    if (!slide || slide.dataset.mounted === '1') return;
    slide.dataset.mounted = '1';
    const r = items[i];
    const v = document.createElement('video');
    v.src = r.serve;
    v.loop = true;
    v.muted = muted;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadeddata', () => {
      const h = slide.querySelector('.reel-holder');
      if (h) h.remove();
    });
    v.addEventListener('error', () => {
      const h = slide.querySelector('.reel-holder');
      if (h) h.innerHTML = '<div class="reel-failed">This video cannot be played.<br>If it lives in your cloud folder, the drive may be offline.</div>';
    });
    slide.insertBefore(v, slide.firstChild);
  }

  function unmount(i) {
    const slide = slideAt(i);
    if (!slide || slide.dataset.mounted !== '1') return;
    const v = slide.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
    slide.dataset.mounted = '';
    slide.classList.remove('is-paused');
    if (!slide.querySelector('.reel-holder')) {
      const h = document.createElement('div');
      h.className = 'reel-holder';
      h.innerHTML = '<div class="reel-spin"></div>';
      slide.insertBefore(h, slide.firstChild);
    }
  }

  function activate(i) {
    if (i === current || i < 0 || i >= items.length) return;
    current = i;
    countEl.textContent = (i + 1) + ' / ' + items.length;
    // Keep a one-slide window either side: the next video is already buffering
    // by the time it is scrolled to, and everything else is released.
    for (let k = 0; k < items.length; k++) {
      if (Math.abs(k - i) <= 1) mount(k); else unmount(k);
    }
    for (let k = 0; k < items.length; k++) {
      const v = videoAt(k);
      if (!v) continue;
      if (k === i) {
        v.muted = muted;
        try { v.currentTime = 0; } catch (_) {}
        // An unmuted autoplay can still be refused; fall back rather than sit silent.
        v.play().catch(() => { v.muted = true; muted = true; syncMute(); v.play().catch(() => {}); });
      } else {
        v.pause();
      }
    }
    if (i > 0) hintEl.classList.add('gone');
  }

  function syncMute() {
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? 'Sound off — click for sound (M)' : 'Sound on (M)';
  }

  function toggleMute() {
    muted = !muted;
    syncMute();
    const v = videoAt(current);
    if (v) { v.muted = muted; if (!muted) v.play().catch(() => {}); }
  }

  function togglePlay() {
    const slide = slideAt(current);
    const v = slide ? slide.querySelector('video') : null;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); slide.classList.remove('is-paused'); }
    else { v.pause(); slide.classList.add('is-paused'); }
  }

  function go(delta) {
    const next = current + delta;
    if (next < 0 || next >= items.length) return;
    track.scrollTop = next * track.clientHeight;
    // Don't wait for the scroll event to report where we landed: scroll events
    // are dispatched with the rendering steps, which a page that isn't drawing
    // skips entirely. Moving deliberately, we already know the destination.
    activate(next);
  }

  function open(list, startIndex) {
    items = list || [];
    if (!items.length) return;
    track.innerHTML = '';
    current = -1;
    muted = true;
    syncMute();
    hintEl.classList.remove('gone');

    for (const r of items) {
      const slide = document.createElement('div');
      slide.className = 'reel';
      const when = new Date(r.ts).toLocaleString();
      const cap = r.caption ? '<div class="reel-cap">' + escapeHtml(r.caption) + '</div>' : '';
      slide.innerHTML = '<div class="reel-holder"><div class="reel-spin"></div></div>'
        + '<div class="reel-paused">⏸</div>'
        + '<div class="reel-meta">'
        + '<div class="reel-chat">' + escapeHtml(r.chat || 'unknown') + '</div>'
        + '<div class="reel-sub">' + (r.dir === 'out' ? 'Sent' : 'Received') + ' · ' + escapeHtml(when) + '</div>'
        + cap
        + '</div>';
      slide.addEventListener('click', (e) => { if (!e.target.closest('.reels-bar')) togglePlay(); });
      track.appendChild(slide);
    }

    root.classList.remove('hidden');

    const start = Math.max(0, Math.min(startIndex || 0, items.length - 1));
    track.scrollTop = start * track.clientHeight;
    activate(start);
  }

  function close() {
    for (let k = 0; k < items.length; k++) unmount(k);
    root.classList.add('hidden');
    track.innerHTML = '';
    items = [];
    current = -1;
  }

  // Whatever moved the scroll - wheel, touch, keyboard, snap settling - the
  // slide on screen is scrollTop / height. Done synchronously and on purpose:
  // requestAnimationFrame is suspended whenever the page isn't drawing (a
  // background tab, a minimised window), and deferring to it there would leave
  // the feed scrolled to a video that never starts. The work is a division and
  // a comparison; activate() returns immediately unless the slide changed.
  track.addEventListener('scroll', () => {
    if (!items.length) return;
    activate(Math.round(track.scrollTop / (track.clientHeight || 1)));
  });

  // One wheel gesture, one video. Left to CSS alone, a normal notch or two of
  // wheel moves a few hundred pixels - less than half a slide - and mandatory
  // snapping pulls it straight back to the video it started on, so the feed
  // feels stuck. Taking the gesture ourselves is what makes it read like the
  // apps this is modelled on. Touch is left alone: a swipe already carries
  // enough momentum, and the native handling has the better feel.
  let wheelLock = false;
  track.addEventListener('wheel', (e) => {
    if (!items.length) return;
    e.preventDefault();
    if (wheelLock || Math.abs(e.deltaY) < 4) return;
    wheelLock = true;
    go(e.deltaY > 0 ? 1 : -1);
    setTimeout(() => { wheelLock = false; }, 420);   // ignore the tail of one flick
  }, { passive: false });

  document.getElementById('reels-close').addEventListener('click', close);
  document.getElementById('reels-back').addEventListener('click', close);
  muteBtn.addEventListener('click', toggleMute);

  document.addEventListener('keydown', (e) => {
    if (root.classList.contains('hidden')) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'j') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'k') { e.preventDefault(); go(-1); }
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'm' || e.key === 'M') toggleMute();
  });

  return { open: open, close: close, isOpen: () => !root.classList.contains('hidden') };
})();

// Plays whatever the current filter is showing, so a search for one chat and
// then Quick play walks that chat's videos and nothing else.
function openQuickPlay(startId) {
  const vids = filteredCache.filter((r) => r.kind === 'video');
  if (!vids.length) {
    alert('No videos to play here.\n\nPick the Videos tab, or clear the filter, and try again.');
    return;
  }
  const at = startId ? vids.findIndex((r) => r.id === startId) : 0;
  Reels.open(vids, at < 0 ? 0 : at);
}

(function bindQuickPlay() {
  const b = document.getElementById('reels-open');
  if (b) b.addEventListener('click', () => openQuickPlay(null));
})();

/* ---------- Filters --------------------------------------------------------
   The tab strip answers "photos or videos"; this answers everything else the
   records actually carry — kind, direction, album, project, a date range, and
   what order to read them in. Kept in one object so matchesFilter has a single
   place to look and the Clear button is one assignment. */

function filtersActive() {
  return !!(F.kind || F.dir || F.album || F.project || F.tag || F.from || F.to) || F.sort !== 'new';
}

// Applied after the tab strip and the search box have had their say.
function matchesAdvanced(r) {
  if (F.kind && r.kind !== F.kind) return false;
  if (F.dir && r.dir !== F.dir) return false;
  if (F.from && r.ts < Date.parse(F.from + 'T00:00:00')) return false;
  if (F.to && r.ts > Date.parse(F.to + 'T23:59:59')) return false;
  if (F.album) {
    const g = (typeof AI !== 'undefined' && AI.labelFor(r.id)) || null;
    if (!g || g.groupId !== F.album) return false;
  }
  if (F.project) {
    // A media item belongs to a project through the chat it arrived in.
    const cg = typeof AI !== 'undefined' ? AI.chatGroupIdForName(r.chat) : null;
    if (cg !== F.project) return false;
  }
  if (F.tag && !(typeof AI !== 'undefined' && AI.hasTag(r.id, F.tag))) return false;
  return true;
}

function sortRecords(list) {
  const by = {
    new: (a, b) => b.ts - a.ts,
    old: (a, b) => a.ts - b.ts,
    big: (a, b) => (b.size || 0) - (a.size || 0),
    small: (a, b) => (a.size || 0) - (b.size || 0),
    chat: (a, b) => String(a.chat || '').localeCompare(String(b.chat || '')) || b.ts - a.ts,
  };
  return list.sort(by[F.sort] || by.new);
}

// Album and project lists come from whatever the AI actually produced, so the
// menus can't offer a grouping that doesn't exist.
function refreshFilterOptions() {
  if (typeof AI === 'undefined') return;
  const albums = AI.groups() || [];
  const projects = AI.chatGroups() || [];
  const fill = (sel, items, anyLabel) => {
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = `<option value="">${anyLabel}</option>`
      + items.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml((g.emoji ? g.emoji + ' ' : '') + g.name)}</option>`).join('');
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  };
  fill(fEl('f-album'), albums, 'Any album');
  fill(fEl('f-project'), projects, 'Any project');

  // The tag menu is rebuilt from the labels themselves, so it always offers
  // exactly the words this library has been described with — and grows on its
  // own as more photos are read. A tag used once is noise in a menu; two is
  // the point at which it groups something.
  const tags = (AI.tagCounts && AI.tagCounts(2)) || [];
  const tagSel = fEl('f-tag');
  if (tagSel) {
    const keepTag = tagSel.value;
    tagSel.innerHTML = '<option value="">Any tag</option>'
      + tags.slice(0, 60).map((x) =>
        '<option value="' + escapeHtml(x.tag) + '">' + escapeHtml(x.tag) + ' (' + x.count + ')</option>').join('');
    if ([...tagSel.options].some((o) => o.value === keepTag)) tagSel.value = keepTag;
    tagSel.disabled = !tags.length;
  }
  const bar = fEl('filterbar');
  // Nothing to filter by yet is worth saying, rather than two empty menus.
  const none = !albums.length && !projects.length;
  const al = fEl('f-album'), pr = fEl('f-project');
  if (al) al.disabled = !albums.length;
  if (pr) pr.disabled = !projects.length;
  if (bar && none) bar.dataset.nogroups = '1'; else if (bar) delete bar.dataset.nogroups;
}

function bindFilters() {
  const open = fEl('filters-open'), bar = fEl('filterbar');
  if (!open || !bar) return;
  open.addEventListener('click', () => {
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) refreshFilterOptions();
  });
  const wire = (id, key) => {
    const el = fEl(id);
    if (!el) return;
    el.addEventListener('change', () => { F[key] = el.value; render(allItems); });
  };
  wire('f-kind', 'kind'); wire('f-dir', 'dir'); wire('f-album', 'album');
  wire('f-project', 'project'); wire('f-tag', 'tag'); wire('f-from', 'from'); wire('f-to', 'to');
  wire('f-sort', 'sort');
  const reset = fEl('f-reset');
  if (reset) reset.addEventListener('click', () => {
    Object.assign(F, { kind: '', dir: '', album: '', project: '', tag: '', from: '', to: '', sort: 'new' });
    for (const id of ['f-kind', 'f-dir', 'f-album', 'f-project', 'f-tag', 'f-from', 'f-to']) { const e = fEl(id); if (e) e.value = ''; }
    const s = fEl('f-sort'); if (s) s.value = 'new';
    render(allItems);
  });
}

// "Showing 12 of 431" only when something is actually narrowing the view —
// otherwise it is noise restating the count already in the header.
function updateFilterCount(shown, total) {
  const el = fEl('f-count');
  if (!el) return;
  el.textContent = filtersActive() && shown !== total ? `showing ${shown} of ${total}` : '';
  const open = fEl('filters-open');
  if (open) open.classList.toggle('on', filtersActive());
}

/* ---------- Last synced ---------- */
function ago(ms) {
  if (!ms) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function syncLine(s) {
  const saved = s.health && s.health.lastCaptureAt ? ago(s.health.lastCaptureAt) : null;
  const imported = s.backfill && s.backfill.lastImportAt ? ago(s.backfill.lastImportAt) : null;
  const el = document.getElementById('last-sync-line');
  if (el) {
    el.textContent = 'Last import: ' + (imported
      ? imported + ' (' + new Date(s.backfill.lastImportAt).toLocaleString() + ')'
      : 'never');
  }
  // Live capture is the one people mean by "is it working right now".
  return saved ? ' · saved ' + saved : '';
}


/* ---------- Version and updates -------------------------------------------
   Updating quietly in the background is right; being unable to find out which
   version you are on, or whether one is waiting, is not. The badge sits beside
   the title and turns green when an update has downloaded. */
let lastSeenVersion = null;

function showVersion(v) {
  const el = document.getElementById('ver-badge');
  if (!el || !v) return;
  lastSeenVersion = v;
  if (!el.dataset.state) el.textContent = 'v' + v;
}

function describeUpdate(u) {
  if (!u) return '';
  if (!u.packaged) return 'Running from source — updates apply to installed copies.';
  if (u.status === 'checking') return 'Checking for updates…';
  if (u.status === 'downloading') return `Downloading ${u.version || 'an update'}… ${u.percent || 0}%`;
  if (u.status === 'ready') return `Version ${u.version} is downloaded and installs when you quit.`;
  if (u.status === 'error') return 'Could not check for updates: ' + (u.error || 'unknown');
  if (u.status === 'current') return `You're on the latest version (${u.current}).`;
  return `Version ${u.current}`;
}

async function refreshUpdateStatus() {
  const line = document.getElementById('version-line');
  const badge = document.getElementById('ver-badge');
  const install = document.getElementById('btn-install-update');
  if (!bridge || !bridge.updateStatus) {
    if (line) line.textContent = lastSeenVersion
      ? `Version ${lastSeenVersion} — open the desktop app for updates.` : '';
    return;
  }
  let u = null;
  try { u = await bridge.updateStatus(); } catch (e) { return; }
  if (line) line.textContent = describeUpdate(u);
  if (install) install.classList.toggle('hidden', u.status !== 'ready');
  if (badge && u.current) {
    // An update waiting is the one thing worth colouring; everything else is
    // just a number people occasionally want to read.
    if (u.status === 'ready') {
      badge.textContent = 'v' + u.current + ' → ' + u.version;
      badge.dataset.state = 'ready';
      badge.classList.add('update');
      badge.title = 'Version ' + u.version + ' is ready — click to install';
    } else {
      badge.textContent = 'v' + u.current;
      delete badge.dataset.state;
      badge.classList.remove('update');
      badge.title = describeUpdate(u);
    }
  }
}

(function bindVersionUi() {
  const badge = document.getElementById('ver-badge');
  if (badge) badge.addEventListener('click', async () => {
    // Ready to install: offer that. Otherwise show where the detail lives.
    if (badge.dataset.state === 'ready' && bridge && bridge.installUpdate) {
      const msg = 'Install the update now?' + String.fromCharCode(10,10) + 'The app closes and reopens. Capture resumes straight after.';
      if (confirm(msg)) {
        await bridge.installUpdate();
      }
      return;
    }
    openSettings();
    const tab = [...document.querySelectorAll('#settabs button')].find((b) => b.dataset.t === 'app');
    if (tab) tab.click();
  });
  const install = document.getElementById('btn-install-update');
  if (install) install.addEventListener('click', async () => {
    if (bridge && bridge.installUpdate) await bridge.installUpdate();
  });
  refreshUpdateStatus();
  setInterval(refreshUpdateStatus, 15000);
})();

/* ---------- Status Studio -------------------------------------------------
   The dashboard for automated statuses. Everything here talks to the engine
   over the same local API as the rest; nothing posts unless consent is on,
   and nothing posts for real while dry-run is on. */
const StatusView = (function () {
  const $$id = (x) => document.getElementById(x);
  const els2 = {
    consent: $$id('st-consent'), consentCheck: $$id('st-consent-check'), consentGo: $$id('st-consent-go'),
    main: $$id('st-main'),
    pillMode: $$id('st-pill-mode'), pillToday: $$id('st-pill-today'), pillNext: $$id('st-pill-next'),
    dryrun: $$id('st-dryrun'), paused: $$id('st-paused'),
    text: $$id('st-text'), templates: $$id('st-templates'),
    postNow: $$id('st-post-now'), queueAdd: $$id('st-queue-add'), composeNote: $$id('st-compose-note'),
    aiPrompt: $$id('st-ai-prompt'), chatAware: $$id('st-chat-aware'), aiWrite: $$id('st-ai-write'), aiNote: $$id('st-ai-note'),
    slots: $$id('st-slots'), folderLine: $$id('st-folder-line'),
    nsKind: $$id('ns-kind'), nsWeekday: $$id('ns-weekday'), nsAt: $$id('ns-at'), nsEvery: $$id('ns-every'),
    nsSource: $$id('ns-source'), nsAlbum: $$id('ns-album'), nsAdd: $$id('ns-add'),
    queue: $$id('st-queue'), queueCount: $$id('st-queue-count'),
    history: $$id('st-history'),
  };
  if (!els2.main) return { enter() {} };

  let template = 'gradient';
  let sum = null;

  const jpost = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  const saveSetting = (patch) => jpost('/api/settings', patch);

  /* ---- header pills ---- */
  function renderSummary() {
    if (!sum) return;
    els2.pillMode.textContent = sum.dryRun ? 'dry run — nothing sends' : 'LIVE';
    els2.pillMode.className = 'pill ' + (sum.dryRun ? 'warn' : 'live');
    els2.pillToday.textContent = `${sum.postsToday} posted today`;
    const nexts = (sum.slots || []).filter((s) => s.enabled && s.next_run_at).map((s) => s.next_run_at).sort();
    els2.pillNext.textContent = nexts.length ? 'next: ' + new Date(nexts[0]).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'no schedule yet';
    els2.dryrun.checked = !!sum.dryRun;
    els2.paused.checked = !!sum.paused;
    els2.folderLine.textContent = 'Drop folder: ' + sum.folder + ' — anything saved there becomes the next folder-post.';
  }

  /* ---- template swatches ---- */
  const TPLS = [['gradient', 'Green'], ['night', 'Night'], ['paper', 'Paper'], ['bold', 'Bold'], ['native', 'Plain text']];
  function renderTemplates() {
    els2.templates.innerHTML = TPLS.map(([id, label]) =>
      `<div class="st-tpl${template === id ? ' sel' : ''}" data-t="${id}" title="${label}">${label}</div>`).join('');
  }
  els2.templates.addEventListener('click', (e) => {
    const el = e.target.closest('.st-tpl');
    if (!el) return;
    template = el.dataset.t;
    renderTemplates();
  });

  /* ---- slots ---- */
  const KINDS = { daily: 'Every day', weekly: 'Weekly', interval: 'Every N hours' };
  const SRC = { queue: 'from the queue', folder: 'from the drop folder', album: 'from an album', ai: 'AI writes it' };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function slotWhen(s) {
    if (s.kind === 'interval') return `every ${s.every_hours || '?'}h`;
    if (s.kind === 'weekly') return `${DAYS[s.weekday ?? 1]} ${s.at}`;
    return `daily ${s.at}`;
  }
  function renderSlots() {
    const slots = (sum && sum.slots) || [];
    els2.slots.innerHTML = slots.length ? '' : '<p class="muted small">No schedule yet — add one below. Until then, only “Post now” posts.</p>';
    for (const s of slots) {
      const row = document.createElement('div');
      row.className = 'st-slot';
      const albumNote = s.source === 'album' && s.config && s.config.albumName ? ` · ${escapeHtml(s.config.albumName)}` : '';
      row.innerHTML = `<label class="row toggle" style="margin:0"><input type="checkbox" ${s.enabled ? 'checked' : ''}><span class="switch"></span></label>
        <span class="when">${slotWhen(s)}</span>
        <span class="src">${SRC[s.source] || s.source}${albumNote}</span>
        <span class="next">${s.enabled && s.next_run_at ? new Date(s.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        <button title="Remove">✕</button>`;
      row.querySelector('input').addEventListener('change', async (e) => {
        await jpost('/api/status/slots', { ...s, enabled: e.target.checked, config: s.config });
        refresh();
      });
      row.querySelector('button').addEventListener('click', async () => {
        await jpost('/api/status/slots/delete', { id: s.id });
        refresh();
      });
      els2.slots.appendChild(row);
    }
  }

  els2.nsKind.addEventListener('change', () => {
    els2.nsWeekday.classList.toggle('hidden', els2.nsKind.value !== 'weekly');
    els2.nsAt.classList.toggle('hidden', els2.nsKind.value === 'interval');
    els2.nsEvery.classList.toggle('hidden', els2.nsKind.value !== 'interval');
  });
  els2.nsSource.addEventListener('change', async () => {
    const isAlbum = els2.nsSource.value === 'album';
    els2.nsAlbum.classList.toggle('hidden', !isAlbum);
    if (isAlbum && typeof AI !== 'undefined') {
      const groups = AI.groups() || [];
      els2.nsAlbum.innerHTML = groups.length
        ? groups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml((g.emoji ? g.emoji + ' ' : '') + g.name)}</option>`).join('')
        : '<option value="">no albums yet — run sorting first</option>';
    }
  });
  els2.nsAdd.addEventListener('click', async () => {
    const kind = els2.nsKind.value;
    const source = els2.nsSource.value;
    const config = {};
    if (source === 'ai') { config.prompt = ''; config.template = template === 'native' ? 'gradient' : template; }
    if (source === 'album') {
      config.albumId = els2.nsAlbum.value;
      const opt = els2.nsAlbum.selectedOptions[0];
      config.albumName = opt ? opt.textContent : '';
      if (!config.albumId) return;
    }
    await jpost('/api/status/slots', {
      kind, at: els2.nsAt.value || '09:00',
      weekday: kind === 'weekly' ? parseInt(els2.nsWeekday.value, 10) : null,
      everyHours: kind === 'interval' ? parseInt(els2.nsEvery.value, 10) || 6 : null,
      source, config,
    });
    refresh();
  });

  /* ---- queue ---- */
  async function renderQueue() {
    const q = await (await fetch('/api/status/queue')).json();
    els2.queueCount.textContent = q.length ? `· ${q.length} waiting` : '';
    els2.queue.innerHTML = q.length ? '' : '<p class="muted small">Empty. “Add to queue” above, or queue any photo from its lightbox.</p>';
    for (const item of q) {
      const row = document.createElement('div');
      row.className = 'st-qitem';
      const what = item.type === 'text'
        ? `“${escapeHtml(item.body.slice(0, 70))}”`
        : `${item.type}: ${escapeHtml(decodeURIComponent(String(item.body).split(/[\\/]/).pop()))}`;
      row.innerHTML = `<span class="what">${what}</span><button title="Remove">✕</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        await jpost('/api/status/queue/delete', { id: item.id });
        renderQueue();
      });
      els2.queue.appendChild(row);
    }
  }

  /* ---- history ---- */
  async function renderHistory() {
    const h = await (await fetch('/api/status/history')).json();
    els2.history.innerHTML = h.length ? '' : '<p class="muted small">Nothing yet. The first post — real or dry-run — lands here.</p>';
    for (const row of h) {
      const el = document.createElement('div');
      el.className = 'st-hitem';
      const tag = row.ok ? (row.dry ? '<span class="tag dry">dry run</span>' : '<span class="tag ok">posted</span>') : '<span class="tag fail">failed</span>';
      const thumb = row.card_file ? `<img loading="lazy" src="/media/status/${encodeURIComponent(row.card_file)}">` : '';
      const line = row.type === 'skip' || row.type === 'error'
        ? escapeHtml(row.error || '')
        : escapeHtml(row.body ? String(row.body).split(/[\\/]/).pop().slice(0, 80) : (row.type || ''));
      el.innerHTML = `${thumb}<div class="what"><div class="l1">${line}</div>
        <div class="when">${new Date(row.at).toLocaleString()} · ${escapeHtml(row.source || '')}</div></div>${tag}`;
      els2.history.appendChild(el);
    }
  }

  /* ---- compose actions ---- */
  els2.postNow.addEventListener('click', async () => {
    const text = els2.text.value.trim();
    if (!text) { els2.composeNote.textContent = 'Write something first.'; return; }
    els2.composeNote.textContent = sum && sum.dryRun ? 'Dry run…' : 'Posting…';
    const r = await jpost('/api/status/test', { direct: { type: 'text', text, template } });
    els2.composeNote.textContent = r.ok ? (r.dry ? 'Dry run recorded — see history.' : 'Posted ✓') : ('Failed: ' + (r.error || ''));
    if (r.ok) els2.text.value = '';
    refresh();
  });
  els2.queueAdd.addEventListener('click', async () => {
    const text = els2.text.value.trim();
    if (!text) { els2.composeNote.textContent = 'Write something first.'; return; }
    const r = await jpost('/api/status/queue', { text, template });
    els2.composeNote.textContent = r.ok ? 'Queued.' : ('Failed: ' + (r.error || ''));
    if (r.ok) els2.text.value = '';
    renderQueue();
  });
  els2.aiWrite.addEventListener('click', async () => {
    const prompt = els2.aiPrompt.value.trim();
    if (!prompt) { els2.aiNote.textContent = 'Give it instructions first.'; return; }
    els2.aiNote.textContent = 'Writing…';
    await saveSetting({ statusAiPrompt: prompt, statusAiChatAware: els2.chatAware.checked });
    const r = await jpost('/api/status/preview', { source: 'ai', config: { prompt, template } });
    if (r.error) { els2.aiNote.textContent = r.error; return; }
    els2.text.value = r.text || '';
    els2.aiNote.textContent = 'Draft ready — edit it, then Post now or queue it.';
  });

  /* ---- toggles ---- */
  els2.dryrun.addEventListener('change', async () => {
    if (!els2.dryrun.checked && !confirm('Go live?\n\nScheduled and manual posts will really be published to your status from now on.')) {
      els2.dryrun.checked = true;
      return;
    }
    await saveSetting({ statusDryRun: els2.dryrun.checked });
    refresh();
  });
  els2.paused.addEventListener('change', async () => {
    await saveSetting({ statusPaused: els2.paused.checked });
    refresh();
  });

  /* ---- consent gate ---- */
  els2.consentCheck.addEventListener('change', () => { els2.consentGo.disabled = !els2.consentCheck.checked; });
  els2.consentGo.addEventListener('click', async () => {
    await saveSetting({ statusConsent: true, statusEnabled: true });
    enter();
  });

  /* ---- entry ---- */
  async function refresh() {
    try { sum = await (await fetch('/api/status/summary')).json(); } catch (e) { return; }
    renderSummary(); renderSlots(); renderQueue(); renderHistory();
  }
  async function enter() {
    let consent = false;
    try { consent = (await (await fetch('/api/status/summary')).json()).consent; } catch (e) {}
    els2.consent.classList.toggle('hidden', consent);
    els2.main.classList.toggle('hidden', !consent);
    if (consent) {
      const s2 = await (await fetch('/api/settings')).json();
      els2.aiPrompt.value = s2.settings.statusAiPrompt || '';
      els2.chatAware.checked = !!s2.settings.statusAiChatAware;
      renderTemplates();
      refresh();
    }
  }

  setInterval(() => { if (currentView === 'status' && sum) refresh(); }, 30000);
  return { enter, refresh };
})();


/* ---------- The provider chain ---------------------------------------------
   Free tiers run out; a chain means the sorting steps to the next provider
   instead of stopping. Rendered from the engine's own view, so what is shown
   is what the runner will actually do. */
const Chain = (function () {
  const list = document.getElementById('ai-chain-list');
  const pick = document.getElementById('ai-chain-pick');
  const add = document.getElementById('btn-chain-add');
  if (!list) return { refresh() {} };

  let presets = [];

  async function refresh() {
    let st = null;
    try { st = await (await fetch('/api/ai/status')).json(); } catch (e) { return; }
    if (!presets.length) {
      try { presets = (await (await fetch('/api/ai/presets')).json()).presets || []; } catch (e) {}
    }
    const chain = st.chain || [];
    const box = document.getElementById('set-aiChainEnabled');
    if (box) box.checked = !!st.chainEnabled;

    list.innerHTML = chain.length ? '' : '<p class="muted small">Only the provider above. Add another to keep going when it runs out.</p>';
    chain.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'chain-row';
      let tag = '<span class="st ready">ready</span>';
      if (c.keyRequired && !c.hasKey) tag = '<span class="st nokey">needs a key</span>';
      else if (c.needsModel) tag = '<span class="st nokey">needs a model</span>';
      else if (c.restingUntil) {
        const mins = Math.max(1, Math.round((c.restingUntil - Date.now()) / 60000));
        tag = `<span class="st resting">resting ${mins}m</span>`;
      } else if (c.blind) tag = '<span class="st blind">text only</span>';
      const first = i === 0;
      const modelCell = c.editableModel
        ? `<input class="mdl chain-model" value="${escapeHtml(c.model || '')}" placeholder="model name for this provider" spellcheck="false">`
        : `<span class="mdl">${escapeHtml(c.model || '')}</span>`;
      row.innerHTML = `<span class="ord">${i + 1}</span>
        <span class="who">${escapeHtml(c.provider || '—')}</span>
        ${modelCell}
        ${tag}
        <button title="${first ? 'The provider above — change it there' : 'Remove from the chain'}" ${first ? 'disabled style="opacity:.3;cursor:default"' : ''}>✕</button>`;
      const mi = row.querySelector('.chain-model');
      if (mi) mi.addEventListener('change', async () => {
        const s = await (await fetch('/api/settings')).json();
        const models = { ...(s.settings.aiChainModels || {}) };
        models[c.provider] = mi.value.trim();
        await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiChainModels: models }) });
        refresh();
      });
      if (!first) row.querySelector('button').addEventListener('click', async () => {
        const s = await (await fetch('/api/settings')).json();
        const next = (s.settings.aiChain || []).filter((x) => x !== c.provider);
        await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiChain: next }) });
        refresh();
      });
      list.appendChild(row);
    });

    // Offer only providers that aren't already in the chain.
    const inChain = new Set(chain.map((c) => c.provider));
    const offer = presets.filter((p) => !inChain.has(p.id) && p.id !== 'demo');
    pick.innerHTML = offer.length
      ? offer.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label || p.id)}</option>`).join('')
      : '<option value="">every provider is already in the chain</option>';
  }

  if (add) add.addEventListener('click', async () => {
    const who = pick.value;
    if (!who) return;
    const s = await (await fetch('/api/settings')).json();
    const next = [...(s.settings.aiChain || [])];
    if (!next.includes(who)) next.push(who);
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiChain: next, aiChainEnabled: true }) });
    refresh();
  });

  const box = document.getElementById('set-aiChainEnabled');
  if (box) box.addEventListener('change', async () => {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiChainEnabled: box.checked }) });
    refresh();
  });

  return { refresh };
})();
