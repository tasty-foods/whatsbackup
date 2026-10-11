'use strict';
window.ContentSearch = (() => {
  const $ = id => document.getElementById(id);
  let term = '', hits = new Map(), sequence = 0, searching = false, lastRunning = false, statusBusy = false;
  const panel = document.createElement('section');
  panel.className = 'content-search-panel';
  panel.setAttribute('aria-label', 'Content search and indexing');
  panel.innerHTML = `<div class="content-search-heading"><div><span class="workspace-eyebrow">FIND WHAT YOU REMEMBER</span><h3>The contents are the clue.</h3><p>Try “closed wooden cupboard”, an invoice number, or a scene from a video.</p></div><button class="btn small" data-settings-tab="ai">AI settings</button></div>
    <div class="content-search-tools"><label>Search in <select id="content-scope" class="txt"><option value="all">Contents + names</option><option value="content">Contents only</option><option value="names">Names + captions</option></select></label><button id="content-understand" class="btn primary">Interpret search with AI</button><span class="muted small">Enter ↵ · uses your AI budget</span></div>
    <p id="content-result-status" class="content-result-status" role="status">Type in the search box above. Saved descriptions and document text are searched on your PC.</p>
    <details class="content-index"><summary><span id="content-coverage">Checking search coverage…</span><span class="muted small">Manage index</span></summary><div class="index-coverage" id="index-coverage"></div><p id="content-index-state" role="status"></p><div class="row wrap"><button class="btn primary" id="content-index-run">Build content index</button><button class="btn" id="content-index-pause">Pause</button><button class="btn" id="content-index-issues">Show skipped &amp; failed</button></div><p class="muted small">Existing files stay searchable during indexing. Video search covers sampled frames; brief moments between frames and spoken words may be missed.</p><div id="content-issues" role="status"></div></details>`;
  document.querySelector('#view-media .library-heading').after(panel);
  panel.querySelector('[data-settings-tab]').onclick = () => openSettingsTab('ai');
  const localButton = document.createElement('button'); localButton.className = 'btn'; localButton.textContent = 'Read document text locally'; localButton.title = 'No AI account or budget needed. Scanned pages can be added with AI later.'; $('content-index-run').after(localButton);
  localButton.onclick = async () => { try { const result = await request('/api/content/read-documents', {}); if (!result.ok) Workspace.toast(result.message); refresh(); } catch (e) { Workspace.toast(e.message); } };
  $('search').placeholder = 'Describe what you are looking for…';
  $('search').setAttribute('aria-label', 'Search names and contents of saved files');
  const request = (url, body) => requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function query(value, understand = false) {
    const ticket = ++sequence;
    term = value.trim().toLowerCase(); F.q = term; F.contentScope = $('content-scope').value; $('search').value = value;
    hits = new Map(); searching = !!term;
    if (!term) { searching = false; $('content-understand').disabled = false; $('content-result-status').textContent = 'Type in the search box above. Saved descriptions and document text are searched on your PC.'; render(allItems); return; }
    $('content-result-status').textContent = understand ? 'Interpreting your description…' : 'Searching your saved index…';
    $('content-understand').disabled = true;
    try {
      const result = await request('/api/content/search', { query: term, understand, scope: $('content-scope').value });
      if (ticket !== sequence) return;
      hits = new Map(result.matches.map(hit => [hit.id, hit]));
      $('content-result-status').textContent = `${result.total} ${result.total === 1 ? 'match' : 'matches'} in the saved index${result.understood ? ' · AI understood: ' + result.concepts.join(' + ') : ''}. ${result.notice || (result.total ? 'Best matches appear first with Newest sort selected.' : 'Try fewer details, interpret with AI, or index more of the library below.')}`;
    } catch (error) { if (ticket === sequence) $('content-result-status').textContent = 'Search failed: ' + error.message + '. Try again.'; }
    finally { if (ticket === sequence) { searching = false; $('content-understand').disabled = false; render(allItems); } }
  }
  $('content-understand').onclick = () => query($('search').value, true);
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchT); setView('media'); query($('search').value, true); } });
  $('content-scope').onchange = () => query($('search').value);
  $('performance-check').onclick = async () => {
    const button = $('performance-check'); button.disabled = true;
    try { const start = performance.now(), p = await requestJson('/api/performance'); $('performance-result').textContent = `Response: ${Math.round(performance.now() - start)} ms · engine delay: ${p.loopP95Ms} ms (95th percentile) · capture engine: ${p.engineMemoryMB} MB · PC memory free: ${(p.pcFreeMemoryMB / 1024).toFixed(1)} / ${(p.pcTotalMemoryMB / 1024).toFixed(1)} GB. Engine memory excludes the app window and source browsers.`; }
    catch (e) { $('performance-result').textContent = 'Could not measure: ' + e.message; }
    finally { button.disabled = false; }
  };
  async function refresh() {
    if (statusBusy || document.hidden) return;
    statusBusy = true;
    try {
      const s = await requestJson('/api/ai/status');
      const local = s.localDocuments || {};
      const working = s.running || local.running;
      const groups = [['images', 'Photos'], ['videos', 'Videos'], ['documents', 'Documents']];
      const buckets = groups.map(([key, name]) => ({ name, ...(s.coverage?.[key] || { count: 0, labelled: 0, todo: 0 }) }));
      const total = buckets.reduce((n, b) => n + b.count, 0), done = buckets.reduce((n, b) => n + b.labelled, 0);
      $('content-coverage').textContent = `${done.toLocaleString()} / ${total.toLocaleString()} files have a detailed content index${working ? ' · indexing' : s.paused ? ' · paused' : ''}`;
      $('index-coverage').innerHTML = buckets.map(b => `<div><b>${b.labelled.toLocaleString()} <span>/ ${b.count.toLocaleString()}</span></b><span>${b.name}</span><progress value="${b.labelled}" max="${Math.max(1, b.count)}" aria-label="${b.name} indexed"></progress></div>`).join('');
      $('content-index-state').textContent = s.running ? `Processed ${s.done} · ${s.jobs.queued} queued · ${s.failed} failed. ${s.message || ''}` : s.paused ? 'Paused. Your queue is saved. Resume when you are ready.' : s.error || s.message || (s.configured && s.enabled ? 'Ready. Indexing uses your existing AI provider and monthly budget.' : 'Choose a provider and enable AI in Settings to build the visual index.');
      if (local.running) $('content-index-state').textContent = `Reading documents on this PC: ${local.done} of ${local.total} · ${local.failed} failed.`;
      else if (!s.running && local.total) $('content-index-state').textContent += ' ' + local.message;
      $('content-index-run').disabled = working;
      localButton.disabled = working;
      $('content-index-run').textContent = s.paused ? 'Resume indexing' : 'Build content index';
      $('content-index-pause').disabled = !s.running && !s.jobs.queued;
      if (lastRunning && !working) { await AI.loadLabels(); if (term) query(term); }
      lastRunning = working;
    } catch (_) { $('content-coverage').textContent = 'Search index status unavailable · retrying'; }
    finally { statusBusy = false; }
  }
  async function index(ids) {
    try {
      const r = await request('/api/ai/run', { indexOnly: true, ...(ids ? { ids } : {}) });
      if (!r.ok) { Workspace.toast(r.message); return; }
      panel.querySelector('details').open = true;
      await refresh();
    } catch (e) { Workspace.toast('Could not start indexing: ' + e.message); }
  }
  $('content-index-run').onclick = () => index();
  $('content-index-pause').onclick = async () => { try { await request('/api/ai/cancel', {}); refresh(); } catch (e) { Workspace.toast(e.message); } };
  $('content-index-issues').onclick = async () => {
    try {
      const rows = await requestJson('/api/content/issues');
      $('content-issues').innerHTML = rows.length ? rows.map(row => `<p><b>${escapeHtml(row.name)}</b> — ${escapeHtml(row.error || row.state)}</p>`).join('') : '<p>No skipped or failed jobs.</p>';
    } catch (e) { $('content-issues').textContent = e.message; }
  };
  function decorate(tile, rec) {
    if (!term || F.q !== term) return;
    const hit = hits.get(rec.id); if (!hit) return;
    const evidence = document.createElement('div'); evidence.className = 'search-evidence';
    const title = document.createElement('b'); title.textContent = hit.evidence + (hit.page ? ' · page ' + hit.page : hit.seconds != null ? ' · ' + formatTime(hit.seconds) : '');
    const snippet = document.createElement('span'); snippet.textContent = hit.reason || hit.excerpt;
    evidence.append(title, snippet); tile.append(evidence);
  }
  const formatTime = seconds => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
  async function viewer(rec) {
    const hit = F.q === term ? hits.get(rec.id) : null;
    const box = document.createElement('div'); box.className = 'content-viewer'; els.lbMeta.append(box);
    const button = document.createElement('button'); button.className = 'btn small'; button.textContent = 'Index this file'; button.onclick = () => index([rec.id]);
    if (['image', 'video', 'document'].includes(rec.kind)) box.append(button);
    try {
      const data = await requestJson('/api/content/item/' + encodeURIComponent(rec.id));
      if (lbId !== rec.id || !box.isConnected) return;
      const label = data.label;
      if (data.current) { button.textContent = 'Indexed · up to date'; button.disabled = true; }
      if (label && rec.kind !== 'document') {
        els.lbMeta.querySelector('.m-ai')?.remove();
        const description = document.createElement('p'); description.textContent = label.caption || label.summary || ''; box.append(description);
        if (label.details?.length || label.text_in_image) {
          const details = document.createElement('details');
          const summary = document.createElement('summary'); summary.textContent = 'Objects, details & visible text';
          const text = document.createElement('p'); text.style.whiteSpace = 'pre-wrap'; text.textContent = [...(label.details || []), label.text_in_image || ''].filter(Boolean).join('\n');
          details.append(summary, text); box.append(details);
        }
      }
      if (rec.kind === 'document') {
        const preview = document.createElement('div'); preview.className = 'document-preview';
        const heading = document.createElement('h3'); heading.textContent = rec.docName || 'Document'; preview.append(heading);
        const text = document.createElement('pre'); text.textContent = label?.chunks?.map(c => (c.page ? `Page ${c.page}\n` : c.section ? c.section + '\n' : '') + c.text).join('\n\n') || 'This document has not been indexed yet. Index it to read and search its contents here.';
        preview.append(text); els.lbStage.replaceChildren(preview);
        if (hit?.excerpt) { const match = document.createElement('blockquote'); match.textContent = `Search match${hit.page ? ' · page ' + hit.page : ''}: ${hit.excerpt}`; preview.insertBefore(match, text); }
        if (label?.truncated || label?.unreadPages) { const note = document.createElement('p'); note.textContent = 'Partial index. Raise the PDF page or scanned-page limits in AI settings to read more.'; box.append(note); }
      }
      if (label?.frames?.length) {
        const caption = document.createElement('p'); caption.textContent = 'Jump to an indexed scene'; box.append(caption);
        for (const frame of label.frames) {
          const jump = document.createElement('button'); jump.className = 'btn small scene-jump'; jump.textContent = formatTime(frame.seconds) + ' · ' + frame.description;
          jump.onclick = () => { const video = els.lbStage.querySelector('video'); if (video) { video.currentTime = frame.seconds; video.play().catch(() => {}); } }; box.append(jump);
        }
      }
      if (hit?.seconds != null) { const video = els.lbStage.querySelector('video'); if (video) { if (video.readyState) video.currentTime = hit.seconds; else video.addEventListener('loadedmetadata', () => { video.currentTime = hit.seconds; }, { once: true }); } }
    } catch (e) { const note = document.createElement('p'); note.textContent = 'Content details unavailable: ' + e.message; box.append(note); }
  }
  refresh(); setInterval(() => { if (currentView === 'media' || lastRunning) refresh(); }, 5000);
  return { query, current: q => q === term && !!term, matches: id => hits.has(id), score: id => hits.get(id)?.score || 0, decorate, viewer, refresh };
})();
