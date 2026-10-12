'use strict';

const els = {
  sub: document.getElementById('sub'),
  link: document.getElementById('link'),
  linkTitle: document.getElementById('link-title'),
  qrwrap: document.getElementById('qrwrap'),
  gallery: document.getElementById('gallery'),
  empty: document.getElementById('empty'),
  search: document.getElementById('search'),
  tabs: document.getElementById('kind'),
  zip: document.getElementById('zip'),
  lightbox: document.getElementById('lightbox'),
  lbStage: document.getElementById('lb-stage'),
  lbMeta: document.getElementById('lb-meta'),
  lbClose: document.getElementById('lb-close'),
  lbPrev: document.getElementById('lb-prev'),
  lbNext: document.getElementById('lb-next'),
};

// Where a record came from. Records older than the second source carry no
// source at all, and those are WhatsApp's.
const SOURCES = [
  { id: 'whatsapp', label: 'WhatsApp', glyph: '💬', badgeIn: '↓ Received', badgeOut: '↑ Sent' },
  { id: 'chatgpt', label: 'ChatGPT', glyph: '✦', badgeIn: '✦ ChatGPT', badgeOut: '↑ To ChatGPT' },
  { id: 'gemini', label: 'Gemini', glyph: '✦', badgeIn: '✦ Gemini', badgeOut: '✦ Gemini' },
];
const srcOf = (r) => r.source || 'whatsapp';
let allItems = [];         // full list, newest first
// Filter state lives up here with the rest: render() runs during the first
// load, long before the bottom of this file has executed, and a const declared
// down there is still in its dead zone when the first render reaches it.
// One object decides what the gallery shows. Every control reads and writes
// this and re-renders from it; none keeps a private copy. If two controls
// could disagree, one of them would be wrong.
const F = {
  q: '', contentScope: 'all', source: '', kind: '', exact: '', dir: '', album: '', project: '', tag: '', backup: '', final: '', from: '', to: '', sort: 'new', favorite: false,
};
const thumbUrl = (r) => '/api/thumbnail/' + encodeURIComponent(r.id);
const fEl = (id) => document.getElementById(id);

let filteredCache = [];    // allItems with the current filter applied
let renderedCount = 0;     // how many of filteredCache are in the DOM
let lastDayRendered = null;
let sentinel = null;
let io = null;
let newestTs = 0;
let lbId = null;           // id of the item currently open in the lightbox
const CHUNK = 72;

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
  if (F.favorite && window.Workspace && !window.Workspace.isFavorite(r.id)) return false;
  // Search reads the chat, the caption, a file name and — once labelled —
  // what is actually in the picture.
  if (F.q) {
    if (window.ContentSearch && window.ContentSearch.current(F.q)) {
      if (!window.ContentSearch.matches(r.id)) return false;
      return typeof matchesAdvanced === 'function' ? matchesAdvanced(r) : true;
    }
    const hay = [r.chat, r.caption, r.docName, r.filename].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(F.q) && !(typeof AI !== 'undefined' && AI.matchesText(r, F.q))) return false;
  }
  return typeof matchesAdvanced === 'function' ? matchesAdvanced(r) : true;
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
  // A picture from ChatGPT is still sent or received - you uploaded it, or it
  // made it - but the badge says which source, since that is the question the
  // gallery cannot otherwise answer.
  const s = SOURCES.find((x) => x.id === srcOf(r)) || SOURCES[0];
  const badge = '<span class="badge ' + (r.dir === 'out' ? 'out' : 'in') + '" data-source="' + s.id + '">' + (r.dir === 'out' ? s.badgeOut : s.badgeIn) + '</span>';
  const lbl = typeof AI !== 'undefined' ? AI.labelFor(r.id) : null;
  const albumTag = lbl && lbl.groupName
    ? `<span class="albumtag">${escapeHtml(lbl.groupEmoji || '📁')} ${escapeHtml(lbl.groupName)}</span>` : '';
  // Backed up is the norm and goes unmarked; only what is still on this PC
  // alone gets a mark, and only when there is a cloud folder to be missing from.
  const local = typeof Backup !== 'undefined' && Backup.configured() && Backup.onlyHere().has(r.id);
  const bk = local ? '<span class="bk local" title="On this PC only — not yet in your cloud folder">⚠</span>' : '';
  const cap = `<div class="cap"><span class="chat">${escapeHtml(r.chat)}</span>${bk}<span class="time">${fmtTime(r.ts)}</span></div>${albumTag}`;
  // Kept as a final, or one of a set the AI has a suggestion about.
  const fin = typeof Finals !== 'undefined' ? (Finals.isKept(r.id) ? '<span class="fin" title="Kept as a final — a copy is in your Finals folder">★ Final</span>'
    : Finals.isSuggested(r.id) ? '<span class="fin sug" title="One of several versions — the AI has a suggestion. See Finals.">✦ versions</span>' : '') : '';
  if (r.kind === 'image' || r.kind === 'sticker') {
    el.innerHTML = `<img loading="lazy" decoding="async" src="/api/thumbnail/${encodeURIComponent(r.id)}" alt="${escapeHtml(lbl?.label?.caption || r.caption || 'Saved photo')}" onerror="this.classList.add('imgerr')" />${fin}${badge}${cap}`;
  } else if (r.kind === 'video') {
    // A real first frame as the still, made once by the engine; the clip
    // itself is only fetched when the pointer rests on it.
    el.innerHTML = `<div class="videotile">
        <video class="tile-vid" muted playsinline loop preload="none" poster="/api/thumbnail/${encodeURIComponent(r.id)}" data-src="${r.serve}#t=${PREVIEW_AT}"></video>
        <div class="play">▶</div>
        <div class="mutehint" title="Muted while previewing — click to open it with sound">🔇</div>
      </div>${fin}${badge}${cap}`;
  } else {
    const name = r.docName || decodeURIComponent((r.serve || '').split('/').pop() || '');
    const l = lbl && lbl.label;
    const title = l && (l.summary || (l.title && l.title !== name)) ? `<div class="filetitle">${escapeHtml((l.title && l.title !== name ? l.title : '') || String(l.summary || '').slice(0, 90))}</div>` : '';
    el.innerHTML = `<div class="filetile"><div class="fileicon">${KIND_ICON[r.kind] || '📎'}</div>
        <div class="filename">${escapeHtml(name)}</div>
        <div class="filekind">${escapeHtml(KIND_LABEL[r.kind] || r.kind)}${l && l.doc_type && l.doc_type !== 'other' ? ' · ' + escapeHtml(l.doc_type) : ''}${l && l.transcript ? ' · transcribed' : ''}</div>${title}</div>${fin}${badge}${cap}`;
  }
  el.addEventListener('click', (event) => { if (event.target.closest('.tile-favorite,.tile-select')) return; event.preventDefault(); openLightbox(r); });
  if (window.Workspace) window.Workspace.decorateTile(el, r);
  if (window.ContentSearch) window.ContentSearch.decorate(el, r);
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
        // Video bytes are fetched only after an intentional hover or open.
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
    if (window.Workspace && !window.Workspace.videoPreview()) return;
    clearTimeout(hold);
    // A beat before starting, so sweeping the pointer across the grid doesn't
    // kick off a dozen downloads that are all abandoned immediately.
    hold = setTimeout(() => {
      if (window.Workspace && !window.Workspace.videoPreview()) return;
      loadTileVideo(v);
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
  // A hidden gallery has a zero-height sentinel; filling it would build the entire archive.
  if (!els.gallery.getClientRects().length) return;
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
  if (tileVideoIO) tileVideoIO.disconnect();
  els.gallery.querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
  els.gallery.innerHTML = '';
  renderedCount = 0; lastDayRendered = null; sentinel = null;
  const none = filteredCache.length === 0;
  els.empty.classList.toggle('hidden', !none);
  if (none) {
    els.empty.innerHTML = allItems.length
      ? 'Nothing matches. <button class="btn small" id="empty-clear">Clear all</button>'
      : 'Your gallery is empty. <button class="btn small" data-source-action="connection">Connect a source</button> <button class="btn small" data-source-action="history">Import WhatsApp history</button>';
    const ec = document.getElementById('empty-clear'); if (ec) ec.addEventListener('click', clearAll);
  }
  if (els.zip) els.zip.textContent = filtersActive() ? '⭳ Download all photos' : '⭳ Download all photos';
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && renderedCount < filteredCache.length) appendChunk();
  }, { rootMargin: '900px' });
  appendChunk();
  fillViewport();
  if (window.Workspace) window.Workspace.onRender();
}

// Prepend genuinely new (newest) items without rebuilding the whole gallery.
function prependNew(items) {
  if (F.sort !== 'new') { render(allItems); return; }
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
  if (window.Workspace) window.Workspace.onRender();
}

/* ---------- Lightbox (tracked by id so it survives live updates) ---------- */
function currentIndex() { return filteredCache.findIndex((r) => r.id === lbId); }
let lightboxOpener = null;
function openLightbox(r) { lightboxOpener = document.activeElement; lbId = r.id; els.lightbox.classList.remove('hidden'); showCurrent(); els.lbClose.focus(); }
function closeLightbox() { els.lightbox.classList.add('hidden'); els.lbStage.innerHTML = ''; lbId = null; const opener = lightboxOpener; requestAnimationFrame(() => { if (opener?.isConnected && document.activeElement === document.body) opener.focus(); }); }
function showCurrent() {
  const i = currentIndex();
  if (i < 0) return;
  const r = filteredCache[i];
  els.lbStage.innerHTML = '';
  let el;
  if (r.kind === 'image' || r.kind === 'sticker') { el = document.createElement('img'); el.src = r.serve; el.alt = r.caption || r.docName || `${r.chat || 'Saved'} photo`; }
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
  const cloudTag = typeof Backup !== 'undefined' && Backup.configured()
    ? (Backup.onlyHere().has(r.id) ? ' · <span class="tag warn">⚠ On this PC only</span>' : ' · <span class="tag ok">☁ In cloud folder</span>')
    : '';
  const lbl = typeof AI !== 'undefined' ? AI.labelFor(r.id) : null;
  const l = lbl && lbl.label;
  const aiBlock = l ? `<span class="m-ai">${escapeHtml(l.title && l.title !== (r.docName || '') ? l.title + ' — ' : '')}${escapeHtml(String(l.summary || l.caption || '').slice(0, 400))}
      ${(l.tags || []).slice(0, 6).map((t) => `<em>${escapeHtml(t)}</em>`).join('')}
      ${l.text_in_image ? `<span class="m-ocr">reads: “${escapeHtml(String(l.text_in_image).slice(0, 120))}”</span>` : ''}
      ${l.visual === false ? '<span class="m-ocr">described from its chat — no frame of this video could be read</span>' : ''}
      ${l.sampledFrames ? `<span class="m-ocr">seen as ${l.sampledFrames} frames</span>` : ''}
    </span>` : '';
  const kept = typeof Finals !== 'undefined' && Finals.isKept(r.id);
  els.lbMeta.innerHTML = `<span class="m-chat">${escapeHtml(r.chat)}</span>
    <span class="m-sub">${r.dir === 'out' ? 'Sent' : 'Received'} · ${new Date(r.ts).toLocaleString()} · ${sizeKb}${cloudTag}</span>
    ${aiBlock}
    <span id="lb-extra"></span>
    ${typeof AI !== 'undefined' && AI.groups().length ? AI.albumPicker(r) : ''}
    <a href="#" id="lb-final" class="final${kept ? ' on' : ''}" title="${kept ? 'A copy is in your Finals folder. Click to take it out again.' : 'Copy this into your Finals folder and mark it as the one to keep'}">${kept ? '★ Kept as final' : '☆ Keep as final'}</a>
    <a href="${r.serve}" download>⭳ Download</a>
    <a href="#" id="lb-show-local" title="Open the folder on this PC with this file selected">📁 Show in folder</a>
    <a href="#" id="lb-show-cloud" title="Open the pCloud folder with this file selected">☁ Show in pCloud</a>
    ${(r.kind === 'image' || r.kind === 'video') ? '<a href="#" id="lb-queue-status" title="Add to the status queue">📣 Queue as status</a>' : ''}
    <span id="lb-where" class="m-where"></span>`;
  if (typeof AI !== 'undefined') AI.bindAlbumPicker(r);
  bindShowInFolder(r);
  if (window.Workspace) window.Workspace.viewer(r);
  if (window.ContentSearch) window.ContentSearch.viewer(r);
  const fb = document.getElementById('lb-final');
  if (fb && typeof Finals !== 'undefined') fb.addEventListener('click', async (e) => {
    e.preventDefault();
    fb.textContent = '…';
    const now = await Finals.toggleKeep(r.id);
    if (lbId !== r.id) return;
    fb.classList.toggle('on', now);
    fb.textContent = now ? '★ Kept as final' : '☆ Keep as final';
    const t = document.querySelector('.tile[data-id="' + CSS.escape(r.id) + '"]');
    if (t) { const old = t.querySelector('.fin'); if (old) old.remove(); if (now) t.insertAdjacentHTML('afterbegin', '<span class="fin">★ Final</span>'); }
  });
  // The long parts — a transcript, a document's details — come for one item at a time.
  if (r.kind === 'document' || r.kind === 'voice' || r.kind === 'audio' || r.kind === 'video' || (l && l.kind)) fillLightboxExtra(r);
  const qs = document.getElementById('lb-queue-status');
  if (qs) qs.addEventListener('click', async (e) => {
    e.preventDefault();
    const resp = await fetch('/api/status/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId: r.id }) }).then((x) => x.json());
    qs.textContent = resp.ok ? '✓ In the status queue' : ('✗ ' + (resp.error || 'failed'));
  });
  els.lbPrev.style.visibility = i > 0 ? 'visible' : 'hidden';
  els.lbNext.style.visibility = i < filteredCache.length - 1 ? 'visible' : 'hidden';
}
async function fillLightboxExtra(r) {
  let d = null;
  try { d = await requestJson('/api/media/' + encodeURIComponent(r.id) + '/label'); } catch (_) { return; }
  if (lbId !== r.id) return;
  const box = document.getElementById('lb-extra');
  if (!box || !d || !d.label) return;
  const l = d.label;
  const bits = [];
  if (d.kind === 'document') {
    const row = (k, v) => v && v.length ? `<b>${k}:</b> ${escapeHtml(Array.isArray(v) ? v.join(' · ') : v)}` : '';
    const parts = [row('Type', l.doc_type && l.doc_type !== 'other' ? l.doc_type : ''), row('From/to', l.parties), row('Dates', l.dates), row('Amounts', l.amounts), row('References', l.reference_numbers), l.totalPages ? `<b>Pages:</b> ${l.totalPages}${l.truncated ? ' (first part read)' : ''}` : '', l.version_hint ? `<b>Version:</b> ${escapeHtml(l.version_hint)}` : ''].filter(Boolean);
    if (parts.length) bits.push(`<span class="m-doc">${parts.join(' &nbsp; ')}</span>`);
    if (l.unreadable) bits.push('<span class="m-doc">No readable text — a scan or a picture of a page.</span>');
  }
  if (d.kind === 'image' || d.kind === 'video') {
    const facts = [l.kind && l.kind !== 'other' && l.kind !== 'photo' ? `<b>Kind:</b> ${escapeHtml(l.kind)}` : '', l.people ? `<b>People:</b> ${l.people}` : '', l.version_hint ? `<b>Version mark:</b> ${escapeHtml(l.version_hint)}` : '', l.quality ? `<b>Quality:</b> ${'★'.repeat(l.quality)}` : ''].filter(Boolean);
    if (facts.length) bits.push(`<span class="m-doc">${facts.join(' &nbsp; ')}</span>`);
  }
  if (l.transcript) bits.push(`<span class="m-transcript">${escapeHtml(l.transcript)}</span>`);
  if (Array.isArray(l.action_items) && l.action_items.length) bits.push(`<span class="m-doc"><b>To do:</b> ${escapeHtml(l.action_items.join(' · '))}</span>`);
  if (d.set) bits.push(`<span class="m-set">One of ${d.set.members} versions${d.set.status === 'suggested' ? ' — the AI suggests ' + (d.set.suggestedId === r.id ? 'this one' : 'another one') : d.set.status === 'kept' ? ' — decided' : ''}. <a href="#" id="lb-open-set">See the set</a></span>`);
  box.innerHTML = bits.join('');
  const os = document.getElementById('lb-open-set');
  if (os) os.addEventListener('click', (e) => { e.preventDefault(); closeLightbox(); setView('finals'); if (typeof Finals !== 'undefined') Finals.showSet(d.set.id); });
}

// "Show in folder": the desktop app opens Explorer with the file selected; in
// a plain browser, which cannot, the path is shown and copied instead.
async function bindShowInFolder(r) {
  const aLocal = document.getElementById('lb-show-local');
  const aCloud = document.getElementById('lb-show-cloud');
  const out = document.getElementById('lb-where');
  if (!aLocal || !aCloud) return;
  let w = null;
  try { w = await requestJson('/api/media/' + encodeURIComponent(r.id) + '/where'); } catch (_) {}
  if (lbId !== r.id) return;                       // moved on while asking
  aLocal.hidden = !(w && w.local);
  aCloud.hidden = !(w && w.cloud);
  if (w && !w.cloud && w.cloudExpected) out.textContent = 'Not copied to pCloud yet — the backup picks it up shortly.';
  const reveal = async (p) => {
    if (bridge && bridge.showInFolder) {
      const ok = await bridge.showInFolder(p);
      if (ok) { out.textContent = ''; return; }
    }
    try { await navigator.clipboard.writeText(p); out.textContent = 'Path copied: ' + p; }
    catch (_) { out.textContent = p; }
  };
  aLocal.onclick = (e) => { e.preventDefault(); if (w && w.local) reveal(w.local); };
  aCloud.onclick = (e) => { e.preventDefault(); if (w && w.cloud) reveal(w.cloud); };
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
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); return; }
  if (e.key === 'Tab') {
    const items = [...els.lightbox.querySelectorAll('button,a[href],input,select,video[controls],audio[controls]')].filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
  }
  if (e.target.closest('input,select,textarea,video,audio')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});

/* ---------- Controls ---------- */
function syncKindUi() {
  if (!els.tabs) return;
  [...els.tabs.querySelectorAll('button[data-kind]')].forEach((c) => c.classList.toggle('active', (c.dataset.kind || '') === (F.kind || '')));
}
if (els.tabs) els.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]'); if (!b) return;
  F.kind = b.dataset.kind || '';
  syncKindUi();
  render(allItems);
});
let searchT;
els.search.addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { F.q = els.search.value.trim().toLowerCase(); if (window.ContentSearch) window.ContentSearch.query(F.q); else render(allItems); }, 250);
});

