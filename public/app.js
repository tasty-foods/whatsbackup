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
    el.innerHTML = `<div class="videotile"><div class="play">▶</div></div>${badge}${cap}`;
  } else {
    const name = r.docName || decodeURIComponent((r.serve || '').split('/').pop() || '');
    el.innerHTML = `<div class="filetile"><div class="fileicon">${KIND_ICON[r.kind] || '📎'}</div>
        <div class="filename">${escapeHtml(name)}</div>
        <div class="filekind">${escapeHtml(KIND_LABEL[r.kind] || r.kind)}</div></div>${badge}${cap}`;
  }
  el.addEventListener('click', () => openLightbox(r));
  return el;
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
    <a href="${r.serve}" download>⭳ Download</a>`;
  if (typeof AI !== 'undefined') AI.bindAlbumPicker(r);
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
    const status = s.status;
    if (status === 'ready') {
      els.link.classList.add('hidden');
      const cloud = s.cloudAvailable ? 'videos → pCloud' : 'videos → local (cloud drive offline)';
      els.sub.innerHTML = `<span class="dot ok"></span>Linked${s.me ? ' as ' + escapeHtml(s.me) : ''} · ${s.counts.images} images · ${s.counts.videos} videos · ${cloud}`;
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
  aiEnabled: 'bool', aiConsent: 'bool', aiAnalyseImages: 'bool', aiAnalyseChats: 'bool',
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
  if (b.dataset.t === 'ai') AI.loadSettingsTab();
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
  document.body.classList.toggle('convo-active', v === 'convo');
  els.search.classList.toggle('hidden', v === 'convo');
  if (v === 'convo') Convo.enter();
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
    try { renderSearch(await (await fetch('/api/search?q=' + encodeURIComponent(q))).json(), q); } catch (e) {}
  }
  function renderSearch(res, q) {
    if (!res.length) { chatsEl.innerHTML = `<div class="convo-empty" style="padding:24px">No messages match “${escapeHtml(q)}”.</div>`; return; }
    chatsEl.innerHTML = '';
    for (const m of res) {
      const el = document.createElement('div');
      el.className = 'chatitem';
      el.innerHTML = `<div class="ci-top"><span class="ci-name">${escapeHtml(m.chatName || m.chatId)}</span><span class="ci-time">${shortDay(m.ts)}</span></div>
        <div class="ci-last">${escapeHtml((m.body || '').slice(0, 100))}</div>`;
      el.addEventListener('click', () => { searchEl.value = ''; searchMode = false; openChat({ chatId: m.chatId, chatName: m.chatName }); loadChats(); });
      chatsEl.appendChild(el);
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

  const labelFor = (id) => state.labels.get(id) || null;
  const chatLabelFor = (chatId) => state.chatGroups.get(chatId) || null;

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
    const r = await bridge.setAiKey(v);
    $$('ai-key').value = '';
    $$('ai-key').placeholder = r.ok ? '•••••••• (saved on this PC)' : 'Paste your key';
    $$('ai-test-status').innerHTML = r.ok
      ? '<span class="ok-text">Key saved, encrypted with your Windows account.</span>'
      : `<span class="bad-text">${escapeHtml(r.message || 'Could not save the key')}</span>`;
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
    loadLabels, loadChatGroups, loadSettingsTab, refreshEstimate, passes, matchesText,
    labelFor, chatLabelFor, renderAlbumBar, saveAiSettings, albumPicker, bindAlbumPicker,
    groups: () => state.groups,
  };
})();

/* ---------- Boot + polling ---------- */
maybeRunWizard();
loadState();
loadItems(true).then(() => { AI.loadLabels(); AI.loadChatGroups(); });
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
