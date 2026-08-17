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
function matchesFilter(r) {
  if (query && !((r.chat || '').toLowerCase().includes(query))) return false;
  if (filter === 'all') return true;
  if (filter === 'image' || filter === 'video') return r.kind === filter;
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
  if (r.kind === 'image') {
    el.innerHTML = `<img loading="lazy" src="${r.serve}" alt="" onerror="this.classList.add('imgerr')" />
      ${badge}
      <div class="cap"><span class="chat">${escapeHtml(r.chat)}</span><span class="time">${fmtTime(r.ts)}</span></div>`;
  } else {
    el.innerHTML = `<div class="videotile"><div class="play">▶</div></div>
      ${badge}
      <div class="cap"><span class="chat">${escapeHtml(r.chat)}</span><span class="time">${fmtTime(r.ts)}</span></div>`;
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
  if (r.kind === 'image') { el = document.createElement('img'); el.src = r.serve; }
  else { el = document.createElement('video'); el.src = r.serve; el.controls = true; el.autoplay = true; el.playsInline = true; }
  el.onerror = () => {
    els.lbStage.innerHTML = `<div class="lb-unavailable">⚠ This ${r.kind} can't be loaded right now.` +
      (r.kind === 'video' ? '<br><span>If it’s stored in pCloud, the drive may be offline.</span>' : '') + '</div>';
  };
  els.lbStage.appendChild(el);
  const sizeKb = r.size ? (r.size / 1024).toFixed(0) + ' KB' : '';
  const cloudTag = r.kind === 'video' && r.cloud ? ' · <span class="m-sub">saved to pCloud</span>' : '';
  els.lbMeta.innerHTML = `<span class="m-chat">${escapeHtml(r.chat)}</span>
    <span class="m-sub">${r.dir === 'out' ? 'Sent' : 'Received'} · ${new Date(r.ts).toLocaleString()} · ${sizeKb}${cloudTag}</span>
    <a href="${r.serve}" download>⭳ Download</a>`;
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

/* ---------- Settings ---------- */
const S = {
  open: document.getElementById('open-settings'),
  modal: document.getElementById('settings'),
  close: document.getElementById('settings-close'),
  conn: document.getElementById('conn-status'),
  limit: document.getElementById('backfill-limit'),
  btnBackfill: document.getElementById('btn-backfill'),
  backfillStatus: document.getElementById('backfill-status'),
  progress: document.getElementById('backfill-progress'),
  bar: document.getElementById('backfill-bar'),
  cloudRoot: document.getElementById('cloud-root'),
  btnCheck: document.getElementById('btn-checkpath'),
  pathStatus: document.getElementById('path-status'),
  mirror: document.getElementById('mirror-images'),
  captureConvos: document.getElementById('capture-convos'),
  btnExport: document.getElementById('btn-export'),
  exportStatus: document.getElementById('export-status'),
  paths: document.getElementById('paths'),
  btnRemoveSamples: document.getElementById('btn-remove-samples'),
  btnRestart: document.getElementById('btn-restart'),
  restartNote: document.getElementById('restart-note'),
  save: document.getElementById('settings-save'),
  saveStatus: document.getElementById('save-status'),
};

function openSettings() { S.modal.classList.remove('hidden'); loadSettings(); }
function closeSettings() { S.modal.classList.add('hidden'); }
S.open.addEventListener('click', openSettings);
S.close.addEventListener('click', closeSettings);
S.modal.addEventListener('click', (e) => { if (e.target === S.modal) closeSettings(); });

async function loadSettings() {
  try {
    const d = await (await fetch('/api/settings')).json();
    S.limit.value = d.settings.backfillLimit;
    S.cloudRoot.value = d.settings.cloudRoot;
    S.mirror.checked = !!d.settings.mirrorImages;
    if (S.captureConvos) S.captureConvos.checked = !!d.settings.captureConversations;
    S.pathStatus.innerHTML = d.cloudAvailable
      ? `<span class="ok-text">● Connected — videos saving to ${escapeHtml(d.paths.videos)}</span>`
      : `<span class="bad-text">● Cloud drive not found — videos saving locally to ${escapeHtml(d.paths.videos)}</span>`;
    const p = d.paths;
    S.paths.innerHTML = [
      ['Application folder', p.app], ['Images', p.images], ['Videos (cloud)', p.videos],
      ['Settings file', p.settingsFile], ['Media index', p.indexFile], ['Log file', p.log],
      ['Dashboard address', 'http://localhost:' + d.port],
    ].map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${escapeHtml(v)}</td></tr>`).join('');
  } catch (e) { S.saveStatus.textContent = 'Could not load settings'; }
}

S.btnCheck.addEventListener('click', async () => {
  S.pathStatus.textContent = 'Checking…';
  try {
    const r = await (await fetch('/api/check-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: S.cloudRoot.value }) })).json();
    S.pathStatus.innerHTML = `<span class="${r.writable ? 'ok-text' : 'bad-text'}">${escapeHtml(r.message)}</span>`;
  } catch (e) { S.pathStatus.textContent = 'Check failed'; }
});

S.save.addEventListener('click', async () => {
  S.saveStatus.textContent = 'Saving…';
  const body = { mirrorImages: S.mirror.checked, captureConversations: S.captureConvos ? S.captureConvos.checked : true, backfillLimit: parseInt(S.limit.value, 10) || 400, cloudRoot: S.cloudRoot.value.trim() };
  try {
    const r = await (await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    S.saveStatus.innerHTML = '<span class="ok-text">Saved ✓</span>';
    S.restartNote.textContent = r.restartRequired ? 'The cloud folder change takes effect after a restart — click “Restart app”.' : '';
    setTimeout(() => { S.saveStatus.textContent = ''; }, 2500);
  } catch (e) { S.saveStatus.textContent = 'Save failed'; }
});

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
        if (bf.error) S.backfillStatus.innerHTML = `<span class="bad-text">Error: ${escapeHtml(bf.error)}</span>`;
        else if (!bf.finishedAt) S.backfillStatus.innerHTML = '<span class="bad-text">Import was interrupted (app restarted). Click “Import history now” to continue.</span>';
        else S.backfillStatus.innerHTML = `<span class="ok-text">Done — imported ${bf.saved} item(s) from ${bf.totalChats} chats.</span>`;
        S.btnBackfill.disabled = false;
        loadItems(true);
      }
    } catch (e) { /* keep polling */ }
  }, 1500);
}

S.btnRemoveSamples.addEventListener('click', async () => {
  S.btnRemoveSamples.disabled = true;
  try {
    const r = await (await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: false }) })).json();
    S.saveStatus.innerHTML = `<span class="ok-text">Removed ${r.removed} sample(s)</span>`;
    loadItems(true);
    setTimeout(() => { S.saveStatus.textContent = ''; }, 2500);
  } catch (e) {}
  S.btnRemoveSamples.disabled = false;
});

S.btnRestart.addEventListener('click', async () => {
  if (!confirm('Restart the capture app? It reconnects automatically using your saved link (no re-scan).')) return;
  S.restartNote.textContent = 'Restarting… the dashboard will reconnect in a few seconds.';
  try { await fetch('/api/restart', { method: 'POST' }); } catch (e) {}
});

function updateConn(s) {
  if (!S.conn) return;
  if (s.status === 'ready') S.conn.innerHTML = `<span class="ok-text">● Linked${s.me ? ' as ' + escapeHtml(s.me) : ''}</span> · ${s.counts.images} images · ${s.counts.videos} videos captured`;
  else if (s.status === 'qr') S.conn.innerHTML = `<span class="bad-text">● Not linked</span> — scan the QR on the main screen`;
  else if (s.needsRelink) S.conn.innerHTML = `<span class="bad-text">● Unlinked</span> — click “Restart app” below, then re-scan`;
  else S.conn.textContent = s.status;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !S.modal.classList.contains('hidden')) closeSettings(); });

/* ---------- Export transcript ---------- */
if (S.btnExport) S.btnExport.addEventListener('click', async () => {
  S.btnExport.disabled = true; S.exportStatus.textContent = 'Exporting…';
  try {
    const r = await (await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    S.exportStatus.innerHTML = r.ok
      ? `<span class="ok-text">Saved ${r.messages} messages from ${r.chats} chats →</span> <span class="small">${escapeHtml(r.dir)}</span>`
      : `<span class="bad-text">${escapeHtml(r.error || 'failed')}</span>`;
  } catch (e) { S.exportStatus.textContent = 'Export failed'; }
  S.btnExport.disabled = false;
});

/* ---------- Open one media item in the lightbox (from a message bubble) ---------- */
function openSingleMedia(serve, kind) {
  lbId = null;
  els.lightbox.classList.remove('hidden');
  els.lbStage.innerHTML = '';
  const el = kind === 'video' ? document.createElement('video') : document.createElement('img');
  el.src = serve;
  if (kind === 'video') { el.controls = true; el.autoplay = true; el.playsInline = true; }
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
  let newestTs = 0;
  let canLoadOlder = false;
  let loading = false;
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
    for (const c of chats) {
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

  async function fetchThread(chatId, before) {
    const url = '/api/thread?chat=' + encodeURIComponent(chatId) + (before ? '&before=' + before : '') + '&limit=200';
    try { return await (await fetch(url)).json(); } catch (e) { return []; }
  }

  async function openChat(c) {
    activeChat = { chatId: c.chatId, chatName: c.chatName || c.chatId };
    [...chatsEl.children].forEach((x) => x.classList.toggle('active', x.dataset.chat === c.chatId));
    headEl.innerHTML = `<span class="th-name">${escapeHtml(activeChat.chatName)}</span>`;
    bodyEl.innerHTML = '<div class="convo-empty">Loading…</div>';
    oldestTs = null; newestTs = 0;
    const rows = await fetchThread(activeChat.chatId, null);
    bodyEl.innerHTML = '';
    if (!rows.length) { bodyEl.innerHTML = '<div class="convo-empty">No messages stored for this chat.</div>'; return; }
    oldestTs = rows[0].ts; newestTs = rows[rows.length - 1].ts;
    canLoadOlder = rows.length >= 200;
    bodyEl.appendChild(buildBubbles(rows));
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  async function loadOlder() {
    if (loading || !activeChat || !canLoadOlder) return;
    loading = true;
    const rows = await fetchThread(activeChat.chatId, oldestTs);
    loading = false;
    if (!rows.length) { canLoadOlder = false; return; }
    canLoadOlder = rows.length >= 200;
    const prevH = bodyEl.scrollHeight, prevTop = bodyEl.scrollTop;
    oldestTs = rows[0].ts;
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
      const rows = await (await fetch('/api/thread?chat=' + encodeURIComponent(activeChat.chatId) + '&after=' + newestTs + '&limit=200')).json();
      if (rows.length) {
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

/* ---------- Boot + polling ---------- */
loadState();
loadItems(true);
setInterval(loadState, 3000);
setInterval(() => { if (currentView === 'media') loadItems(false); }, 4000);
setInterval(() => Convo.pollActive(), 4000);
setInterval(() => { if (currentView === 'convo') Convo.refreshChats(); }, 9000);