/* ---------- Data + live updates ---------- */
async function loadState() {
  try {
    const s = await requestJson('/api/state');
    lastStateSeen = s;                       // the backup card reads the link from here
    if (typeof updateConn === 'function') updateConn(s);
    // Which version this is doesn't depend on whether WhatsApp is linked.
    if (typeof showVersion === 'function') showVersion(s.version);
    const status = s.status;
    // An item can arrive carrying an older date than the newest one here — a
    // Gemini picture dated by its file, say — and the incremental poll asks
    // only for newer. When the engine's totals disagree with what is shown,
    // fetch everything once rather than wait for a reload.
    const haveNow = allItems.filter((r) => r.kind === 'image' || r.kind === 'video').length;
    const wantNow = (s.counts && (s.counts.images || 0) + (s.counts.videos || 0)) || 0;
    if (s.counts && wantNow !== haveNow && !reloadingAll && typeof loadItems === 'function') {
      reloadingAll = true;
      loadItems(true).then(() => { renderSourceBar(); if (typeof Overview !== 'undefined' && currentView === 'overview') Overview.render(); }).finally(() => { reloadingAll = false; });
    }
    if (status === 'ready') {
      els.link.classList.add('hidden');
      const synced = typeof syncLine === 'function' ? syncLine(s) : '';
      const catching = s.sync && s.sync.running ? ` · <span class="warn-text">catching up ${s.sync.done}/${s.sync.chats} chats</span>` : '';
      els.sub.innerHTML = `<span class="dot ok"></span>Linked${s.me ? ' as ' + escapeHtml(s.me) : ''} · ${s.counts.images} photos · ${s.counts.videos} videos${synced}${catching}`;
    } else if (status === 'qr') {
      els.link.classList.remove('hidden');
      els.linkTitle.textContent = 'Link your WhatsApp';
      els.qrwrap.innerHTML = s.qr ? `<img src="${s.qr}" alt="QR code" />` : '<div class="spinner"></div>';
      els.sub.innerHTML = `<span class="dot warn"></span>Waiting for you to scan the QR code`;
    } else if (status === 'authenticated' || status === 'starting') {
      els.sub.innerHTML = `<span class="dot warn"></span>${status === 'authenticated' ? 'WhatsApp signed in · waiting for sync' : 'Connecting to WhatsApp'} · saved files are available`;
      if (status === 'authenticated') els.link.classList.add('hidden');
    } else if (s.needsRelink) {
      els.sub.innerHTML = `<span class="dot bad"></span>Device unlinked — open ⚙︎ Settings → Restart app, then re-scan the QR`;
    } else {
      els.sub.innerHTML = `<span class="dot bad"></span>${escapeHtml(status)}${s.lastError ? ' — ' + escapeHtml(s.lastError) : ''}`;
    }
  } catch (e) {
    els.sub.innerHTML = `<span class="dot bad"></span>Dashboard offline`;
  }
  if (typeof Backup !== 'undefined') Backup.noteState(lastStateSeen);
}

async function loadItems(initial) {
  try {
    const url = initial ? '/api/list' : '/api/list?since=' + newestTs;
    const rows = await requestJson(url);
    if (initial) {
      allItems = rows;
      newestTs = allItems.length ? allItems[0].ts : 0;
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

/* ---------- Quit for real ---------------------------------------------------
   Closing the window leaves it in the tray on purpose, which is right for
   something whose job is to be running. It is wrong when the answer to "is it
   off?" has to be yes. This is the only control that ends it, so it says what
   stops when it does, and it asks first. */
const exitBtn = document.getElementById("app-exit");
if (exitBtn) exitBtn.addEventListener("click", async () => {
  if (!bridge) {
    alert("This page is open in a browser, which cannot close the app.\n\nQuit it from the WhatsBackUp icon in the system tray.");
    return;
  }
  const ok = confirm("Close WhatsBackUp completely?\n\nIt will stop saving new photos and messages, and stop posting any scheduled status, until you open it again.\n\nNothing already saved is deleted.");
  if (!ok) return;
  exitBtn.disabled = true;
  exitBtn.textContent = "⏳";
  try {
    await bridge.quit();
  } catch (e) {
    // Still here means it did not go: say so rather than leave a dead button.
    exitBtn.disabled = false;
    exitBtn.textContent = "⏻";
    alert("Could not close it: " + (e && e.message ? e.message : e) + "\n\nQuit from the tray icon instead.");
  }
});

/* ---------- Linked sources -----------------------------------------------
   One card per outside account (ChatGPT, Gemini), all the same shape: a
   status line, what the last look found, connect / back up / forget. State
   is polled while Settings is open, because a connect or a scan runs in the
   engine for minutes and the card should say so rather than go quiet. */
function makeSourceCard(prefix, api, label) {
  const el = (id) => document.getElementById(id);
  const status = el(prefix + "-status"), last = el(prefix + "-last");
  const bConnect = el(prefix + "-connect"), bScan = el(prefix + "-scan"), bForget = el(prefix + "-disconnect");
  if (!status) return { refresh() {}, start() {}, stop() {} };
  let timer = null;

  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
  const inWhen = (ms) => { const m = Math.round((ms - Date.now()) / 60000); return m < 60 ? "in " + Math.max(1, m) + " min" : "in " + Math.round(m / 60) + " h"; };
  const span = (cls, text) => "<span class=" + String.fromCharCode(34) + cls + String.fromCharCode(34) + ">" + text + "</span>";

  async function refresh() {
    let s = null;
    try { s = await requestJson(api + '/state'); }
    catch (e) { status.textContent = 'Source status unavailable — try again shortly.'; return; }
    const busy = !!s.busy;
    let line;
    if (s.status === "connecting") line = span("warn-text", "● A window is open — sign in there");
    else if (s.status === "scanning") {
      const pr = s.progress || {};
      const bits = [];
      if (pr.phase === 'made') bits.push("images ChatGPT made" + (pr.of ? ": " + (pr.images || 0) + " of " + pr.of : ""));
      else if (pr.phase === 'sent') bits.push("your latest uploads");
      else if (pr.phase === 'listing') bits.push("getting your list of chats to look for older photos");
      else if (pr.phase === 'chats') {
        bits.push("looking for older photos: " + pr.conversations + " of " + pr.of + " chats");
        if (pr.unchanged) bits.push(pr.unchanged + " already searched");
      } else if (pr.of) bits.push(pr.conversations + " of " + pr.of);
      if (pr.phase !== 'made' && pr.images) bits.push(pr.images + " photos found");
      if (pr.saved) bits.push(pr.saved + " saved");
      if (pr.waitingUntil && pr.waitingUntil > Date.now()) bits.push("paused " + Math.max(1, Math.round((pr.waitingUntil - Date.now()) / 1000)) + "s — " + escapeHtml(pr.waitReason || "waiting"));
      line = span("warn-text", "● Importing…" + (bits.length ? " " + bits.join(" · ") : ""));
    }
    else if (s.status === "error") line = span("bad-text", "● " + escapeHtml(s.lastError || "Something went wrong"));
    else if (s.lastRun && s.lastRun.failed) line = span('warn-text', '● Import incomplete');
    else if (s.linked) line = span("ok-text", "● Connected");
    else line = span("muted", "● Not connected");
    status.innerHTML = line;

    const bits = [];
    if (s.lastRun) bits.push((s.lastRun.saved ? s.lastRun.saved + " new" : "nothing new") + " of " + s.lastRun.images + " photos" + (s.lastRun.conversations ? " in " + s.lastRun.conversations + " chats" : "") + ", " + ago(s.lastRun.at));
    else if (s.linked) bits.push("No completed import recorded on this installation");
    if (s.status === 'scanning' && s.progress && s.progress.phase === 'chats') bits.push('Only photos are kept. Stopping loses nothing; it picks up where it left off.');
    if (s.lastRun && s.lastRun.failed) bits.push(s.lastRun.failed + ' failed — import again to retry missing items');
    if (s.lastRun && s.lastRun.firstError) bits.push(escapeHtml(s.lastRun.firstError));
    if (s.enabled && s.nextScanAt && !busy) bits.push("next look " + inWhen(s.nextScanAt));
    if (!s.enabled && s.linked) bits.push("schedule off — use Import now");
    if (s.lastError && s.status !== "error") bits.push(escapeHtml(s.lastError));
    last.innerHTML = bits.join(" · ");

    bConnect.disabled = busy;
    bConnect.textContent = s.linked ? "Sign in again…" : "Connect " + label + "…";
    bScan.disabled = busy || !s.linked;
    bForget.disabled = busy || !s.linked;
    clearTimeout(timer); timer = null;
    if (busy) timer = setTimeout(refresh, 2500);
  }

  const post = async (url) => {
    try { return await requestJson(url, { method: 'POST' }); }
    catch (e) { alert('Could not start: ' + e.message); }
  };
  bConnect.addEventListener("click", async () => { bConnect.disabled = true; await post(api + "/connect"); refresh(); });
  bScan.addEventListener("click", async () => { bScan.disabled = true; await post(api + "/scan"); refresh(); });
  bForget.addEventListener("click", async () => {
    if (!confirm("Forget the " + label + " account on this PC?" + String.fromCharCode(10, 10) + "The pictures already saved stay. To back up again you would sign in again.")) return;
    await post(api + "/disconnect"); refresh();
  });

  let modalTimer = null;
  const start = () => { refresh(); clearInterval(modalTimer); modalTimer = setInterval(refresh, 8000); };
  const stop = () => { clearInterval(modalTimer); modalTimer = null; clearTimeout(timer); timer = null; };
  return { refresh, start, stop };
}
const ChatGptSource = makeSourceCard("cgpt", "/api/chatgpt", "ChatGPT");
const GeminiSource = makeSourceCard("gem", "/api/gemini", "Gemini");
// The pCloud card: the same shape as the account cards, fed by the backup
// module rather than a login.
const CloudCard = (function () {
  const el = (id) => document.getElementById(id);
  const status = el("cloud-status"), counts = el("cloud-counts");
  const bSweep = el("cloud-sweep"), bOpen = el("cloud-open"), bChange = el("cloud-change");
  if (!status) return { refresh() {}, start() {}, stop() {} };
  let timer = null;
  const span = (cls, text) => "<span class=" + String.fromCharCode(34) + cls + String.fromCharCode(34) + ">" + text + "</span>";
  function refresh() {
    const st = typeof Backup !== "undefined" ? Backup.status() : null;
    const d = typeof Backup !== "undefined" ? Backup.describe() : null;
    if (!st || !d) { status.innerHTML = span("muted", "\u25cf Checking\u2026"); return; }
    const cls = d.state === "ok" ? "ok-text" : d.state === "warn" ? "warn-text" : "muted";
    status.innerHTML = span(cls, "\u25cf " + (st.configured ? (st.available ? "Backing up to " + escapeHtml(st.root) : "Not reachable \u2014 " + escapeHtml(st.root)) : "No cloud folder set"));
    const sw = st.sweep || {};
    const bits = [];
    if (st.configured) bits.push(st.onCloud + " backed up \u00b7 " + st.onlyHere + " on this PC only");
    if (sw.running) bits.push("copying\u2026 " + sw.copied + " so far");
    else if (sw.lastSweepAt) bits.push("last sweep " + Math.max(1, Math.round((Date.now() - sw.lastSweepAt) / 60000)) + " min ago" + (sw.copied ? ", " + sw.copied + " copied" : ""));
    if (sw.lastError) bits.push(escapeHtml(sw.lastError));
    counts.textContent = bits.join(" \u00b7 ");
    bSweep.disabled = !st.configured || !st.available || !!sw.running;
    bSweep.textContent = sw.running ? "Working\u2026" : "Back up now";
    bOpen.disabled = !st.configured;
    clearTimeout(timer); timer = null;
    if (sw.running) timer = setTimeout(async () => { await Backup.refresh(); refresh(); }, 3000);
  }
  bSweep.addEventListener("click", async () => { bSweep.disabled = true; bSweep.textContent = "Working\u2026"; await Backup.sweep(); refresh(); });
  bOpen.addEventListener("click", () => { const st = Backup.status(); if (st && st.root && bridge) bridge.openPath(st.root); });
  bChange.addEventListener("click", () => { const tab = document.querySelector("#settabs [data-t=" + String.fromCharCode(34) + "storage" + String.fromCharCode(34) + "]"); if (tab) tab.click(); });
  let modalTimer = null;
  const start = async () => { await Backup.refresh(); refresh(); clearInterval(modalTimer); modalTimer = setInterval(async () => { await Backup.refresh(); refresh(); }, 15000); };
  const stop = () => { clearInterval(modalTimer); modalTimer = null; clearTimeout(timer); timer = null; };
  return { refresh, start, stop };
})();
const SourceCards = [ChatGptSource, GeminiSource, CloudCard];

// Where each source's photos live and how much of them there is — said on
// the card, in the same words the Where tab uses.
async function fillSourceWhere() {
  let s = null;
  try { s = await (await fetch('/api/sources/summary')).json(); } catch (e) { return; }
  const line = (k) => {
    const n = s[k] ? s[k].count : 0, b = s[k] ? s[k].bytes : 0;
    return (n ? n + ' photo' + (n === 1 ? '' : 's') + ' · ' + fmtBytes(b) : 'Nothing imported yet') + ' · saved to ' + escapeHtml(s.dirs.images)
      + (s.dirs.cloudImages ? ' · copied to ' + escapeHtml(s.dirs.cloudImages) : '');
  };
  const c = document.getElementById('cgpt-where'); if (c) c.innerHTML = line('chatgpt');
  const g = document.getElementById('gem-where'); if (g) g.innerHTML = line('gemini');
  return s;
}
/* ---------- Clean up ------------------------------------------------------
   The engine says what could go and why; this screen lets you tick it and
   move it. Selection lives here, not in the engine, so looking again never
   loses what was ticked. */
const Cleanup = (function () {
  const $c = (id) => document.getElementById(id);
  const groupsEl = $c("cl-groups"), summary = $c("cl-summary");
  const bQuar = $c("cl-quarantine"), bRefresh = $c("cl-refresh");
  const quarList = $c("cl-quar-list"), quarCount = $c("cl-quar-count");
  const bRestore = $c("cl-restore"), bPurge = $c("cl-purge");
  if (!groupsEl) return { enter() {} };

  const picked = new Set();      // ids ticked in the suggestions
  const pickedQ = new Set();     // ids ticked in quarantine
  let data = null;

  const mb = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
  const thumb = (it) => it.kind === "video"
    ? "<div class=" + q("cl-thumb vid") + ">&#9654;</div>"
    : "<img class=" + q("cl-thumb") + " loading=" + q("lazy") + " decoding=" + q("async") + " src=" + q('/api/thumbnail/' + encodeURIComponent(it.id)) + " alt=" + q("") + ">";
  function q(s) { return String.fromCharCode(34) + s + String.fromCharCode(34); }

  function renderGroups() {
    if (!data) return;
    if (!data.groups.length) {
      groupsEl.innerHTML = "<p class=" + q("muted") + " style=" + q("padding:20px 0") + ">Nothing to suggest. The library is tidy.</p>";
      summary.textContent = data.library + " items looked at, nothing to suggest.";
      bQuar.disabled = true; return;
    }
    summary.textContent = data.totalCount + " item" + (data.totalCount === 1 ? "" : "s") + " (" + mb(data.totalBytes) + ") could be tidied away — out of " + data.library + " in your library.";
    groupsEl.innerHTML = "";
    for (const g of data.groups) {
      const sec = document.createElement("section");
      sec.className = "cl-group";
      const allOn = g.items.every((it) => picked.has(it.id));
      sec.innerHTML = "<div class=" + q("cl-group-head") + ">"
        + "<label class=" + q("cl-all") + "><input type=" + q("checkbox") + " " + (allOn ? "checked" : "") + " data-all=" + q(g.reason) + "> <b>" + escapeHtml(g.label) + "</b></label>"
        + "<span class=" + q("cl-sure " + g.sure) + ">" + ({ certain: "Safe to go", likely: "Probably", optional: "Your call" })[g.sure] + "</span>"
        + "<span class=" + q("muted small") + ">" + g.count + " item" + (g.count === 1 ? "" : "s") + " · " + mb(g.bytes) + "</span>"
        + "</div>"
        + "<p class=" + q("muted small cl-detail") + ">" + escapeHtml(g.detail) + "</p>"
        + "<div class=" + q("cl-grid") + ">" + g.items.map((it) => 
            "<label class=" + q("cl-item" + (picked.has(it.id) ? " on" : "")) + " data-id=" + q(it.id) + ">"
            + "<input type=" + q("checkbox") + " " + (picked.has(it.id) ? "checked" : "") + ">"
            + thumb(it)
            + "<span class=" + q("cl-meta") + ">" + escapeHtml((it.chat || "").slice(0, 26)) + "<i>" + mb(it.bytes) + "</i></span>"
            + (it.keep ? "<span class=" + q("cl-keep") + " title=" + q("the one that is kept") + ">keeping <img src=" + q(it.keep.serve || "") + " alt=" + q("") + "></span>" : "")
            + "</label>").join("")
        + "</div>";
      groupsEl.appendChild(sec);
    }
    bQuar.disabled = picked.size === 0;
    bQuar.textContent = picked.size ? "Set aside " + picked.size + " (" + mb(pickedBytes()) + ")" : "Set aside selected";
  }
  function pickedBytes() {
    let n = 0; if (!data) return 0;
    for (const g of data.groups) for (const it of g.items) if (picked.has(it.id)) n += it.bytes || 0;
    return n;
  }

  groupsEl.addEventListener("change", (e) => {
    const all = e.target.closest("input[data-all]");
    if (all) {
      const g = data.groups.find((x) => x.reason === all.dataset.all);
      for (const it of g.items) { if (all.checked) picked.add(it.id); else picked.delete(it.id); }
      renderGroups(); return;
    }
    const item = e.target.closest(".cl-item");
    if (!item) return;
    if (e.target.checked) picked.add(item.dataset.id); else picked.delete(item.dataset.id);
    item.classList.toggle("on", e.target.checked);
    bQuar.disabled = picked.size === 0;
    bQuar.textContent = picked.size ? "Set aside " + picked.size + " (" + mb(pickedBytes()) + ")" : "Set aside selected";
  });

  async function load() {
    summary.textContent = "Checking your library…";
    try { data = await (await fetch("/api/cleanup/suggest")).json(); } catch (e) { summary.textContent = "Couldn’t check the library — " + e.message; return; }
    // Drop ticks for things that are no longer suggested.
    const live = new Set(); for (const g of data.groups) for (const it of g.items) live.add(it.id);
    for (const id of [...picked]) if (!live.has(id)) picked.delete(id);
    renderGroups();
    loadQuar();
  }

  async function loadQuar() {
    let qd = null;
    try { qd = await (await fetch("/api/cleanup/list")).json(); } catch (e) { return; }
    quarCount.textContent = qd.count ? qd.count + " item" + (qd.count === 1 ? "" : "s") + " · " + mb(qd.bytes) : "empty";
    quarList.innerHTML = qd.count ? "<div class=" + q("cl-grid") + ">" + qd.items.map((it) =>
        "<label class=" + q("cl-item" + (pickedQ.has(it.id) ? " on" : "")) + " data-qid=" + q(it.id) + ">"
        + "<input type=" + q("checkbox") + " " + (pickedQ.has(it.id) ? "checked" : "") + ">"
        + thumb({ kind: it.kind, serve: "/quarantine/" + encodeURIComponent(it.filename) })
        + "<span class=" + q("cl-meta") + ">" + escapeHtml((it.chat || "").slice(0, 26)) + "<i>" + mb(it.bytes) + "</i></span>"
        + "</label>").join("") + "</div>"
      : "<p class=" + q("muted small") + ">Nothing set aside.</p>";
    const any = pickedQ.size > 0;
    bRestore.disabled = !any; bPurge.disabled = !any;
  }
  quarList.addEventListener("change", (e) => {
    const item = e.target.closest(".cl-item"); if (!item) return;
    if (e.target.checked) pickedQ.add(item.dataset.qid); else pickedQ.delete(item.dataset.qid);
    item.classList.toggle("on", e.target.checked);
    const any = pickedQ.size > 0; bRestore.disabled = !any; bPurge.disabled = !any;
  });

  const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  bQuar.addEventListener("click", async () => {
    if (!picked.size) return;
    bQuar.disabled = true;
    const r = await post("/api/cleanup/quarantine", { ids: [...picked], reason: "chosen" });
    picked.clear();
    if (r.failed && r.failed.length) alert(r.failed.length + " couldn’t be set aside. The rest were.");
    load();
    if (typeof loadItems === "function") loadItems(true);
  });
  bRefresh.addEventListener("click", load);
  bRestore.addEventListener("click", async () => {
    if (!pickedQ.size) return;
    await post("/api/cleanup/restore", { ids: [...pickedQ] });
    pickedQ.clear(); load();
    if (typeof loadItems === "function") loadItems(true);
  });
  bPurge.addEventListener("click", async () => {
    if (!pickedQ.size) return;
    const n = pickedQ.size;
    if (!confirm("Delete " + n + " item" + (n === 1 ? "" : "s") + " forever?" + String.fromCharCode(10, 10) + "This cannot be undone.")) return;
    if (!confirm("Last check - really delete " + n + " forever?")) return;
    await post("/api/cleanup/purge", { ids: [...pickedQ] });
    pickedQ.clear(); loadQuar();
  });

  return { enter: load };
})();

/* ---------- Settings ---------- */
const $ = (id) => document.getElementById(id);

// Every simple setting is <input id="set-<key>">; the type says how to read it.
const FIELDS = {
  uiTheme: 'enum', uiLayout: 'enum', uiDensity: 'enum', uiStartView: 'enum',
  uiReduceMotion: 'bool', uiVideoPreview: 'bool', uiShowCaptions: 'bool',
  captureImages: 'bool', captureVideos: 'bool', captureVoice: 'bool', captureAudio: 'bool',
  captureDocuments: 'bool', captureStickers: 'bool',
  captureSent: 'bool', captureReceived: 'bool', captureGroups: 'bool', captureConversations: 'bool',
  mirrorImages: 'bool', startWithWindows: 'bool', startMinimized: 'bool', closeToTray: 'bool',
  notifyOnProblem: 'bool', autoUpdate: 'bool',
  mediaRoot: 'text', cloudRoot: 'text', excludedChats: 'lines',
  port: 'int', downloadTimeoutSec: 'int', logMaxMB: 'int',
  autoImportHours: 'int',
  aiEnabled: 'bool', aiConsent: 'bool', aiAnalyseImages: 'bool', aiAnalyseChats: 'bool',
  aiAnalyseVideos: 'bool', aiAnalyseDocuments: 'bool', aiVideoFrames: 'int', aiDocumentPages: 'int', aiOcrPages: 'int', aiResumeOnLaunch: 'bool', performanceMode: 'enum',
  aiTranscribeAudio: 'bool', aiTopics: 'bool', aiEmbeddings: 'bool', aiFinals: 'bool',
  aiProvider: 'text', aiModel: 'text', aiBaseUrl: 'text', aiMode: 'text', aiMonthlyBudget: 'int',
  chatgptEnabled: 'bool', chatgptScanHours: 'int', chatgptUploads: 'bool', chatgptGenerated: 'bool', chatgptSearchChats: 'bool',
  geminiEnabled: 'bool', geminiScanHours: 'int',
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
  // A <select> filled from the network is empty until that answer arrives.
  // Saving in the meantime read '' off it and stored that — and an empty
  // aiProvider is not a harmless blank: the runner falls back to a different
  // preset than the one the model name belongs to, so every request goes to
  // the wrong endpoint and the whole library fails to sort, silently. An
  // unpopulated control has no opinion, so it says nothing rather than ''.
  if (el.tagName === 'SELECT' && el.options.length === 0) return undefined;
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

let settingsOpener = null;
function openSettings() { if (!S.modal.classList.contains('hidden')) return; settingsOpener = document.activeElement; S.modal.classList.remove('hidden'); S.close.focus(); loadSettings(); if (typeof SourceCards !== 'undefined') SourceCards.forEach((c) => c.start()); if (typeof fillSourceWhere === 'function') fillSourceWhere(); }
function closeSettings() { S.modal.classList.add('hidden'); if (typeof SourceCards !== 'undefined') SourceCards.forEach((c) => c.stop()); const opener = settingsOpener; requestAnimationFrame(() => { if (opener?.isConnected && document.activeElement === document.body) opener.focus(); }); }
function openSettingsTab(name) {
  openSettings();
  const button = document.querySelector('#settabs [data-t="' + name + '"]');
  if (button) button.click();
}
S.modal.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const items = [...S.modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length);
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
S.open.addEventListener('click', openSettings);
S.close.addEventListener('click', closeSettings);

// A switch or a menu applies the moment it is set, and says so; the footer
// Save is for the things you type. Anything that is not a set-* field, or is
// typed, is left to Save — including a number typed into a box.
let savedFlash = null;
function flashSaved(text, failed = false) {
  if (!S.saveStatus) return;
  S.saveStatus.innerHTML = '<span class="' + (failed ? 'bad-text' : 'ok-text') + '">' + escapeHtml(text || 'Saved ✓') + '</span>';
  clearTimeout(savedFlash);
  if (!failed) savedFlash = setTimeout(() => { if (S.saveStatus) S.saveStatus.textContent = ''; }, 3500);
}
S.modal.addEventListener('change', async (e) => {
  const el = e.target;
  if (!el || !el.id || !el.id.startsWith('set-')) return;
  const key = el.id.slice(4);
  const type = FIELDS[key];
  if (!type) return;
  if (type === 'text' || type === 'lines') return;
  if (type === 'int' && el.tagName !== 'SELECT') return;
  const v = readField(key, type);
  if (v === undefined) return;
  try {
    if (key === 'startWithWindows' && bridge) await bridge.setStartup(v);
    const r = await requestJson('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: v }) });
    if (window.Workspace) window.Workspace.applyPreferences(r.settings);
    flashSaved(r && r.restartRequired ? 'Saved ✓ — applies after a restart' : 'Saved ✓');
  } catch (err) { if (key.startsWith('ui') && window.Workspace) window.Workspace.applyPreferences({}); flashSaved('Could not save: ' + err.message, true); }
});
S.modal.addEventListener('click', (e) => { if (e.target === S.modal) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !S.modal.classList.contains('hidden')) closeSettings(); });

S.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...S.tabs.children].forEach((c) => c.classList.toggle('active', c === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.t));
  S.save.classList.toggle('hidden', b.dataset.t === 'appearance');
  document.getElementById('appearance-save-hint').classList.toggle('hidden', b.dataset.t !== 'appearance');
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
    if (window.Workspace) window.Workspace.applyPreferences(d.settings);
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
      ['WhatsApp link', p.auth], ['ChatGPT sign-in', p.chatgptProfile || '—'], ['Gemini sign-in', p.geminiProfile || '—'],
      ['Cloud copies', p.cloudImages ? p.cloudImages + '  and  ' + p.cloudVideos : 'no cloud folder set'],
      ['Dashboard address', 'http://localhost:' + d.port],
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
    let src = null;
    try { src = await (await fetch('/api/sources/summary')).json(); } catch (e) {}
    const per = (k, label) => src && src[k] ? [label, `${fmtBytes(src[k].bytes)} · ${src[k].count} photos`] : null;
    S.storage.innerHTML = [
      ['Images', `${fmtBytes(s.images.bytes)} · ${s.images.files} files`],
      per('whatsapp', '   from WhatsApp'), per('chatgpt', '   from ChatGPT'), per('gemini', '   from Gemini'),
      ['Videos', `${fmtBytes(s.videos.bytes)} · ${s.videos.files} files${s.videos.cloud ? ' (cloud folder)' : ''}`],
      ['Voice, audio, documents', `${fmtBytes(s.files.bytes)} · ${s.files.files} files`],
      ['Messages & index', fmtBytes(s.data.bytes)],
      ['Total', fmtBytes(s.total)],
    ].filter(Boolean).map(([k, v]) => `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v)}</td></tr>`).join('');
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
    const r = await requestJson('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    S.saveStatus.innerHTML = '<span class="ok-text">Saved ✓</span>';
    S.restartNote.textContent = r.restartRequired
      ? 'Some changes (folders, port, timeouts) apply after a restart — use “Restart capture” on the App tab.'
      : '';
    setTimeout(() => { S.saveStatus.textContent = ''; }, 2500);
  } catch (e) { flashSaved('Could not save: ' + e.message, true); }
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

/* ---------- Catching up and names ---------- */
(function bindSyncButtons() {
  const cu = $('btn-catchup'), sc = $('btn-sync-contacts'), out = $('sync-status');
  if (!cu || !sc) return;
  cu.addEventListener('click', async () => {
    cu.disabled = true; out.textContent = 'Checking every chat that moved…';
    try {
      const r = await requestJson('/api/chats/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      out.textContent = r.ok ? `${r.chats} chats checked — ${r.newMessages || 0} messages and ${r.newMedia || 0} files were missing and are now saved.` : (r.error || 'Could not catch up');
      if (r.ok && (r.newMessages || r.newMedia)) loadItems(true);
    } catch (e) { out.textContent = e.message; }
    cu.disabled = false;
  });
  sc.addEventListener('click', async () => {
    sc.disabled = true; out.textContent = 'Reading the address book from the phone…';
    try {
      const r = await requestJson('/api/contacts/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      out.textContent = r.ok ? `${r.names} names on file. Chats and group messages now show them.` : (r.error || 'Could not read the address book');
      if (r.ok && currentView === 'convo') Convo.refreshChats();
    } catch (e) { out.textContent = e.message; }
    sc.disabled = false;
  });
})();

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
    S.health.innerHTML = h.ok && s.status === 'ready'
      ? `Downloads working${h.lastCaptureAt ? ' · last saved ' + new Date(h.lastCaptureAt).toLocaleString() : ''}`
      : h.ok ? 'Capture is waiting for WhatsApp to connect. Saved files remain available.' : `<span class="bad-text">${h.consecutiveFailures} downloads failed in a row${h.lastError ? ' — ' + escapeHtml(h.lastError) : ''}</span>`;
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
  try { d = await requestJson('/api/settings'); } catch (e) { return; }
  if (d.settings.setupComplete) return;

  if (bridge) appInfo = appInfo || await bridge.info();
  $('wz-default-path').textContent = appInfo ? appInfo.paths.mediaRoot : '';

  WZ.show('welcome');

  $('wz-consent').addEventListener('change', (e) => { $('wz-consent-next').disabled = !e.target.checked; });
  $('wz-consent-next').addEventListener('click', async () => {
    if (!await saveWizard({ consentAccepted: true })) return;
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
    if (!await saveWizard({ mediaRoot: dir })) return;
    WZ.show('cloud');
  });

  $('wz-browse-cloud').addEventListener('click', async () => {
    if (!bridge) return;
    const dir = await bridge.pickFolder({ title: 'Choose your cloud folder' });
    if (dir) $('wz-cloud-root').value = dir;
  });
  $('wz-cloud-skip').addEventListener('click', async () => { if (await saveWizard({ cloudRoot: '', mirrorImages: false })) WZ.show('startup'); });
  $('wz-cloud-next').addEventListener('click', async () => {
    const dir = $('wz-cloud-root').value.trim();
    if (dir) {
      const r = await (await fetch('/api/check-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json();
      if (!r.writable) { $('wz-cloud-status').innerHTML = `<span class="bad-text">${escapeHtml(r.message)}</span>`; return; }
    }
    if (!await saveWizard({ cloudRoot: dir, mirrorImages: $('wz-mirror').checked })) return;
    WZ.show('startup');
  });

  $('wz-finish').addEventListener('click', async () => {
    const startup = $('wz-startup').checked;
    if (bridge) await bridge.setStartup(startup);
    if (!await saveWizard({
      startWithWindows: startup,
      captureConversations: $('wz-convos').checked,
      setupComplete: true,
    })) return;
    WZ.done();
    if (bridge) bridge.restart();     // folders only take effect on a fresh start
  });
}

async function saveWizard(patch) {
  try {
    await requestJson('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    $('wizard-error').textContent = '';
    return true;
  } catch (e) { $('wizard-error').textContent = 'Could not save this step: ' + e.message; return false; }
}
/* ---------- Open one media item in the lightbox (from a message bubble) ---------- */
function openSingleMedia(serve, kind) {
  lightboxOpener = document.activeElement;
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
  els.lbClose.focus();
}

/* ---------- View switching (Media / Conversations) ---------- */
const V = {
  media: document.getElementById('view-media'),
  convo: document.getElementById('view-convo'),
  toggle: document.getElementById('viewtoggle'),
};
let currentView = 'media';
V.toggle.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { if (b.dataset.v === 'media' && F.favorite) { F.favorite = false; render(allItems); } setView(b.dataset.v); } });
function setView(v) {
  currentView = v;
  [...V.toggle.children].forEach((c) => { c.classList.toggle('active', c.dataset.v === v); c.setAttribute('aria-pressed', String(c.dataset.v === v)); });
  for (const name of ['overview', 'cleanup', 'status', 'search', 'topics', 'finals']) {
    const el = document.getElementById('view-' + name);
    if (el) el.classList.toggle('hidden', v !== name);
  }
  V.media.classList.toggle('hidden', v !== 'media');
  V.convo.classList.toggle('hidden', v !== 'convo');
  if (v === 'media') fillViewport();
  if (v === 'convo') Convo.enter();
  if (v === 'status' && typeof StatusView !== 'undefined') StatusView.enter();
  if (v === 'overview' && typeof Overview !== 'undefined') Overview.enter();
  if (v === 'overview' && typeof SourceOverview !== 'undefined') SourceOverview.refresh();
  if (v === 'cleanup' && typeof Cleanup !== 'undefined') Cleanup.enter();
  if (v === 'topics' && typeof Topics !== 'undefined') Topics.enter();
  if (v === 'finals' && typeof Finals !== 'undefined') Finals.enter();
  if (v === 'search' && typeof Search !== 'undefined') Search.enter();
  if (window.Workspace) window.Workspace.onView(v);
  try { document.getElementById('workspace-content').scrollTo({ top: 0 }); window.scrollTo({ top: 0 }); } catch (_) {}
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
  const TYPE_LABEL = { ptt: '🎤 voice note', audio: '🎵 audio', document: '📄 document', sticker: '🌟 sticker', location: '📍 location', vcard: '👤 contact', multi_vcard: '👤 contacts', call_log: '📞 call' };
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

  // The list has one state — which project, which order — read by the chips
  // and the select alike. The project sort is the grouped list with headings;
  // the others are flat.
  let project = '';
  let sort = 'project';
  let lastChats = [];
  const projectOf = (id) => (typeof AI !== 'undefined' && AI.chatLabelFor(id)) || null;

  function renderProjectChips() {
    const row = document.getElementById('convo-projects');
    if (!row) return;
    const groups = (typeof AI !== 'undefined' && AI.chatGroups()) || [];
    if (!groups.length) { row.innerHTML = ''; return; }
    const chip = (id, label) => '<button class="chip' + (project === id ? ' active' : '') + '" data-project="' + escapeHtml(id) + '">' + escapeHtml(label) + '</button>';
    row.innerHTML = chip('', 'All') + groups.map((g) => chip(g.id, (g.emoji ? g.emoji + ' ' : '') + g.name)).join('');
  }
  const chipsRow = document.getElementById('convo-projects');
  if (chipsRow) chipsRow.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-project]'); if (!b) return;
    project = b.dataset.project || '';
    renderProjectChips();
    renderChats(lastChats);
  });
  const sortSel = document.getElementById('convo-sort');
  if (sortSel) sortSel.addEventListener('change', () => { sort = sortSel.value; renderChats(lastChats); });

  // Opening a project from the Overview picks its chip rather than typing
  // its name into the search box.
  function setProject(id) {
    project = id || '';
    if (sortSel && sort !== 'project' && project) { sort = 'project'; sortSel.value = 'project'; }
    renderProjectChips();
    renderChats(lastChats);
  }

  function renderChats(chats) {
    lastChats = chats;
    renderProjectChips();
    if (!chats.length) { chatsEl.innerHTML = '<div class="convo-empty empty-state">No conversations saved yet. In Settings → What to save, turn on “Store message text”, then Settings → Import older.</div>'; return; }
    chatsEl.innerHTML = '';
    let list = chats.slice();
    if (project) list = list.filter((c) => { const p = projectOf(c.chatId); return p && p.groupId === project; });
    const hasProjects = list.some((c) => projectOf(c.chatId) && projectOf(c.chatId).groupName);
    const grouped = sort === 'project' && hasProjects;
    if (grouped) {
      list.sort((a, b) => {
        const pa = projectOf(a.chatId), pb = projectOf(b.chatId);
        const na = (pa && pa.groupName) || '￿', nb = (pb && pb.groupName) || '￿';
        return na === nb ? (b.lastTs || 0) - (a.lastTs || 0) : na.localeCompare(nb);
      });
    } else if (sort === 'name') {
      list.sort((a, b) => String(a.chatName || a.chatId).localeCompare(String(b.chatName || b.chatId)));
    } else {
      list.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    }
    if (!list.length) { chatsEl.innerHTML = '<div class="convo-empty empty-state">No conversations in this project yet.</div>'; return; }
    let lastProject = null;
    for (const c of list) {
      if (grouped) {
        const p = projectOf(c.chatId);
        const name = (p && p.groupName) || 'No project yet';
        if (name !== lastProject) {
          lastProject = name;
          const h = document.createElement('div');
          h.className = 'projecthead';
          h.textContent = ((p && p.groupEmoji) ? p.groupEmoji + ' ' : '') + name;
          chatsEl.appendChild(h);
        }
      }
      const el = document.createElement('div');
      el.className = 'chatitem' + (activeChat && activeChat.chatId === c.chatId ? ' active' : '') + (c.empty ? ' empty' : '');
      el.dataset.chat = c.chatId;
      const last = c.empty ? 'Known to WhatsApp — nothing saved yet. Open it and press Sync.' : (c.lastType && c.lastType !== 'chat' && !c.lastBody) ? '[' + c.lastType + ']' : (c.lastBody || '');
      const behind = c.behind && !c.empty ? '<span class="ci-behind" title="WhatsApp has newer messages than are saved here; the next catch-up brings them in">↻</span>' : '';
      el.innerHTML = `<div class="ci-top"><span class="ci-name">${escapeHtml(c.chatName || c.chatId)}${behind}</span><span class="ci-time">${c.lastTs ? shortDay(c.lastTs) : ''}</span></div>
        <div class="ci-last">${c.lastFromMe && !c.empty ? 'You: ' : ''}${escapeHtml(last).slice(0, 90)}</div>`;
      el.addEventListener('click', () => openChat(c));
      el.tabIndex = 0; el.setAttribute('role', 'button');
      el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } });
      chatsEl.appendChild(el);
    }
  }

  async function fetchThread(chatId, before, beforeId) {
    const url = '/api/thread?chat=' + encodeURIComponent(chatId)
      + (before ? '&before=' + before + '&beforeId=' + encodeURIComponent(beforeId || '') : '') + '&limit=200';
    try { return await (await fetch(url)).json(); } catch (e) { return []; }
  }

  let chatRequest = 0;
  // The head of a thread: the name, a Sync button that pulls this chat's recent
  // messages from WhatsApp now, and the topics the AI found in it.
  function renderHead(c, extra) {
    headEl.innerHTML = `<span class="th-name">${escapeHtml(activeChat.chatName)}</span>
      <span class="th-tools"><span class="th-sync" id="th-sync"></span><button class="btn small" id="th-sync-btn" title="Pull this chat's recent messages and media from WhatsApp now">↻ Sync</button></span>`;
    if (extra) headEl.querySelector('.th-tools').prepend(extra);
    const b = document.getElementById('th-sync-btn');
    const out = document.getElementById('th-sync');
    if (b) b.addEventListener('click', async () => {
      b.disabled = true; out.textContent = 'syncing…';
      try {
        const r = await requestJson('/api/chats/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: c.chatId, limit: 300 }) });
        out.textContent = r.ok ? `${r.newMessages || 0} new messages, ${r.newMedia || 0} new files` : (r.error || 'could not sync');
        if (r.ok && (r.newMessages || r.newMedia)) { openChat(c); loadChats(); if (typeof loadItems === 'function') loadItems(true); }
      } catch (e) { out.textContent = e.message; }
      b.disabled = false;
    });
    renderThreadTopics(c.chatId);
  }

  // The topics the AI found in this chat, as chips that jump to them.
  async function renderThreadTopics(chatId) {
    const bar = document.getElementById('thread-topics');
    if (!bar) return;
    bar.classList.add('hidden'); bar.innerHTML = '';
    let t = null;
    try { t = await requestJson('/api/topics?chat=' + encodeURIComponent(chatId)); } catch (_) { return; }
    if (!activeChat || activeChat.chatId !== chatId || !t || !t.topics.length) return;
    bar.innerHTML = '<span class="muted small" style="flex:0 0 auto;padding-top:3px">Topics:</span>' + t.topics.slice().reverse().map((x) => `<button class="chip" data-ts="${x.fromTs}" title="${escapeHtml(x.summary || '')}">${escapeHtml(x.title)}</button>`).join('');
    bar.classList.remove('hidden');
    bar.querySelectorAll('button[data-ts]').forEach((b) => b.addEventListener('click', () => openAt(chatId, parseInt(b.dataset.ts, 10), activeChat.chatName)));
  }

  async function openChat(c, match = null) {
    const ticket = ++chatRequest;
    activeChat = { chatId: c.chatId, chatName: c.chatName || c.chatId, focused: !!match };
    [...chatsEl.children].forEach((x) => x.classList.toggle('active', x.dataset.chat === c.chatId));
    let latest = null;
    if (match) { latest = document.createElement('button'); latest.className = 'btn small'; latest.textContent = 'Latest messages'; latest.onclick = () => openChat(c); }
    renderHead(c, latest);
    bodyEl.innerHTML = '<div class="convo-empty">Loading…</div>';
    oldestTs = null; oldestId = null; newestTs = 0; seenIds.clear();
    const rows = await fetchThread(c.chatId, match?.ts || null, match?.id);
    if (ticket !== chatRequest) return;
    if (match) rows.push(match);
    bodyEl.innerHTML = '';
    if (!rows.length) { bodyEl.innerHTML = '<div class="convo-empty">No messages stored for this chat yet. Press ↻ Sync to fetch what WhatsApp still has.</div>'; return; }
    oldestTs = rows[0].ts; oldestId = rows[0].id; newestTs = rows[rows.length - 1].ts;
    for (const r of rows) seenIds.add(r.id);
    canLoadOlder = rows.length >= 200;
    bodyEl.appendChild(buildBubbles(rows));
    bodyEl.scrollTop = bodyEl.scrollHeight;
    if (match) { const found = [...bodyEl.children].find(el => el.dataset.messageId === match.id); found?.classList.add('search-hit'); found?.scrollIntoView({ block: 'center' }); }
  }

  // Open a chat at a moment in it — a topic's start, a search hit — with the
  // messages before and after, and the one at that moment marked.
  async function openAt(chatId, ts, chatName) {
    const ticket = ++chatRequest;
    const name = chatName || (lastChats.find((x) => x.chatId === chatId) || {}).chatName || chatId;
    activeChat = { chatId, chatName: name, focused: true };
    [...chatsEl.children].forEach((x) => x.classList.toggle('active', x.dataset.chat === chatId));
    const latest = document.createElement('button'); latest.className = 'btn small'; latest.textContent = 'Latest messages'; latest.onclick = () => openChat({ chatId, chatName: name });
    renderHead({ chatId, chatName: name }, latest);
    bodyEl.innerHTML = '<div class="convo-empty">Loading…</div>';
    oldestTs = null; oldestId = null; newestTs = 0; seenIds.clear();
    const before = await fetchThread(chatId, ts + 1000, '￿');
    let after = [];
    try { after = await (await fetch('/api/thread?chat=' + encodeURIComponent(chatId) + '&after=' + ts + '&limit=120')).json(); } catch (_) {}
    if (ticket !== chatRequest) return;
    const ids = new Set(before.map((r) => r.id));
    const rows = before.concat(after.filter((r) => !ids.has(r.id)));
    bodyEl.innerHTML = '';
    if (!rows.length) { bodyEl.innerHTML = '<div class="convo-empty">No messages stored for this chat.</div>'; return; }
    oldestTs = rows[0].ts; oldestId = rows[0].id; newestTs = rows[rows.length - 1].ts;
    for (const r of rows) seenIds.add(r.id);
    canLoadOlder = before.length >= 200;
    bodyEl.appendChild(buildBubbles(rows));
    const target = [...bodyEl.querySelectorAll('.bubble')].find((b) => parseInt(b.dataset.ts, 10) >= ts) || bodyEl.querySelector('.bubble:last-child');
    if (target) { target.classList.add('hl'); target.scrollIntoView({ block: 'center' }); setTimeout(() => target.classList.remove('hl'), 4000); }
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
      b.dataset.messageId = m.id;
      b.dataset.ts = m.ts;
      let media = '';
      const mediaId = m.mediaId || m.id;
      if (m.mediaServe && m.mediaKind === 'image') media = `<div class="b-media"><img loading="lazy" src="/api/thumbnail/${encodeURIComponent(mediaId)}" onerror="if(!this.dataset.full){this.dataset.full='1';this.src='${m.mediaServe}'}else{this.classList.add('imgerr')}"></div>`;
      else if (m.mediaServe && m.mediaKind === 'video') media = `<div class="b-mediatag">▶ video</div>`;
      else if (m.mediaServe && (m.mediaKind === 'voice' || m.mediaKind === 'audio')) media = `<div class="b-mediatag">${m.mediaKind === 'voice' ? '🎤 voice note' : '🎵 audio'}</div>`;
      else if (m.mediaServe && m.mediaKind === 'document') media = `<div class="b-mediatag">📄 document</div>`;
      else if (m.mediaKind === 'image' || m.mediaKind === 'video') media = `<div class="b-mediatag">[${m.mediaKind} — not saved]</div>`;
      else if (m.type && m.type !== 'chat') media = `<div class="b-mediatag">${prettyType(m.type)}</div>`;
      // What the AI heard in a voice note, or read in a document, right under it.
      const lab = (m.mediaServe && typeof AI !== 'undefined') ? AI.labelFor(mediaId) : null;
      const ll = lab && lab.label;
      let extra = '';
      if (ll && ll.transcript) extra = `<div class="b-transcript">${escapeHtml(ll.transcript.slice(0, 400))}</div>`;
      else if (ll && m.mediaKind === 'document' && (ll.summary || (ll.title && ll.title !== (ll.caption || '')))) extra = `<div class="b-transcript">${escapeHtml(ll.title || '')}${ll.title && ll.summary ? ' — ' : ''}${escapeHtml(String(ll.summary || '').slice(0, 200))}</div>`;
      const author = (!m.fromMe && m.author && m.author !== 'me') ? `<div class="b-author">${escapeHtml(m.author)}</div>` : '';
      const rawCard = m.type === 'vcard' || m.type === 'multi_vcard';
      const text = (m.body && !rawCard) ? `<div class="b-text">${escapeHtml(m.body)}</div>` : '';
      const flags = (m.revoked ? '<div class="b-deleted">deleted on WhatsApp — kept here</div>' : '') + (m.edited ? '<div class="b-deleted">edited</div>' : '');
      b.innerHTML = `${author}${media}${text}${extra}${flags}<div class="b-meta">${fmtT(m.ts)}</div>`;
      if (m.mediaServe) {
        const mt = b.querySelector('.b-media, .b-mediatag');
        if (mt) mt.addEventListener('click', () => openSingleMedia(m.mediaServe, m.mediaKind));
      }
      frag.appendChild(b);
    }
    return frag;
  }

  async function pollActive() {
    if (currentView !== 'convo' || !activeChat || activeChat.focused || searchMode) return;
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
        el.tabIndex = 0; el.setAttribute('role', 'button');
        el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } });
        chatsEl.appendChild(el);
      }
    }

    if (res.length) {
      const head = document.createElement('div');
      head.className = 'projecthead';
      head.textContent = 'Messages with these words (' + res.length + ')';
      chatsEl.appendChild(head);
      for (const m of res) {
        const el = document.createElement('div');
        el.className = 'chatitem';
        el.innerHTML = '<div class="ci-top"><span class="ci-name">' + escapeHtml(m.chatName || m.chatId) + '</span>'
          + '<span class="ci-time">' + shortDay(m.ts) + '</span></div>'
          + '<div class="ci-last">' + escapeHtml((m.body || '').slice(0, 100)) + '</div>';
        el.addEventListener('click', () => { searchEl.value = ''; searchMode = false; openChat({ chatId: m.chatId, chatName: m.chatName }, m); loadChats(); });
        el.tabIndex = 0; el.setAttribute('role', 'button');
        el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } });
        chatsEl.appendChild(el);
      }
    }
  }

  bodyEl.addEventListener('scroll', () => { if (bodyEl.scrollTop < 60) loadOlder(); });

  return { enter, pollActive, refreshChats, setProject, openChat, openAt };
})();


/* ---------- AI sorting ---------- */
const AI = (function () {
  const state = { labels: new Map(), groups: [], chatGroups: new Map(), status: null, presets: [] };
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
    renderTagBar();
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
      `<button class="chip${(F.album || 'all') === id ? ' active' : ''}" data-album="${id}">${emoji ? escapeHtml(emoji) + ' ' : ''}${escapeHtml(name)}<span class="n">${count}</span></button>`;
    bar.innerHTML = chip('all', '', 'All', allItems.length)
      + state.groups.map((g) => chip(g.id, g.emoji, g.name, g.items.length)).join('')
      + (unsorted ? chip('unsorted', '', 'No album yet', unsorted) : '');
    bar.classList.remove('hidden');
  }

  // The tags the model reached for most, as one click each. The dropdown in
  // Filters holds all sixty; this is the handful worth seeing without opening
  // anything, and it is the same F.tag underneath, so the two stay in step.
  const tagBar = $$("tagbar");
  function renderTagBar() {
    if (!tagBar) return;
    const tags = tagCounts(2).slice(0, 14);
    if (!tags.length) { tagBar.classList.add("hidden"); return; }
    const cur = (typeof F !== "undefined" && F.tag) || "";
    tagBar.innerHTML = tags.map((x) =>
      '<button class="chip tag' + (cur === x.tag ? ' active' : '') + '" data-tag="' + escapeHtml(x.tag) + '">'
      + escapeHtml(x.tag) + '<span class="n">' + x.count + '</span></button>').join('')
      + (cur ? '<button class="chip clear" data-tag="">clear</button>' : '');
    tagBar.classList.remove("hidden");
  }

  if (tagBar) tagBar.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tag]");
    if (!b) return;
    const picked = b.dataset.tag;
    // Clicking the chip that is already on takes it off, which is what a
    // toggle looks like to anyone who did not read a manual.
    F.tag = (F.tag === picked) ? "" : picked;
    const sel = document.getElementById("f-tag");
    if (sel) sel.value = F.tag;
    renderTagBar();
    render(allItems);
  });

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-album]');
    if (!b) return;
    F.album = b.dataset.album === 'all' ? '' : b.dataset.album;
    const sel = fEl('f-album'); if (sel) sel.value = F.album === 'unsorted' ? '' : F.album;
    renderAlbumBar();
    render(allItems);
  });

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

  const labelCount = () => state.labels.size;

  // Opening an album from somewhere else has to go through the same state the
  // album bar uses, or the bar and the gallery disagree about what is showing.
  function selectAlbum(id) {
    F.album = !id || id === 'all' ? '' : id;
    const sel = fEl('f-album'); if (sel) sel.value = F.album === 'unsorted' ? '' : F.album;
    renderAlbumBar();
    render(allItems);
  }

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
      for (const k of ['aiTopics', 'aiEmbeddings', 'aiFinals']) { const el = $$('set-' + k); if (el) el.checked = s[k] !== false; }
      const ta = $$('set-aiTranscribeAudio'); if (ta) ta.checked = !!s.aiTranscribeAudio;
      $$('set-aiMonthlyBudget').value = s.aiMonthlyBudget != null ? s.aiMonthlyBudget : 5;
    } catch (e) {}
    onProviderChange();
    showSpend(st);
    showCapabilities(st);
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

  // Which provider in the chain hears and which one makes vectors — said in
  // words beside the switch that needs it, so a switch that cannot work yet
  // says what would make it work.
  function showCapabilities(st) {
    const cap = (st && st.capabilities) || {};
    const chain = (st && st.chain) || [];
    const a = $$('ai-audio-note');
    if (a) a.textContent = cap.audio
      ? `Voice notes are transcribed by ${cap.audioBy} (${(chain.find((c) => c.provider === cap.audioBy) || {}).audioModel || 'speech model'}), then summarised. Billed by the minute; free on Groq's daily allowance.`
      : 'No provider in your chain can transcribe. Add Groq (free) or OpenAI to the chain and this starts working.';
    const e = $$('ai-embed-note');
    if (e) e.textContent = cap.embeddings
      ? `Vectors come from ${cap.embeddingsBy}. "broken machine" then finds the photo labelled "oven with a faulty thermostat". Costs next to nothing.`
      : 'No provider in your chain makes embeddings. Add Gemini (free) or OpenAI to the chain for search by meaning; search by words works regardless.';
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
      const skipped = Object.entries(e.census.images.skipped || {}).concat(Object.entries((e.census.audio && e.census.audio.skipped) || {}));
      const parts = [];
      if (e.todo.images) parts.push(`${e.todo.images} photos`);
      if (e.todo.videos) parts.push(`${e.todo.videos} videos`);
      if (e.todo.documents) parts.push(`${e.todo.documents} documents`);
      if (e.todo.audio) parts.push(`${e.todo.audio} voice notes (${Math.max(1, Math.round((e.audioSeconds || 0) / 60))} min)`);
      if (e.todo.chats) parts.push(`${e.todo.chats} conversations`);
      if (e.todo.topicWindows) parts.push(`${e.todo.topicWindows} stretches of conversation for topics`);
      if (e.todo.embeddings) parts.push(`${e.todo.embeddings} items to embed`);
      if (e.todo.finals) parts.push(`${e.todo.finals} sets of versions to judge`);
      if (!parts.length) { el.innerHTML = '<span class="ok-text">Everything is already read and sorted.</span>'; return; }
      const cost = e.costKnown
        ? (e.cost < 0.01 ? 'under a cent' : '≈ $' + e.cost.toFixed(2))
        : 'an unknown amount (this model has no published price)';
      const audio = e.todo.audio ? (e.audioCost == null ? '' : e.audioCost < 0.01 ? ' Audio: under a cent.' : ` Audio: ≈ $${e.audioCost.toFixed(2)} on ${escapeHtml(e.audioBy || '')}.`) : (e.audioUnavailable ? ' <span class="warn-text">Voice notes wait for a provider that can transcribe.</span>' : '');
      el.innerHTML = `To do: ${parts.join(', ')} — ${cost} with ${escapeHtml(e.model)}.${audio}`
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
      aiAnalyseVideos: $$('set-aiAnalyseVideos').checked,
      aiAnalyseDocuments: $$('set-aiAnalyseDocuments').checked,
      aiVideoFrames: Number($$('set-aiVideoFrames').value),
      aiDocumentPages: Number($$('set-aiDocumentPages').value),
      aiOcrPages: Number($$('set-aiOcrPages').value),
      aiResumeOnLaunch: $$('set-aiResumeOnLaunch').checked,
      performanceMode: $$('set-performanceMode').value,
      aiMonthlyBudget: parseInt($$('set-aiMonthlyBudget').value, 10) || 0,
    };
    for (const k of ['aiTranscribeAudio', 'aiTopics', 'aiEmbeddings', 'aiFinals']) { const el = $$('set-' + k); if (el) body[k] = el.checked; }
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
        $$('ai-run-status').textContent = s.phase === 'waiting'
          ? `${s.message || 'Waiting for free AI quota.'} ${s.done} done so far.`
          : s.phase === 'arranging'
          ? `Working out the ${s.current || 'groups'}…`
          : s.phase === 'finals' ? 'Looking for versions of the same thing…'
          : `Looked at ${s.done} of ${total}${s.skipped ? `, skipped ${s.skipped}` : ''}${s.failed ? `, ${s.failed} failed` : ''}${spend}${s.current ? ' · ' + s.current : ''}`;
      } else {
        clearInterval(pollTimer); pollTimer = null;
        $$('ai-bar').style.width = '100%';
        $$('ai-run-status').innerHTML = s.error
          ? `<span class="bad-text">${escapeHtml(s.error)}</span>`
          : `<span class="ok-text">Done — ${escapeHtml(s.message || 'sorted')}${spend}</span>`;
        refreshEstimate();
        showSpend(s);
        loadLabels(); loadChatGroups();
        if (typeof Finals !== 'undefined') Finals.refreshMarks();
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
        '\n\nFor video indexing: sampled frames and their timestamps. For scanned documents: selected page images. For AI search: your query and matching saved descriptions. Text from ordinary documents stays local. Content itself can contain personal information.',
      ].join('');
    } catch (e) { el.textContent = 'Could not build the preview.'; }
  });
  $$('btn-ai-wipe').addEventListener('click', async () => {
    if (!confirm('Delete every AI label and album?\n\nYour photos, videos and messages are not touched. You can run the sorting again afterwards.')) return;
    await fetch('/api/ai/wipe', { method: 'POST' });
    state.labels = new Map(); state.groups = []; state.chatGroups = new Map();
    F.album = ''; renderAlbumBar(); render(allItems); refreshEstimate();
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
      const kind = r.kind === 'document' ? 'document' : r.kind === 'video' ? 'video' : 'image';
      await fetch('/api/ai/group/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, refId: r.id, groupId: sel.value || null }),
      });
      await loadLabels();
      render(allItems);
    });
  }

  return {
    loadLabels, loadChatGroups, ensureChatGroups, loadSettingsTab, refreshEstimate, matchesText, matchesChat,
    labelFor, chatLabelFor, renderAlbumBar, renderTagBar, saveAiSettings, albumPicker, bindAlbumPicker, tagCounts, hasTag, labelCount, selectAlbum,
    groups: () => state.groups,
    chatGroups, chatGroupIdForName,
  };
})();

/* ---------- Boot + polling ---------- */
maybeRunWizard();
loadState();
if (typeof bindFilters === 'function') bindFilters();
setInterval(() => { if (!document.hidden) loadState(); }, 5000);
setInterval(() => { if (!document.hidden && currentView === 'media') loadItems(false); }, 6000);
setInterval(() => { if (!document.hidden) Convo.pollActive(); }, 6000);
setInterval(() => { if (!document.hidden && currentView === 'convo') Convo.refreshChats(); }, 12000);
document.addEventListener('visibilitychange', () => { if (document.hidden) document.querySelectorAll('video,audio').forEach(media => media.pause()); else loadState(); });

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

// Which sources have anything to show. WhatsApp and ChatGPT are always
// offered; Gemini appears the moment its first picture arrives.
function visibleSources() {
  const have = new Set(allItems.map(srcOf));
  return SOURCES;
}
function renderSourceBar() {
  const counts = {};
  for (const r of allItems) counts[srcOf(r)] = (counts[srcOf(r)] || 0) + 1;
  const btn = (id, label, n) => '<button data-source="' + id + '"' + ((F.source || '') === id ? ' class="active"' : '') + '>' + escapeHtml(label) + '<span class="n">' + n + '</span></button>';
  const html = btn('', 'All', allItems.length) + visibleSources().map((s) => btn(s.id, s.glyph + ' ' + s.label, counts[s.id] || 0)).join('');
  for (const id of ['source', 'ov-sources']) { const el = fEl(id); if (el) el.innerHTML = html; }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#source button[data-source], #ov-sources button[data-source]');
  if (!b) return;
  F.source = b.dataset.source || '';
  renderSourceBar();
  render(allItems);
  if (typeof Overview !== 'undefined') Overview.render();
});

// Sort is never a filter: it changes the order, not what is shown.
function filtersActive() {
  return !!(F.favorite || F.q || F.source || F.kind || F.exact || F.dir || F.album || F.project || F.tag || F.backup || F.final || F.from || F.to);
}

// Everything the gallery can be narrowed by, one line each, so the bar above
// the gallery can say exactly what is in force and take any one of them off.
const ACTIVE_LABELS = {
  favorite: () => 'Favourites',
  q: (v) => '“' + v + '”',
  source: (v) => (SOURCES.find((s) => s.id === v) || { label: v }).label,
  kind: (v) => ({ photos: 'Photos', videos: 'Videos', files: 'Files' })[v] || v,
  exact: (v) => ({ image: 'Photos only', video: 'Videos only', sticker: 'Stickers', ptt: 'Voice notes', audio: 'Audio', document: 'Documents' })[v] || v,
  dir: (v) => v === 'in' ? 'Received' : 'Sent',
  album: (v) => v === 'unsorted' ? 'No album yet' : 'Album: ' + (((typeof AI !== 'undefined' && AI.groups()) || []).find((g) => g.id === v) || { name: v }).name,
  project: (v) => 'Project: ' + (((typeof AI !== 'undefined' && AI.chatGroups()) || []).find((g) => g.id === v) || { name: v }).name,
  tag: (v) => '#' + v,
  backup: (v) => v === 'local' ? 'On this PC only' : 'In cloud folder',
  final: (v) => v === 'kept' ? '★ Kept as final' : '✦ Has versions',
  from: (v) => 'From ' + v,
  to: (v) => 'To ' + v,
};
function renderActiveBar() {
  const bar = fEl('activebar');
  if (!bar) return;
  const chips = [];
  for (const k of Object.keys(ACTIVE_LABELS)) {
    if (!F[k]) continue;
    chips.push('<button class="chip active" data-clear="' + k + '">' + escapeHtml(ACTIVE_LABELS[k](F[k])) + '<span class="x">×</span></button>');
  }
  if (!chips.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = chips.join('')
    + '<button class="chip clear" data-clear="*">Clear all</button>'
    + '<span class="count">showing ' + filteredCache.length + ' of ' + allItems.length + '</span>';
}
function clearAll() {
  Object.assign(F, { q: '', contentScope: 'all', source: '', kind: '', exact: '', dir: '', album: '', project: '', tag: '', backup: '', from: '', to: '', favorite: false });
  if (fEl('content-scope')) fEl('content-scope').value = 'all';
  if (window.ContentSearch) window.ContentSearch.query('');
  if (els.search) els.search.value = '';
  F.final = '';
  for (const id of ['f-exact', 'f-dir', 'f-album', 'f-project', 'f-tag', 'f-backup', 'f-final', 'f-from', 'f-to']) { const e = fEl(id); if (e) e.value = ''; }
  syncKindUi();
  if (typeof renderSourceBar === 'function') renderSourceBar();
  if (typeof AI !== 'undefined') { AI.renderAlbumBar(); AI.renderTagBar(); }
  render(allItems);
}
function clearOne(k) {
  if (k === '*') return clearAll();
  F[k] = '';
  if (k === 'q' && els.search) { els.search.value = ''; if (window.ContentSearch) window.ContentSearch.query(''); }
  const ids = { exact: 'f-exact', dir: 'f-dir', album: 'f-album', project: 'f-project', tag: 'f-tag', backup: 'f-backup', final: 'f-final', from: 'f-from', to: 'f-to' };
  if (ids[k]) { const e = fEl(ids[k]); if (e) e.value = ''; }
  if (k === 'kind') syncKindUi();
  if (k === 'source' && typeof renderSourceBar === 'function') renderSourceBar();
  if (k === 'album' && typeof AI !== 'undefined') AI.renderAlbumBar();
  if (k === 'tag' && typeof AI !== 'undefined') AI.renderTagBar();
  render(allItems);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#activebar button[data-clear]');
  if (b) clearOne(b.dataset.clear);
});

// Applied after the tab strip and the search box have had their say.
function matchesAdvanced(r) {
  if (F.source && srcOf(r) !== F.source) return false;
  if (F.kind === 'photos' && !(r.kind === 'image' || r.kind === 'sticker')) return false;
  if (F.kind === 'videos' && r.kind !== 'video') return false;
  if (F.kind === 'files' && !FILE_KINDS.has(r.kind)) return false;
  if (F.exact && r.kind !== F.exact) return false;
  if (F.backup && typeof Backup !== 'undefined' && Backup.configured()) {
    const local = Backup.onlyHere().has(r.id);
    if (F.backup === 'local' ? !local : local) return false;
  }
  if (F.dir && r.dir !== F.dir) return false;
  if (F.from && r.ts < Date.parse(F.from + 'T00:00:00')) return false;
  if (F.to && r.ts > Date.parse(F.to + 'T23:59:59')) return false;
  if (F.album) {
    const g = (typeof AI !== 'undefined' && AI.labelFor(r.id)) || null;
    const inAlbum = g && g.groupId;
    if (F.album === 'unsorted' ? inAlbum : (!g || g.groupId !== F.album)) return false;
  }
  if (F.project) {
    // A media item belongs to a project through the chat it arrived in.
    const cg = typeof AI !== 'undefined' ? AI.chatGroupIdForName(r.chat) : null;
    if (cg !== F.project) return false;
  }
  if (F.tag && !(typeof AI !== 'undefined' && AI.hasTag(r.id, F.tag))) return false;
  if (F.final && typeof Finals !== 'undefined') {
    if (F.final === 'kept' && !Finals.isKept(r.id)) return false;
    if (F.final === 'suggested' && !Finals.isSuggested(r.id)) return false;
  }
  return true;
}

function sortRecords(list) {
  if (F.q && window.ContentSearch?.current(F.q) && F.sort === 'new') return list.sort((a, b) => window.ContentSearch.score(b.id) - window.ContentSearch.score(a.id) || b.ts - a.ts);
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
  wire('f-exact', 'exact'); wire('f-backup', 'backup'); wire('f-dir', 'dir'); wire('f-album', 'album'); wire('f-final', 'final');
  wire('f-project', 'project'); wire('f-from', 'from'); wire('f-to', 'to');
  const albSel = fEl('f-album');
  if (albSel) albSel.addEventListener('change', () => { F.album = albSel.value; if (typeof AI !== 'undefined') AI.renderAlbumBar(); render(allItems); });
  const tagSel = fEl('f-tag');
  if (tagSel) tagSel.addEventListener('change', () => {
    F.tag = tagSel.value;
    if (typeof AI !== 'undefined' && AI.renderTagBar) AI.renderTagBar();
    render(allItems);
  });
  wire('f-sort', 'sort');
  // Clearing lives in the active bar above the gallery now (clearAll).
}

// "Showing 12 of 431" only when something is actually narrowing the view —
// otherwise it is noise restating the count already in the header.
function updateFilterCount() {
  renderActiveBar();
  const open = fEl('filters-open');
  if (open) open.classList.toggle('on', !!(F.exact || F.dir || F.album || F.project || F.tag || F.backup || F.final || F.from || F.to));
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
  if (u.status === 'installing') return `Installing ${u.version}… The app will reopen automatically.`;
  if (u.status === 'error') return 'Could not check for updates: ' + (u.error || 'unknown');
  if (u.status === 'current' && u.latestVersion && u.latestVersion !== u.current) return `Installed: ${u.current}. Latest release: ${u.latestVersion}. No compatible update is available.`;
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
  const checked = document.getElementById('update-checked-at');
  if (checked) checked.textContent = u.checkedAt ? 'Last successful check: ' + new Date(u.checkedAt).toLocaleString() : 'No successful update check yet.';
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
        await refreshUpdateStatus();
      }
      return;
    }
    openSettings();
    const tab = [...document.querySelectorAll('#settabs button')].find((b) => b.dataset.t === 'app');
    if (tab) tab.click();
  });
  const install = document.getElementById('btn-install-update');
  if (install) install.addEventListener('click', async () => {
    if (bridge && bridge.installUpdate) { await bridge.installUpdate(); await refreshUpdateStatus(); }
  });
  refreshUpdateStatus();
  setInterval(refreshUpdateStatus, 15000);

  // One button in the header does the whole thing: asks, says what it found,
  // and installs from here. States are read from the shell, so what it says
  // is what the updater is doing.
  const ub = document.getElementById('update-btn');
  const settingsCheck = document.getElementById('btn-check-updates');
  if (ub) {
    let watching = null;
    const paint = (u) => {
      if (!u) return;
      const busy = ['checking', 'downloading', 'installing'].includes(u.status);
      for (const button of [ub, settingsCheck].filter(Boolean)) {
        button.classList.toggle('busy', busy);
        button.classList.toggle('ready', u.status === 'ready');
        button.disabled = busy || !u.packaged;
        button.title = describeUpdate(u);
        button.setAttribute('aria-busy', String(busy));
        if (!u.packaged) button.textContent = 'Desktop app updates';
        else if (u.status === 'checking') button.textContent = 'Checking…';
        else if (u.status === 'downloading') button.textContent = 'Downloading ' + (u.percent || 0) + '%';
        else if (u.status === 'installing') button.textContent = 'Installing…';
        else if (u.status === 'ready') button.textContent = 'Install ' + u.version + ' and restart';
        else if (u.status === 'error') button.textContent = 'Retry update check';
        else if (u.status === 'current' && (!u.latestVersion || u.latestVersion === u.current) && u.checkedAt && Date.now() - u.checkedAt < 60000) button.textContent = 'Up to date · v' + u.current;
        else button.textContent = 'Check for updates';
      }
    };
    const poll = async () => {
      if (!bridge || !bridge.updateStatus) return;
      let u = null; try { u = await bridge.updateStatus(); } catch (e) { return; }
      paint(u);
      await refreshUpdateStatus();
      if (u && (u.status === 'checking' || u.status === 'downloading')) { clearTimeout(watching); watching = setTimeout(poll, 1500); }
    };
    const checkOrInstall = async () => {
      if (!bridge) { alert('Open the WhatsBackUp window to check for updates.'); return; }
      let u = null; try { u = await bridge.updateStatus(); } catch (e) {}
      if (u && u.status === 'ready' && bridge.installUpdate) {
        if (confirm('Install ' + u.version + ' now?' + String.fromCharCode(10, 10) + 'The app closes and reopens. Capture resumes straight after.')) { await bridge.installUpdate(); await poll(); }
        return;
      }
      paint({ ...u, packaged: true, status: 'checking' });
      try { await bridge.checkUpdates(true); }
      catch (e) { paint({ ...u, packaged: true, status: 'error', error: e.message || 'The desktop updater did not respond.' }); return; }
      clearTimeout(watching);
      await poll();
    };
    ub.addEventListener('click', checkOrInstall);
    if (settingsCheck) settingsCheck.addEventListener('click', checkOrInstall);
    poll();
    setInterval(poll, 20000);
  }
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
    els2.postNow.textContent = sum.dryRun ? 'Test without posting' : 'Post now';
    els2.paused.checked = !!sum.paused;
    els2.folderLine.textContent = 'Drop folder: ' + sum.folder + ' — anything saved there becomes the next folder-post.';
    loadLimits();
  }

  /* ---- the limits ----
     The scheduler has always enforced these; they were only unreachable. A
     feature that posts publicly on the user's behalf should show its own
     brakes, so they are read straight from settings and written back on
     change rather than hidden behind the Settings modal. */
  const LIMITS = ["statusMaxPerDay", "statusMinGapMin", "statusCatchupMin",
    "statusQuietFrom", "statusQuietTo", "statusFolder", "statusFooter"];

  async function loadLimits() {
    let s = null;
    try { s = (await (await fetch("/api/settings")).json()).settings; } catch (e) { return; }
    for (const k of LIMITS) {
      const el = document.getElementById("set-" + k);
      if (el && s[k] !== undefined && s[k] !== null) el.value = s[k];
    }
  }

  for (const k of LIMITS) {
    const el = document.getElementById("set-" + k);
    if (!el) continue;
    el.addEventListener("change", async () => {
      const raw = el.value.trim();
      // A number field left empty would clear a limit rather than keep it, and
      // "no cap" is not a thing the scheduler offers. Put the old value back.
      if (el.type === "number" && raw === "") { loadLimits(); return; }
      const val = el.type === "number" ? parseInt(raw, 10) : raw;
      if (el.type === "number" && !Number.isFinite(val)) { loadLimits(); return; }
      const patch = {}; patch[k] = val;
      await saveSetting(patch);
      // Read back what was stored: the server clamps to its own range, and a
      // value silently corrected is worth seeing.
      loadLimits();
      refresh();
    });
  }

  /* ---- template swatches ---- */
  const TPLS = [['gradient', 'Green'], ['night', 'Night'], ['paper', 'Paper'], ['bold', 'Bold'], ['native', 'Plain text']];
  function renderTemplates() {
    els2.templates.innerHTML = TPLS.map(([id, label]) =>
      `<button type="button" class="st-tpl${template === id ? ' sel' : ''}" data-t="${id}" title="${label}" aria-pressed="${template === id}">${label}</button>`).join('');
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
      row.innerHTML = `<label class="row toggle" style="margin:0"><input type="checkbox" aria-label="Enable ${escapeHtml(slotWhen(s))} schedule" ${s.enabled ? 'checked' : ''}><span class="switch"></span></label>
        <span class="when">${slotWhen(s)}</span>
        <span class="src">${SRC[s.source] || s.source}${albumNote}</span>
        <span class="next">${s.enabled && s.next_run_at ? new Date(s.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        <button title="Remove" aria-label="Remove ${escapeHtml(slotWhen(s))} schedule">✕</button>`;
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

  // Every provider here hands out keys with a house prefix; none of them is a
  // model name. Used to keep a key out of the model box.
  const KEYISH = /^(sk-|gsk_|AIza[0-9A-Za-z_-]|xai-|nvapi-|hf_|Bearer )/i;
  const looksLikeKey = (v) => KEYISH.test(String(v || '').trim());
  // "until 09:00", "45 s", "until tomorrow 09:00" — and why.
  function restLabel(until, why) {
    const ms = until - Date.now();
    const when = ms < 120000 ? Math.max(1, Math.round(ms / 1000)) + ' s'
      : 'until ' + (new Date(until).toDateString() !== new Date().toDateString() ? 'tomorrow ' : '') + new Date(until).toTimeString().slice(0, 5);
    return 'resting ' + when + (why ? ' — ' + why : '');
  }
  // A model name that plainly belongs to another provider would fail every
  // call — the Anthropic row once held OpenRouter's "google/gemma-…:free".
  function foreignModelFor(who, m) {
    if (!m) return '';
    if (who === 'anthropic' && !/^claude/i.test(m)) return 'Anthropic models start with "claude" — for example claude-haiku-4-5.';
    if (who === 'gemini' && !/^(models\/)?(gemini|gemma|learnlm)/i.test(m)) return 'Gemini models start with "gemini" — for example gemini-2.5-flash.';
    if (who === 'openai' && /[/:]/.test(m)) return 'That looks like an OpenRouter model name; OpenAI models look like gpt-5-mini.';
    return '';
  }
  const lastProbe = {};                 // provider -> { ok, text } from "Test every provider"
  async function testAll(btn, out) {
    btn.disabled = true; out.textContent = 'Testing each provider with its own key…';
    try {
      const r = await requestJson('/api/ai/probe-chain', { method: 'POST' });
      for (const p of r.results || []) {
        if (p.missingKey) { lastProbe[p.provider] = { ok: false, text: 'No key yet — paste one in the box under this row.' }; continue; }
        if (p.allResting) { lastProbe[p.provider] = { ok: false, text: 'Every model is ' + restLabel(p.restingUntil, p.why) + '. It is used again then, by itself.' }; continue; }
        const ok = !!(p.reachable && p.reachable.ok);
        lastProbe[p.provider] = ok
          ? { ok: true, text: '✓ answers' + (p.vision && p.vision.ok ? ' and reads photos' : ' — but cannot read photos, so only conversations go to it') + ' (' + p.model + (p.fallback ? ', a spare model' : '') + ')' }
          : { ok: false, text: '✗ ' + (p.why ? p.why : (p.reachable && p.reachable.detail) || 'did not answer') + (p.restingUntil ? ' · ' + restLabel(p.restingUntil, '') : '') };
      }
      const good = (r.results || []).filter((p) => p.reachable && p.reachable.ok).length;
      out.textContent = good + ' of ' + (r.results || []).length + ' providers answered.';
    } catch (e) { out.textContent = 'Could not test: ' + e.message; }
    btn.disabled = false;
    refresh();
  }
  function say(where, text, bad) {
    let el = where.querySelector('.ck-msg');
    if (!el) {
      el = document.createElement('span');
      el.className = 'ck-msg';
      where.appendChild(el);
    }
    el.textContent = text;
    el.className = 'ck-msg' + (bad ? ' bad' : ' good');
  }

  async function refresh() {
    let st = null;
    try { st = await (await fetch('/api/ai/status')).json(); } catch (e) { return; }
    if (!presets.length) {
      try { presets = (await (await fetch('/api/ai/presets')).json()).presets || []; } catch (e) {}
    }
    const chain = st.chain || [];
    const box = document.getElementById('set-aiChainEnabled');
    if (box) box.checked = !!st.chainEnabled;

    list.innerHTML = chain.length ? '' : '<p class="muted small">Just the service above. Add a spare so organising carries on when it runs out.</p>';
    chain.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'chain-row';
      let tag = '<span class="st ready">ready</span>';
      if (c.keyRequired && !c.hasKey) tag = '<span class="st nokey">needs a key</span>';
      else if (c.needsModel) tag = '<span class="st nokey">needs a model</span>';
      else if (c.restingUntil) tag = `<span class="st resting" title="${escapeHtml(c.restWhy || '')}">${escapeHtml(restLabel(c.restingUntil, c.restWhy))}</span>`;
      else if (c.blind) tag = '<span class="st blind">can’t see photos</span>';
      const first = i === 0;
      const modelCell = c.editableModel
        ? `<input class="mdl chain-model" value="${escapeHtml(c.model || '')}" placeholder="model name for this provider" spellcheck="false">`
        : `<span class="mdl">${escapeHtml(c.model || '')}</span>`;
      row.innerHTML = `<span class="ord">${i + 1}</span>
        <span class="who">${escapeHtml(c.provider || '—')}</span>
        ${modelCell}
        ${tag}
        <button class="drop" title="${first ? 'The provider above — change it there' : 'Remove from the chain'}" ${first ? 'disabled style="opacity:.3;cursor:default"' : ''}>✕</button>`;
      const mi = row.querySelector('.chain-model');
      if (mi) mi.addEventListener('change', async () => {
        // This box is the model name. A key pasted here would be written to
        // settings.json in the clear and would never be used as a key, so it
        // is refused and the key box is opened instead.
        if (looksLikeKey(mi.value)) {
          mi.value = c.model || '';
          say(row, 'That is an API key, and this box is the model name. Put the key in the box below.', true);
          const box = row.nextElementSibling;
          if (box && box.classList.contains('chain-key-row')) box.querySelector('input').focus();
          return;
        }
        const foreign = foreignModelFor(c.provider, mi.value.trim());
        if (foreign) { mi.value = c.model || ''; say(row, foreign, true); return; }
        const s = await (await fetch('/api/settings')).json();
        const models = { ...(s.settings.aiChainModels || {}) };
        models[c.provider] = mi.value.trim();
        await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiChainModels: models }) });
        refresh();
      });
      if (!first) row.querySelector('button.drop').addEventListener('click', async () => {
        const s = await (await fetch('/api/settings')).json();
        const next = (s.settings.aiChain || []).filter((x) => x !== c.provider);
        await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiChain: next }) });
        refresh();
      });
      list.appendChild(row);
      const spares = (c.models || []).filter((m) => m.model !== c.model);
      if (spares.length) {
        const line = document.createElement('div');
        line.className = 'chain-models';
        line.innerHTML = '<span class="ord"></span><span>Also uses, when the first runs out: ' + spares.map((m) => escapeHtml(m.model) + (m.restingUntil ? ' <em title="' + escapeHtml(m.why) + '">(' + escapeHtml(restLabel(m.restingUntil, m.why)) + ')</em>' : '')).join(', ') + '</span>';
        list.appendChild(line);
      }
      const probe = lastProbe[c.provider];
      if (probe) {
        const line = document.createElement('div');
        line.className = 'chain-probe ' + (probe.ok ? 'ok' : 'bad');
        line.innerHTML = '<span class="ord"></span><span>' + escapeHtml(probe.text) + '</span>';
        list.appendChild(line);
      }

      // The key for this provider, asked for where the gap is. Saving it here
      // means never having to change the provider above and change it back.
      const keyTrouble = c.hasKey && c.restingUntil && /key was refused|no credit/i.test(c.restWhy || '');
      if (c.keyRequired && (!c.hasKey || keyTrouble)) {
        const kr = document.createElement('div');
        kr.className = 'chain-key-row';
        kr.innerHTML = `<span class="ord"></span>
          <input type="password" class="ck" placeholder="${keyTrouble ? 'paste a new ' + escapeHtml(c.provider) + ' key' : 'paste the ' + escapeHtml(c.provider) + ' key'}" autocomplete="off" spellcheck="false">
          <button class="btn small ck-save">Save key</button>
          <span class="ck-msg"></span>`;
        const input = kr.querySelector('input');
        const save = async () => {
          const v = input.value.trim();
          if (!v) return;
          if (!bridge) { say(kr, 'Keys can only be saved in the app itself.', true); return; }
          const r = await bridge.setAiKey(v, c.provider);
          input.value = '';
          if (r && r.ok) { say(kr, 'Saved, encrypted with your Windows account.'); refresh(); }
          else say(kr, (r && r.message) || 'Could not save the key', true);
        };
        kr.querySelector('.ck-save').addEventListener('click', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        list.appendChild(kr);
      }
    });

    // Offer only providers that aren't already in the chain.
    const inChain = new Set(chain.map((c) => c.provider));
    const offer = presets.filter((p) => !inChain.has(p.id) && p.id !== 'demo');
    pick.innerHTML = offer.length
      ? offer.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label || p.id)}</option>`).join('')
      : '<option value="">every provider is already in the chain</option>';
  }

  const testBtn = document.getElementById('btn-chain-test');
  if (testBtn) testBtn.addEventListener('click', () => testAll(testBtn, document.getElementById('chain-test-status')));

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


/* ---------- Backup: what is actually on pCloud ------------------------------
   The engine checks the cloud folder itself and says which items are not in
   it. This keeps that answer, marks the tiles, fills the card on the Overview,
   the pill in the header and the banner when the folder goes away. */
let lastStateSeen = null;
let reloadingAll = false;
const Backup = (function () {
  let st = null;                 // last /api/backup/status
  let statusError = false;
  let only = new Set();
  let dismissed = false, wasUp = null;
  const configured = () => !!(st && st.configured);
  const onlyHere = () => only;
  async function refresh() {
    try { st = await requestJson('/api/backup/status'); statusError = false; }
    catch (e) { statusError = true; renderPill(); if (typeof Overview !== 'undefined') Overview.renderBackup(); return; }
    const next = new Set(st.onlyHereIds || []);
    const changed = next.size !== only.size || [...next].some(id => !only.has(id));
    only = next;
    renderPill(); renderBanner();
    if (typeof Overview !== 'undefined') Overview.renderBackup();
    if (currentView === 'media' && changed) {
      if (F.backup) render(allItems);
      else document.querySelectorAll('#gallery .tile').forEach(tile => { const rec = allItems.find(item => item.id === tile.dataset.id); if(rec && window.Workspace) window.Workspace.decorateTile(tile, rec); });
    }
  }
  function noteState(s) { lastStateSeen = s; renderPill(); renderBanner(); }
  function describe() {
    if (statusError) return { state: 'warn', short: '☁ Backup unchecked', text: 'Backup status is unavailable. Restore the connection to the app, then check again.' };
    if (!st) return null;
    if (!st.configured) return { state: 'none', short: '☁ Local archive', text: 'Saved on this PC. Choose a cloud folder if you want a second copy of your media.' };
    if (!st.available) return { state: 'warn', short: '☁ Cloud folder offline', text: 'The cloud folder is unavailable. Copy counts are last known; reconnect the drive and check again.' };
    if (!st.total) return { state: 'none', short: '☁ Ready for media', text: 'Your cloud folder is ready. Import or capture some media to begin.' };
    if (st.onlyHere > 0) return { state: 'warn', short: '☁ ' + st.onlyHere + ' not backed up', text: st.onlyHere + ' item' + (st.onlyHere === 1 ? ' is' : 's are') + ' on this PC only.' };
    return { state: 'ok', short: '☁ Media copied', text: 'All archived media files are present with matching sizes in your cloud folder. Check your cloud app for upload completion. Messages remain on this PC.' };
  }
  function renderPill() {
    const p = fEl('cloud-pill'); if (!p) return;
    const d = describe();
    p.hidden = !d;
    if (!d) return;
    p.textContent = d.short;
    p.className = 'pill cloud ' + (d.state === 'ok' ? 'ok' : d.state === 'warn' ? 'warn' : '');
    p.title = d.text + ' Click for the Overview.';
  }
  function renderBanner() {
    const b = fEl('cloud-banner'); if (!b || !st) return;
    const down = st.configured && !st.available;
    if (down && wasUp !== false) dismissed = false;     // a fresh outage is said again
    wasUp = !down;
    b.classList.toggle('hidden', !down || dismissed);
    if (down) fEl('cloud-text').textContent = 'Your cloud folder ' + (st.root || '') + ' is not reachable. New photos and videos are being kept on this PC only.';
  }
  async function sweep() {
    try {
      const result = await requestJson('/api/backup/sweep', { method: 'POST' });
      if (result.failed) alert(result.failed + ' files could not be copied. Check the source and cloud folders, then try again.');
    } catch (e) { alert('Could not complete backup: ' + e.message); }
    await refresh();
  }
  // The pill goes to the items themselves when some are only here; to the
  // overview otherwise, where the whole picture is.
  const pill = fEl('cloud-pill'); if (pill) pill.addEventListener('click', () => {
    if (st && st.configured && st.onlyHere > 0) {
      clearAll(); F.backup = 'local'; const s = fEl('f-backup'); if (s) s.value = 'local';
      setView('media'); render(allItems);
    } else setView('overview');
  });
  const chk = fEl('cloud-check'); if (chk) chk.addEventListener('click', sweep);
  const dis = fEl('cloud-dismiss'); if (dis) dis.addEventListener('click', () => { dismissed = true; renderBanner(); });
  const cs = fEl('cloud-settings'); if (cs) cs.addEventListener('click', () => { openSettings(); const tab = document.querySelector('#settabs [data-t="storage"]'); if (tab) tab.click(); });
  setInterval(refresh, 60000);
  return { refresh, sweep, configured, onlyHere, describe, status: () => st, noteState };
})();

/* ---------- Overview -------------------------------------------------------
   The archive has been read and grouped; this is the one screen that says so.
   Everything here is what the model actually produced — no counts are made up
   and nothing is shown that has not been sorted yet. */
const Overview = (function () {
  const statsEl = $('ov-stats');
  const projEl = $('ov-projects');
  const albEl = $('ov-albums');
  const projCount = $('ov-proj-count');
  const albCount = $('ov-alb-count');
  if (!statsEl) return { enter() {} };

  let chats = [];
  let projects = [];
  let albums = [];
  let topicsList = [];
  let finalSets = [];
  let entered = false;

  // Sets with a suggestion, as cards that open the Finals view on that set.
  function renderFinals() {
    const el = $('ov-finals'), sec = $('ov-finals-sec'), count = $('ov-fin-count');
    if (!el) return;
    const sets = finalSets.filter((s) => s.status === 'suggested');
    if (sec) sec.classList.toggle('hidden', !sets.length);
    if (count) count.textContent = sets.length ? sets.length + ' to decide' : '';
    const nav = document.getElementById('nav-finals-count'); if (nav) nav.textContent = sets.length ? String(sets.length) : '';
    el.innerHTML = sets.slice(0, 6).map((s) => {
      const thumbs = s.members.slice(0, 5).map((m) => (m.kind === 'image' ? `<img src="/api/thumbnail/${encodeURIComponent(m.id)}" alt="" class="${m.id === s.suggestedId ? 'sug' : ''}">` : `<span>${m.kind === 'document' ? '📄' : '▶'}</span>`)).join('');
      return `<button class="ov-card" data-kind="final" data-id="${escapeHtml(s.id)}"><div class="ov-emoji">★</div><div class="ov-body"><div class="ov-name">${escapeHtml(s.chat || 'versions')} · ${s.members.length} versions</div><div class="ov-desc">${escapeHtml(s.reason || '')}</div><div class="ov-thumbs">${thumbs}</div></div><div class="ov-count">${Math.round((s.confidence || 0) * 100)}%</div></button>`;
    }).join('');
  }

  // The latest topics, as cards that open the conversation at that point.
  function renderTopics() {
    const el = $('ov-topics'), sec = $('ov-topics-sec'), count = $('ov-top-count');
    if (!el) return;
    if (sec) sec.classList.toggle('hidden', !topicsList.length);
    if (count) count.textContent = topicsList.length ? topicsList.length + ' found' : '';
    el.innerHTML = topicsList.slice(0, 8).map((t) => `<button class="ov-card" data-kind="topic" data-id="${escapeHtml(t.id)}"><div class="ov-emoji">${t.theme && t.theme.emoji ? escapeHtml(t.theme.emoji) : '💬'}</div><div class="ov-body"><div class="ov-name">${escapeHtml(t.title)}</div><div class="ov-desc">${escapeHtml(t.summary || '')}</div><div class="ov-foot">${escapeHtml(t.chatName || '')} · ${new Date(t.toTs).toLocaleDateString()}${t.decisions && t.decisions.length ? ' · ✓ ' + escapeHtml(t.decisions[0]) : ''}</div></div><div class="ov-count">${t.msgCount}</div></button>`).join('');
  }

  // The question box on the overview goes to the Search view's answer.
  (function bindAsk() {
    const q = $('ov-ask-q'), go = $('ov-ask-go');
    if (!q || !go) return;
    const run = () => { const v = q.value.trim(); if (!v) return; setView('search'); if (typeof Search !== 'undefined') Search.ask(v); };
    go.addEventListener('click', run);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  })();

  const card = (bits) =>
    '<button class="ov-card" data-kind="' + bits.kind + '" data-id="' + escapeHtml(bits.id) + '">'
    + '<div class="ov-emoji">' + (bits.emoji ? escapeHtml(bits.emoji) : '•') + '</div>'
    + '<div class="ov-body">'
    + '<div class="ov-name">' + escapeHtml(bits.name) + '</div>'
    + (bits.desc ? '<div class="ov-desc">' + escapeHtml(bits.desc) + '</div>' : '')
    + (bits.foot ? '<div class="ov-foot">' + bits.foot + '</div>' : '')
    + '</div>'
    + '<div class="ov-count">' + bits.count + '</div>'
    + '</button>';

  function renderBackup() {
    const el = $('ov-backup'); if (!el) return;
    const st = Backup.status();
    const d = Backup.describe();
    if (!st || !d) { el.innerHTML = '<div><div class="big">' + escapeHtml(d ? d.text : 'Checking your backup…') + '</div></div>'; el.dataset.state = d ? d.state : 'none'; return; }
    el.dataset.state = d.state;
    const pct = st.total ? Math.round(100 * st.onCloud / st.total) : 0;
    const link = lastStateSeen && lastStateSeen.status === 'ready'
      ? '● Linked' + (lastStateSeen.me ? ' as ' + escapeHtml(lastStateSeen.me) : '') + (typeof syncLine === 'function' ? syncLine(lastStateSeen) : '')
      : '● WhatsApp not linked yet';
    let left = '<div class="big">' + (!st.total ? 'Your archive is ready to begin' : st.configured ? '<b>' + st.onCloud + '</b> of ' + st.total + ' media files in cloud folder' + (!st.available ? ' (last known)' : '') : st.total + ' media files saved on this PC') + '</div>'
      + '<div class="line">' + escapeHtml(d.text) + (st.configured && st.available ? ' Backing up to ' + escapeHtml(st.root) + '.' : '') + '</div>'
      + (st.configured ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '')
      + '<div class="line">' + link + '</div>';
    let side = '';
    if (st.configured && st.onlyHere > 0) side += '<button class="local" id="ov-local"><b>' + st.onlyHere + '</b>on this PC only — show them</button>';
    if (st.configured) side += '<button class="btn small" id="ov-sweep">' + (st.available ? 'Back up now' : 'Check now') + '</button>';
    else side += '<button class="btn small" id="ov-cloud-set">Choose a cloud folder</button>';
    el.innerHTML = '<div>' + left + '</div><div class="side">' + side + '</div>';
    const l = $('ov-local'); if (l) l.addEventListener('click', () => { clearAll(); F.backup = 'local'; const s = fEl('f-backup'); if (s) s.value = 'local'; setView('media'); render(allItems); });
    const sw = $('ov-sweep'); if (sw) sw.addEventListener('click', async () => { sw.disabled = true; sw.textContent = 'Working…'; await Backup.sweep(); });
    const cset = $('ov-cloud-set'); if (cset) cset.addEventListener('click', () => { openSettings(); const tab = document.querySelector('#settabs [data-t="storage"]'); if (tab) tab.click(); });
  }
  function renderUpkeep() {
    const el = $('ov-upkeep'); if (!el) return;
    const go = (t) => { openSettings(); const tab = document.querySelector('#settabs [data-t="' + t + '"]'); if (tab) tab.click(); };
    el.innerHTML = '<button class="btn small" data-up="history">Import WhatsApp history</button>'
      + '<button class="btn small" data-up="ai">Set up AI sorting</button>'
      + '<button class="btn small" data-up="connection">Manage sources</button>'
      + '<button class="btn small" data-up="cleanup">Clean up</button>';
    el.querySelectorAll('button[data-up]').forEach((b) => b.addEventListener('click', () => b.dataset.up === 'cleanup' ? setView('cleanup') : go(b.dataset.up)));
  }
  function stat(n, label) {
    return '<div class="ov-stat"><div class="ov-n">' + n + '</div><div class="ov-l">' + escapeHtml(label) + '</div></div>';
  }

  async function render() {
    const labelled = (typeof AI !== 'undefined' && AI.labelCount) ? AI.labelCount() : 0;

    const shown = allItems.filter((r) => !F.source || srcOf(r) === F.source);
    const photos = shown.filter((r) => r.kind === 'image' || r.kind === 'sticker').length;
    const videos = shown.filter((r) => r.kind === 'video').length;

    const shownIds = new Set(shown.map((r) => r.id));
    const shownAlbums = albums.map((g) => ({ ...g, items: (g.items || []).filter((id) => shownIds.has(id)) })).filter((g) => g.items.length);
    const shownProjects = !F.source || F.source === 'whatsapp' ? projects : [];
    const docs = shown.filter((r) => r.kind === 'document').length;
    const voice = shown.filter((r) => r.kind === 'voice' || r.kind === 'audio').length;
    const kept = typeof Finals !== 'undefined' ? Finals.keptCount() : 0;
    statsEl.innerHTML = stat(photos, photos === 1 ? 'photo' : 'photos')
      + stat(videos, videos === 1 ? 'video' : 'videos')
      + (docs ? stat(docs, docs === 1 ? 'document' : 'documents') : '')
      + (voice ? stat(voice, 'voice notes') : '')
      + stat(!F.source || F.source === 'whatsapp' ? chats.length : 0, 'WhatsApp conversations')
      + stat(shownProjects.length, 'projects')
      + stat(shownAlbums.length, 'albums')
      + (topicsList.length ? stat(topicsList.length, 'topics') : '')
      + (kept ? stat(kept, 'finals kept') : '');
    renderBackup();
    renderUpkeep();
    renderFinals();
    renderTopics();

    // Projects, busiest first — a project with two chats in it is less of a
    // thing than one with thirty, and the eye should land on the thirty.
    const byName = new Map(chats.map((c) => [c.chatId, c]));
    const withCounts = shownProjects.map((g) => {
      const ids = (g.items || []).filter((id) => byName.has(id));
      const names = ids
        .map((id) => byName.get(id))
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
        .slice(0, 3)
        .map((c) => c.chatName || c.chatId);
      return { g, n: (g.items || []).length, names };
    }).sort((a, b) => b.n - a.n);

    projCount.textContent = shownProjects.length ? shownProjects.length + ' found' : '';
    projEl.innerHTML = withCounts.length
      ? withCounts.map((x) => card({
          kind: 'project', id: x.g.id, emoji: x.g.emoji, name: x.g.name,
          desc: x.g.description, count: x.n,
          foot: x.names.length ? escapeHtml(x.names.join(' · ')) : '',
        })).join('')
      : '<p class="muted small">Projects organise your WhatsApp conversations. Set up AI sorting to create them.</p>';

    albCount.textContent = shownAlbums.length ? shownAlbums.length + ' found' : '';
    albEl.innerHTML = shownAlbums.length
      ? shownAlbums.slice().sort((a, b) => (b.items || []).length - (a.items || []).length).map((g) => card({
          kind: 'album', id: g.id, emoji: g.emoji, name: g.name,
          desc: g.description, count: (g.items || []).length, foot: '',
        })).join('')
      : '<p class="muted small">No albums for this source yet. Browse the Gallery, or set up AI sorting to group your pictures.</p>';
  }

  const fetchGroups = async (kind) => {
    try { return (await (await fetch('/api/ai/groups?kind=' + kind)).json()).groups || []; }
    catch (e) { return []; }
  };

  async function enter() {
    if (!entered) { entered = true; }
    const [c, p, a, t, f] = await Promise.all([
      requestJson('/api/chats').catch(() => []),
      fetchGroups('chat'),
      fetchGroups('media'),
      requestJson('/api/topics').catch(() => ({ topics: [] })),
      requestJson('/api/finals/sets').catch(() => ({ sets: [] })),
    ]);
    chats = Array.isArray(c) ? c : []; projects = p; albums = a;
    topicsList = (t && t.topics) || [];
    finalSets = (f && f.sets) || [];
    if (typeof AI !== 'undefined') {
      try { await AI.ensureChatGroups(); } catch (e) {}
      try { await AI.loadLabels(); } catch (e) {}
    }
    render();
  }

  // A card is a way in, not an ornament: a project opens the conversations it
  // is made of, an album opens the pictures in it.
  const go = (e) => {
    const b = e.target.closest('.ov-card');
    if (!b) return;
    if (b.dataset.kind === 'final') { setView('finals'); if (typeof Finals !== 'undefined') Finals.showSet(b.dataset.id); return; }
    if (b.dataset.kind === 'topic') {
      const t = topicsList.find((x) => x.id === b.dataset.id);
      if (t) { setView('convo'); Convo.openAt(t.chatId, t.fromTs, t.chatName); }
      return;
    }
    if (b.dataset.kind === 'album') {
      const source = F.source; clearAll(); F.source = source; renderSourceBar();
      setView('media');
      if (typeof AI !== 'undefined' && AI.selectAlbum) AI.selectAlbum(b.dataset.id);
      return;
    }
    const g = projects.find((x) => x.id === b.dataset.id);
    setView('convo');
    const box = document.getElementById('convo-search');
    if (box) { box.value = ''; }
    Promise.resolve(typeof Convo !== 'undefined' && Convo.enter()).then(() => { if (g && typeof Convo !== 'undefined') Convo.setProject(g.id); });
  };
  projEl.addEventListener('click', go);
  albEl.addEventListener('click', go);
  const fe = $('ov-finals'); if (fe) fe.addEventListener('click', go);
  const te = $('ov-topics'); if (te) te.addEventListener('click', go);

  return { enter, render, renderBackup };
})();


/* ---------- Finals: versions of one thing, and which to keep ---------------
   The engine finds the sets and the AI suggests one; this is where the
   person decides. Keeping copies the file into the Finals folder and marks it;
   the mark shows on the tile and in the lightbox. Nothing is deleted. */
const Finals = (function () {
  const list = $('fn-list'), tabs = $('fn-tabs'), detect = $('fn-detect'), sub = $('fn-sub');
  let sets = [];
  let dirs = null;
  let marks = new Map();            // id -> mark
  let suggested = new Set();        // ids in a set with a live suggestion
  let tab = 'suggested';
  let pendingShow = null;

  const isKept = (id) => marks.has(id);
  const isSuggested = (id) => suggested.has(id);
  const keptCount = () => marks.size;

  async function refreshMarks() {
    try {
      const [m, s] = await Promise.all([requestJson('/api/finals/marks'), requestJson('/api/finals/sets')]);
      marks = new Map((m || []).map((x) => [x.id, x]));
      sets = (s && s.sets) || []; dirs = s && s.dirs;
      suggested = new Set();
      for (const st of sets) if (st.status === 'suggested') for (const mm of st.members) suggested.add(mm.id);
      const nav = document.getElementById('nav-finals-count');
      if (nav) { const n = sets.filter((x) => x.status === 'suggested').length; nav.textContent = n ? String(n) : ''; }
    } catch (_) {}
  }

  async function toggleKeep(id) {
    const on = marks.has(id);
    try {
      await requestJson(on ? '/api/finals/unkeep' : '/api/finals/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refId: id }) });
    } catch (e) { alert('Could not change that: ' + e.message); return on; }
    await refreshMarks();
    return !on;
  }

  const thumb = (m) => m.kind === 'image' || m.kind === 'sticker'
    ? `<img class="th" src="/api/thumbnail/${encodeURIComponent(m.id)}" alt="" data-open="${escapeHtml(m.id)}">`
    : `<div class="th file" data-open="${escapeHtml(m.id)}">${m.kind === 'video' ? '▶' : KIND_ICON[m.kind] || '📄'}</div>`;

  function setCard(s) {
    const el = document.createElement('section');
    el.className = 'fn-set';
    el.dataset.set = s.id;
    const conf = s.confidence ? `<span class="conf">${Math.round(s.confidence * 100)}% sure</span>` : '';
    el.innerHTML = `<div class="fn-set-head"><b>${escapeHtml(s.chat || 'Versions')}</b><span class="muted small">${s.members.length} versions · ${new Date(s.members[0].ts).toLocaleDateString()}</span>${conf}<span class="reason">${escapeHtml(s.reason || (s.status === 'pending' ? 'Being judged…' : ''))}</span></div>
      <div class="fn-members">${s.members.map((m) => {
        const kept = marks.has(m.id);
        const sug = m.id === s.suggestedId;
        return `<div class="fn-member${sug ? ' suggested' : ''}${kept ? ' kept' : ''}">${thumb(m)}
          ${kept ? '<span class="star">★ Kept</span>' : sug ? '<span class="star">✦ AI pick</span>' : ''}
          <div class="meta" title="${escapeHtml(m.docName || m.caption || '')}">${escapeHtml(new Date(m.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }))}${m.docName ? ' · ' + escapeHtml(m.docName) : m.caption ? ' · ' + escapeHtml(m.caption) : ''}</div>
          <div class="act"><button class="btn small${sug && !kept ? ' primary' : ''}" data-keep="${escapeHtml(m.id)}">${kept ? 'Un-keep' : 'Keep this one'}</button></div></div>`;
      }).join('')}</div>
      <div class="fn-set-foot"><span class="muted small">${s.status === 'kept' ? 'Decided.' : s.status === 'dismissed' ? 'Dismissed — these stay as they are.' : 'Keeping one copies it into your Finals folder. The others are not touched.'}</span>
        ${s.status === 'suggested' || s.status === 'pending' ? `<button class="btn small ghost" data-dismiss="${escapeHtml(s.id)}">Not versions / leave it</button>` : `<button class="btn small ghost" data-reopen="${escapeHtml(s.id)}">Reopen</button>`}</div>`;
    return el;
  }

  function render() {
    if (!list) return;
    if (sub && dirs) sub.innerHTML = `When several versions of one thing were sent — an advert, a quote, a retaken photo — the AI suggests which is the final. Keeping one copies it to <span class="kbd">${escapeHtml(dirs.local)}</span>${dirs.cloud ? ' and <span class="kbd">' + escapeHtml(dirs.cloud) + '</span>' : ''}; nothing is deleted.`;
    if (tabs) [...tabs.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b.dataset.status === tab));
    list.innerHTML = '';
    if (tab === 'marks') {
      const rows = [...marks.values()].sort((a, b) => b.at - a.at);
      if (!rows.length) { list.innerHTML = '<p class="sv-empty">Nothing kept yet. Keep one from a set, or from any item\'s viewer (☆ Keep as final).</p>'; return; }
      for (const m of rows) {
        const r = allItems.find((x) => x.id === m.id);
        const el = document.createElement('div');
        el.className = 'fn-mark';
        el.innerHTML = `${r && (r.kind === 'image' || r.kind === 'sticker') ? `<img src="/api/thumbnail/${encodeURIComponent(m.id)}" alt="" data-open="${escapeHtml(m.id)}">` : `<div class="th file" data-open="${escapeHtml(m.id)}">${r ? (r.kind === 'video' ? '▶' : KIND_ICON[r.kind] || '📄') : '📄'}</div>`}
          <div class="body"><div>${r ? escapeHtml(r.chat) + ' · ' + new Date(r.ts).toLocaleDateString() + (r.docName ? ' · ' + escapeHtml(r.docName) : '') : escapeHtml(m.id)}</div><div class="p">${escapeHtml(m.localPath || '')}${m.cloudPath ? '<br>' + escapeHtml(m.cloudPath) : ''}</div></div>
          <button class="btn small" data-show="${escapeHtml(m.localPath || '')}">📁 Show</button>
          <button class="btn small ghost" data-keep="${escapeHtml(m.id)}">Un-keep</button>`;
        list.appendChild(el);
      }
      return;
    }
    const want = tab === 'kept' ? sets.filter((s) => s.status === 'kept') : tab === 'dismissed' ? sets.filter((s) => s.status === 'dismissed') : sets.filter((s) => s.status === 'suggested' || s.status === 'pending');
    if (!want.length) {
      list.innerHTML = `<p class="sv-empty">${tab === 'suggested' ? 'No sets waiting. Sets appear after the AI has read your photos and documents — run the sorting in Settings, or press “Look for new sets”.' : 'Nothing here yet.'}</p>`;
      return;
    }
    for (const s of want) list.appendChild(setCard(s));
    if (pendingShow) {
      const el = list.querySelector('.fn-set[data-set="' + CSS.escape(pendingShow) + '"]');
      if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => { el.style.outline = ''; }, 3000); }
      pendingShow = null;
    }
  }

  async function enter() { await refreshMarks(); render(); }
  function showSet(id) {
    const s = sets.find((x) => x.id === id);
    tab = s && s.status === 'kept' ? 'kept' : s && s.status === 'dismissed' ? 'dismissed' : 'suggested';
    pendingShow = id;
    enter();
  }

  if (tabs) tabs.addEventListener('click', (e) => { const b = e.target.closest('button[data-status]'); if (!b) return; tab = b.dataset.status; render(); });
  if (list) list.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { const r = allItems.find((x) => x.id === open.dataset.open); if (r) openLightbox(r); return; }
    const keep = e.target.closest('button[data-keep]');
    if (keep) {
      const set = e.target.closest('.fn-set');
      const id = keep.dataset.keep;
      keep.disabled = true;
      try {
        if (marks.has(id)) await requestJson('/api/finals/unkeep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refId: id }) });
        else {
          await requestJson('/api/finals/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refId: id, setId: set ? set.dataset.set : null }) });
          // The set is decided now: follow it to the Kept tab rather than
          // leaving an empty "nothing waiting" screen behind.
          if (set && tab === 'suggested') { tab = 'kept'; pendingShow = set.dataset.set; }
        }
      } catch (err) { alert('Could not do that: ' + err.message); }
      await refreshMarks(); render();
      if (currentView === 'media') window.render(allItems);
      return;
    }
    const dis = e.target.closest('button[data-dismiss]');
    if (dis) { try { await requestJson('/api/finals/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setId: dis.dataset.dismiss }) }); } catch (_) {} await refreshMarks(); render(); return; }
    const re = e.target.closest('button[data-reopen]');
    if (re) { try { await requestJson('/api/finals/reopen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setId: re.dataset.reopen }) }); } catch (_) {} await refreshMarks(); render(); return; }
    const show = e.target.closest('button[data-show]');
    if (show && show.dataset.show) {
      if (bridge && bridge.showInFolder) { const ok = await bridge.showInFolder(show.dataset.show); if (ok) return; }
      try { await navigator.clipboard.writeText(show.dataset.show); show.textContent = 'Path copied'; } catch (_) {}
    }
  });
  if (detect) detect.addEventListener('click', async () => {
    detect.disabled = true; detect.textContent = 'Looking…';
    try {
      const r = await requestJson('/api/finals/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      detect.textContent = r.queued ? `${r.queued} to judge — refreshing…` : 'Nothing new';
      // The judging runs in the background; look again in a moment.
      setTimeout(async () => { await refreshMarks(); render(); detect.textContent = 'Look for new sets'; detect.disabled = false; }, r.queued ? 6000 : 1500);
    } catch (e) { detect.textContent = 'Look for new sets'; detect.disabled = false; alert(e.message); }
  });

  return { enter, refreshMarks, isKept, isSuggested, keptCount, toggleKeep, showSet };
})();


/* ---------- Topics: what the conversations were about ---------------------- */
const Topics = (function () {
  const list = $('tp-list'), themes = $('tp-themes'), search = $('tp-search'), chatSel = $('tp-chat');
  let data = { topics: [], themes: [] };
  let theme = '', q = '', chat = '';

  function render() {
    if (!list) return;
    const ql = q.toLowerCase();
    let rows = data.topics.slice().sort((a, b) => b.toTs - a.toTs);
    if (theme) rows = rows.filter((t) => t.theme && t.theme.id === theme);
    if (chat) rows = rows.filter((t) => t.chatId === chat);
    if (ql) rows = rows.filter((t) => [t.title, t.summary, t.chatName, (t.keywords || []).join(' '), (t.decisions || []).join(' ')].join(' ').toLowerCase().includes(ql));
    if (themes) themes.innerHTML = data.themes.length
      ? `<button class="chip${!theme ? ' active' : ''}" data-theme="">All</button>` + data.themes.map((g) => `<button class="chip${theme === g.id ? ' active' : ''}" data-theme="${escapeHtml(g.id)}" title="${escapeHtml(g.description || '')}">${escapeHtml((g.emoji ? g.emoji + ' ' : '') + g.name)}<span class="n">${g.members}</span></button>`).join('')
      : '';
    if (chatSel && chatSel.options.length <= 1) {
      const names = new Map(); for (const t of data.topics) names.set(t.chatId, t.chatName);
      chatSel.innerHTML = '<option value="">Every chat</option>' + [...names.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id, n]) => `<option value="${escapeHtml(id)}">${escapeHtml(n)}</option>`).join('');
    }
    if (!rows.length) { list.innerHTML = `<p class="sv-empty">${data.topics.length ? 'No topics match.' : 'No topics yet. Topics are read from your conversations by the AI sorting — run it in Settings → AI & search.'}</p>`; return; }
    list.innerHTML = rows.slice(0, 300).map((t) => `<button class="tp-card" data-id="${escapeHtml(t.id)}">
      <div class="t">${escapeHtml(t.title)}${t.theme ? `<span class="theme">${escapeHtml((t.theme.emoji ? t.theme.emoji + ' ' : '') + t.theme.name)}</span>` : ''}</div>
      <div class="m">${escapeHtml(t.chatName)} · ${new Date(t.fromTs).toLocaleDateString()}${t.toTs - t.fromTs > 86400000 ? ' – ' + new Date(t.toTs).toLocaleDateString() : ''} · ${t.msgCount} messages${t.people && t.people.length ? ' · ' + escapeHtml(t.people.slice(0, 3).join(', ')) : ''}</div>
      <div class="s">${escapeHtml(t.summary || '')}</div>
      ${(t.decisions || []).slice(0, 2).map((d) => `<div class="d">✓ ${escapeHtml(d)}</div>`).join('')}
      ${t.keywords && t.keywords.length ? `<div class="k">${t.keywords.slice(0, 6).map((k) => `<i>${escapeHtml(k)}</i>`).join('')}</div>` : ''}
    </button>`).join('');
  }

  async function enter() {
    try { data = await requestJson('/api/topics'); } catch (_) { data = { topics: [], themes: [] }; }
    render();
  }
  if (themes) themes.addEventListener('click', (e) => { const b = e.target.closest('button[data-theme]'); if (!b) return; theme = b.dataset.theme; render(); });
  if (search) search.addEventListener('input', () => { q = search.value.trim(); render(); });
  if (chatSel) chatSel.addEventListener('change', () => { chat = chatSel.value; render(); });
  if (list) list.addEventListener('click', (e) => {
    const b = e.target.closest('.tp-card'); if (!b) return;
    const t = data.topics.find((x) => x.id === b.dataset.id);
    if (!t) return;
    setView('convo');
    Convo.openAt(t.chatId, t.fromTs, t.chatName);
  });
  return { enter, render };
})();


/* ---------- Search & ask: every angle at once ------------------------------ */
const Search = (function () {
  const input = $('gsearch'), form = $('gsearch-form');
  const title = $('sv-title'), sub = $('sv-sub'), filters = $('sv-filters'), results = $('sv-results');
  const askQ = $('ask-q'), askGo = $('ask-go'), askOut = $('ask-out');
  let last = '';
  let seq = 0;

  const when = (ts) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const hi = (s) => escapeHtml(s || '').replace(/\[\[(.+?)\]\]/g, '<mark>$1</mark>');

  function chipsFor(f) {
    const out = [];
    if (f.kind) out.push(({ image: 'Photos', video: 'Videos', document: 'Documents', audio: 'Voice notes' })[f.kind]);
    if (f.docType) out.push(f.docType);
    if (f.from && f.to) out.push(when(f.from) + ' – ' + when(f.to - 1));
    if (f.dir) out.push(f.dir === 'out' ? 'Sent' : 'Received');
    if (f.chat) out.push('with ' + f.chat);
    return out;
  }

  function mediaCard(m) {
    const th = m.kind === 'image' || m.kind === 'sticker' || m.kind === 'video'
      ? `<img class="th" src="/api/thumbnail/${encodeURIComponent(m.id)}" alt="" onerror="this.outerHTML='<div class=&quot;th file&quot;>${m.kind === 'video' ? '▶' : '🖼'}</div>'">`
      : `<div class="th file">${KIND_ICON[m.kind] || '📄'}</div>`;
    return `<button class="sv-item" data-open="${escapeHtml(m.id)}">${th}<div class="body"><div class="t1">${escapeHtml(m.docName || m.title || m.caption || m.chat)}</div><div class="t2">${escapeHtml(m.chat)} · ${when(m.ts)}${m.snippet ? ' · ' : ''}${hi(m.snippet)}</div><div class="why">${escapeHtml((m.why || []).join(', '))}</div></div></button>`;
  }

  function render(r) {
    if (!results) return;
    if (title) title.textContent = 'Search: ' + r.query;
    if (filters) filters.innerHTML = chipsFor(r.filters || {}).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('') + (r.semantic ? '<span class="chip" title="Vectors were used: results can match by meaning, not only by the words">by meaning too</span>' : '');
    const total = (r.media || []).length + (r.messages || []).length + (r.chats || []).length + (r.topics || []).length + (r.contacts || []).length;
    if (sub) sub.textContent = total ? `${total} results across photos, documents, voice notes, messages, chats, topics and people.` : 'Nothing matches. Try fewer words, or ask the question below.';
    const groups = [];
    if (r.topics && r.topics.length) groups.push(`<section class="sv-group"><h3>Topics<span class="n">${r.topics.length}</span></h3><div class="sv-rows">${r.topics.map((t) => `<button class="sv-row" data-topic="${escapeHtml(t.chatId)}" data-ts="${t.fromTs}" data-name="${escapeHtml(t.chatName || '')}"><span class="who">${escapeHtml(t.chatName || '')}</span><span class="what"><b>${escapeHtml(t.title)}</b> — ${hi(t.snippet || t.summary)}</span><span class="when">${when(t.toTs)}</span></button>`).join('')}</div></section>`);
    if (r.media && r.media.length) groups.push(`<section class="sv-group"><h3>Photos, videos, documents, voice notes<span class="n">${r.media.length}</span></h3><div class="sv-media">${r.media.map(mediaCard).join('')}</div></section>`);
    if (r.messages && r.messages.length) groups.push(`<section class="sv-group"><h3>Messages<span class="n">${r.messages.length}</span></h3><div class="sv-rows">${r.messages.map((m) => `<button class="sv-row" data-msg="${escapeHtml(m.chatId)}" data-ts="${m.ts}" data-name="${escapeHtml(m.chatName || '')}"><span class="who">${escapeHtml(m.chatName)}${m.author && m.author !== m.chatName ? ' · ' + escapeHtml(m.author) : m.fromMe ? ' · you' : ''}</span><span class="what">${hi(m.snippet)}</span><span class="when">${when(m.ts)}</span></button>`).join('')}</div></section>`);
    if (r.chats && r.chats.length) groups.push(`<section class="sv-group"><h3>Conversations<span class="n">${r.chats.length}</span></h3><div class="sv-rows">${r.chats.map((c) => `<button class="sv-row" data-chat="${escapeHtml(c.chatId)}" data-name="${escapeHtml(c.chatName || '')}"><span class="who">${escapeHtml(c.chatName)}</span><span class="what">${escapeHtml(c.summary || '')}${c.project ? ' · ' + escapeHtml(c.project) : ''}</span><span class="when">${escapeHtml(c.why || '')}</span></button>`).join('')}</div></section>`);
    if (r.contacts && r.contacts.length) groups.push(`<section class="sv-group"><h3>People<span class="n">${r.contacts.length}</span></h3><div class="sv-rows">${r.contacts.map((c) => `<button class="sv-row" data-chat="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name || c.pushname || c.number)}"><span class="who">${escapeHtml(c.name || c.pushname || '')}</span><span class="what">${escapeHtml(c.number ? '+' + c.number : '')}${c.isGroup ? ' · group' : ''}</span><span class="when">open chat</span></button>`).join('')}</div></section>`);
    results.innerHTML = groups.join('') || '<p class="sv-empty">Nothing found.</p>';
  }

  async function run(q) {
    q = String(q || '').trim();
    if (!q) return;
    last = q;
    if (input && input.value !== q) input.value = q;
    if (askQ && !askQ.value) askQ.placeholder = 'Or ask: ' + q + '?';
    setView('search');
    const my = ++seq;
    if (sub) sub.textContent = 'Searching…';
    let r;
    try { r = await requestJson('/api/search/all?q=' + encodeURIComponent(q)); } catch (e) { if (sub) sub.textContent = 'Search failed: ' + e.message; return; }
    if (my !== seq) return;
    render(r);
  }

  async function ask(q) {
    q = String(q || '').trim();
    if (!q) return;
    setView('search');
    if (askQ) askQ.value = q;
    if (askOut) { askOut.classList.remove('hidden'); askOut.innerHTML = '<div class="muted">Reading your archive…</div>'; }
    if (askGo) askGo.disabled = true;
    try {
      const r = await requestJson('/api/ai/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
      askOut.innerHTML = `<div class="ask-answer">${escapeHtml(r.answer || '')}</div>` + (r.sources && r.sources.length ? `<div class="ask-sources">${r.sources.map((s) => `<button class="ask-src" data-src='${escapeHtml(JSON.stringify(s.ref || {}))}' data-kind="${escapeHtml(s.kind)}" data-ts="${s.ts || 0}" data-name="${escapeHtml(s.chat || '')}">${s.serve && (s.kind === 'image') ? `<img src="/api/thumbnail/${encodeURIComponent(s.ref.id)}" alt="">` : ''}<span class="n">${s.n}</span><span class="t"><b>${escapeHtml(s.kind)}${s.chat ? ' · ' + escapeHtml(s.chat) : ''}${s.ts ? ' · ' + when(s.ts) : ''}</b><br>${escapeHtml(s.text)}</span></button>`).join('')}</div>` : '');
    } catch (e) { askOut.innerHTML = `<div class="bad-text">${escapeHtml(e.message)}</div>`; }
    if (askGo) askGo.disabled = false;
    // The plain search for the same words, underneath the answer.
    if (last !== q) run(q);
  }

  function enter() { if (input) { if (input.value.trim() && input.value.trim() !== last) run(input.value); else if (!last) setTimeout(() => input.focus(), 50); } }

  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); run(input.value); });
  if (input) { let t; input.addEventListener('input', () => { clearTimeout(t); const v = input.value.trim(); if (v.length >= 2) t = setTimeout(() => run(v), 350); }); }
  if (askGo) askGo.addEventListener('click', () => ask(askQ.value));
  if (askQ) askQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(askQ.value); } });
  if (results) results.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { const r = allItems.find((x) => x.id === open.dataset.open); if (r) openLightbox(r); return; }
    const row = e.target.closest('.sv-row');
    if (!row) return;
    if (row.dataset.msg || row.dataset.topic) { setView('convo'); Convo.openAt(row.dataset.msg || row.dataset.topic, parseInt(row.dataset.ts, 10), row.dataset.name); return; }
    if (row.dataset.chat) { setView('convo'); Convo.openChat({ chatId: row.dataset.chat, chatName: row.dataset.name }); }
  });
  if (askOut) askOut.addEventListener('click', (e) => {
    const b = e.target.closest('.ask-src'); if (!b) return;
    let ref = {}; try { ref = JSON.parse(b.dataset.src); } catch (_) {}
    const kind = b.dataset.kind;
    if (kind === 'message' || kind === 'topic') { setView('convo'); Convo.openAt(ref.chatId, kind === 'topic' ? ref.fromTs : parseInt(b.dataset.ts, 10), b.dataset.name); return; }
    if (kind === 'chat') { setView('convo'); Convo.openChat({ chatId: ref.chatId, chatName: b.dataset.name }); return; }
    const r = allItems.find((x) => x.id === ref.id); if (r) openLightbox(r);
  });

  return { run, ask, enter };
})();


async function requestJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), ...options });
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('The app returned an unreadable response. Try again.'); }
  if (!response.ok || data.ok === false) throw new Error(data.error || data.message || 'Request failed (' + response.status + ')');
  if (data.rejected && data.rejected.length) throw new Error('Some settings were not saved: ' + data.rejected.join(', '));
  return data;
}

// The overview exposes connection state without starting imports or changing consent.
const SourceOverview = (() => {
  const root = $('ov-connections'), next = $('ov-next');
  let running = false;
  const ago = (at) => at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const update = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
  function card(name, text, detail, action, state = '') {
    return '<article class="source-card"><div class="source-heading"><h3>' + escapeHtml(name) + '</h3><span class="tag ' + state + '">' + escapeHtml(text) + '</span></div><p>' + escapeHtml(detail) + '</p><button class="btn small" data-source-action="' + action + '">' + (action === 'link' ? 'Link WhatsApp' : action === 'history' ? 'Import history' : 'Manage source') + '</button></article>';
  }
  function source(name, s) {
    if (!s) return card(name, 'Unavailable', 'Could not read this source. Open Sources to retry.', 'connection', 'warn');
    let status = s.linked ? 'Connected' : 'Not connected';
    let detail = s.linked ? 'Import images to keep a copy in your archive.' : 'Optional: sign in once to import your images.';
    let tone = s.linked ? 'ok' : '';
    if (s.status === 'error') { status = 'Needs attention'; detail = s.lastError || 'Open Sources to retry.'; tone = 'bad'; }
    else if (s.busy) {
      const p = s.progress || {};
      status = s.status === 'connecting' ? 'Sign-in window open' : 'Importing'; tone = 'warn';
      detail = s.status === 'connecting' ? 'Complete sign-in in the window that opened.' : p.of && p.conversations < p.of
        ? 'Reading chat ' + p.conversations + ' of ' + p.of + '. ' + (p.images || 0) + ' images found; downloads follow.'
        : 'Downloading images: ' + (p.saved || 0) + ' saved of ' + (p.images || 0) + ' found. You can keep browsing.';
    } else if (s.lastRun) {
      detail = 'Last import: ' + ago(s.lastRun.at) + '. ' + s.lastRun.saved + ' new, ' + s.lastRun.skipped + ' already saved.';
      if (s.lastRun.failed) { status = 'Import incomplete'; detail += ' ' + s.lastRun.failed + ' failed; open Sources for details and retry.'; tone = 'warn'; }
    }
    if (s.linked && !s.busy) detail += s.enabled ? ' Scheduled every ' + s.scanHours + ' hours.' : ' Manual imports.';
    return card(name, status, detail, 'connection', tone);
  }
  async function refresh() {
    if (running || currentView !== 'overview') return;
    running = true;
    try {
      const [wa, cg, gm] = await Promise.all(['/api/state', '/api/chatgpt/state', '/api/gemini/state'].map((url) => requestJson(url).catch(() => null)));
      const ready = wa && wa.status === 'ready';
      const broken = wa && wa.health && !wa.health.ok;
      const syncing = wa && ['starting', 'authenticated'].includes(wa.status);
      update(root, card('WhatsApp', !wa ? 'Unavailable' : broken ? 'Needs attention' : ready ? 'Capturing' : wa.status === 'qr' ? 'Scan QR code' : 'Not connected',
        !wa ? 'The capture engine is unavailable. Check the app or try again.' : broken ? 'Downloads are failing. Open Sources to check the connection.' : ready ? 'New messages and selected media are saved while this app runs.' : 'Link your phone to start saving WhatsApp messages and media.', !wa ? 'app' : ready || broken ? 'connection' : 'link', ready && !broken ? 'ok' : 'warn') + source('ChatGPT', cg) + source('Gemini', gm));
      let title, detail, action, button;
      if (!wa) { title = 'The capture engine is unavailable'; detail = 'Open App settings to restart capture. Your saved files remain in their folders.'; action = 'app'; button = 'Open app settings'; }
      else if (broken) { title = 'WhatsApp capture needs attention'; detail = 'Some downloads are failing. Check the connection before relying on new captures.'; action = 'connection'; button = 'Check connection'; }
      else if (syncing) { title = wa.status === 'authenticated' ? 'WhatsApp is signed in and syncing' : 'Connecting to WhatsApp'; detail = 'Your saved library and content search are available now. New captures begin when the connection is ready.'; action = 'connection'; button = 'View connection'; }
      else if (!ready) { title = 'Start by linking WhatsApp'; detail = 'Have your phone ready. The Library shows the QR code and linking instructions.'; action = 'link'; button = 'Link WhatsApp'; }
      else if (wa.backfill && wa.backfill.running) { title = 'Importing WhatsApp history'; detail = (wa.backfill.doneChats || 0) + ' of ' + (wa.backfill.totalChats || 0) + ' chats checked. You can keep browsing.'; action = 'history'; button = 'View import'; }
      else if (!(wa.backfill && wa.backfill.lastImportAt)) { title = 'Bring in your older WhatsApp chats'; detail = 'Live capture is running. Import history once to save older messages and media that WhatsApp still makes available.'; action = 'history'; button = 'Import older chats'; }
      else { title = 'Your archive is ready to explore'; detail = 'Browse your media, read saved conversations, or connect another source below. AI sorting is optional.'; action = 'gallery'; button = 'Browse gallery'; }
      update(next, '<div><h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(detail) + '</p></div><button class="btn primary" data-source-action="' + action + '">' + button + '</button>');
    } finally { running = false; }
  }
  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-source-action]'); if (!button) return;
    const action = button.dataset.sourceAction;
    if (action === 'link' || action === 'gallery') { setView('media'); if (action === 'link') $('link').scrollIntoView({ block: 'center' }); }
    else openSettingsTab(action);
  });
  setInterval(refresh, 5000);
  return { refresh };
})();

/* Start-up, last: every module above is defined by this point, and a const
   that has not been reached yet cannot be tested for with typeof. */
loadItems(true).then(async () => {
  if (typeof Finals !== 'undefined') await Finals.refreshMarks();
  await AI.loadLabels();
  await AI.loadChatGroups();
  renderSourceBar();
  Backup.refresh();
  // The overview counts photos and videos out of the loaded library, so it is
  // drawn once that exists rather than showing zeroes for a moment.
  if (typeof Overview !== 'undefined') Overview.enter();
});
// Start on the overview: the tab marked active in the markup and the view
// actually shown have to be the same one, and this is also the first moment
// every module above exists to be called.
setView('overview');
