'use strict';
// Source-specific setup and supported import paths. Secrets only cross the
// desktop IPC bridge; no credential is put in a URL, localStorage or HTTP body.
window.Connections = (() => {
  const $ = id => document.getElementById(id);
  let active = false, timer = null, refreshing = false, gmailDirty = false, lastGmailImport = null, lastPhotosImport = null, lastPickerImport = null, latestPicker = null;
  const desktop = window.desktop?.available ? window.desktop : null;
  const feedbackUntil = new Map();
  const post = (url, body = {}) => requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function note(id, text, error = false, feedback = false) {
    if (!feedback && (feedbackUntil.get(id) || 0) > Date.now()) return;
    if (feedback) feedbackUntil.set(id, Date.now() + 8000);
    const node = $(id); if (node) { node.textContent = text; node.className = (error ? 'bad-text' : 'muted') + ' small'; }
  }
  const date = value => value ? new Date(value).toLocaleString() : '';
  async function action(button, fn, statusId) {
    if (button.disabled) return;
    button.disabled = true; button.dataset.working = 'true';
    try { const result = await fn(); if (result && result.ok === false) throw new Error(result.error || 'This action could not complete.'); }
    catch (error) { note(statusId, error.message || 'Could not complete this action.', true, true); }
    finally { delete button.dataset.working; button.disabled = false; await refresh(); }
  }

  function setupPhotos() {
    const host = $('gp-sec'); if (!host) return;
    const heading = host.querySelector('.sec-title'); heading.textContent = 'Google Photos';
    const existing = [...host.children].filter(node => node !== heading && !node.contains($('gp-where')));
    const experimental = document.createElement('details'); experimental.id = 'gp-browser-details';
    const summary = document.createElement('summary'); summary.textContent = 'Experimental browser import'; experimental.append(summary);
    for (const node of existing) experimental.append(node);
    const oldIntro = experimental.querySelector('p');
    if (oldIntro) oldIntro.textContent = 'Google may reject sign-in from an automated browser. This optional connector can also break when the Photos website changes. A saved session is not proof that the connection works. Use the Takeout import above for a full-library export.';
    const primary = document.createElement('div');
    primary.innerHTML = `<p class="muted small">Import your Google Photos export with original files and dates. This works without signing in inside WhatsBackUp.</p>
      <ol class="muted small"><li><a href="https://takeout.google.com/" target="_blank" rel="noopener">Open Google Takeout</a> in your normal browser and select Google Photos.</li><li>Download every ZIP part and extract them into one folder.</li><li>Choose the extracted Google Photos folder below. Already imported files are skipped.</li></ol>
      <label class="lbl" for="gp-takeout-folder">Extracted Google Photos folder</label>
      <div class="row wrap"><input id="gp-takeout-folder" class="txt" style="width:100%;min-width:0" placeholder="C:\\Downloads\\Takeout\\Google Photos" autocomplete="off" spellcheck="false"></div>
      <div class="row wrap"><button id="gp-takeout-pick" type="button" class="btn">Choose folder…</button><button id="gp-takeout-import" type="button" class="btn primary">Import exported folder</button><button id="gp-takeout-stop" type="button" class="btn hidden">Stop import</button></div>
      <p id="gp-takeout-status" class="muted small" role="status" aria-live="polite"></p><p id="gp-takeout-last" class="muted small"></p>
      <p class="muted small">Copies photos and videos into this archive; your export is kept. JSON sidecars supply dates and descriptions. This is a local import, not automatic Google Photos synchronization. <a href="https://support.google.com/accounts/answer/3024190" target="_blank" rel="noopener">Google’s export guide</a></p>`;
    const takeoutDetails = document.createElement('details'); takeoutDetails.id = 'gp-takeout-details';
    const takeoutSummary = document.createElement('summary'); takeoutSummary.textContent = 'Import a whole-library export with Google Takeout'; takeoutDetails.append(takeoutSummary, primary);
    const picker = document.createElement('div'); picker.id = 'gp-picker-panel';
    picker.innerHTML = `<p class="muted small">Connect through Google’s official photo picker in your normal browser. Choose the photos and videos you want to import, then bring that selection into this archive.</p>
      <div class="row wrap"><button id="gp-picker-connect" class="btn primary" type="button">Connect Google Photos…</button><button id="gp-picker-choose" class="btn" type="button">Choose photos…</button><button id="gp-picker-import" class="btn" type="button">Import selection</button><button id="gp-picker-stop" class="btn hidden" type="button">Cancel selection</button><button id="gp-picker-disconnect" class="btn danger" type="button">Disconnect Google Photos</button></div>
      <p id="gp-picker-status" class="muted small" role="status" aria-live="polite">Checking Google Photos connection…</p><p id="gp-picker-last" class="muted small"></p>
      <div class="row wrap"><button id="gp-picker-check" class="btn small hidden" type="button">Check selection</button><button id="gp-picker-setup" class="btn small" type="button">Google connection setup</button></div>
      <p class="muted small">Only the items you select are accessible. Up to 2,000 items per selection and 2 GB per downloaded file. Google photo downloads omit location metadata; videos are Google’s high-quality transcoded downloads. Use Takeout below when you need the full export and original files.</p>`;
    heading.after(picker, takeoutDetails); host.append(experimental);
    const googleSetup = () => { const details = $('gmail-setup'); if (details) details.open = true; $('gmail-client-id')?.focus(); $('gmail-sec')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
    $('gp-picker-setup').onclick = googleSetup;
    $('gp-picker-connect').onclick = event => action(event.currentTarget, async () => {
      if (!latestPicker?.configured) { googleSetup(); return; }
      if (!desktop?.connectGooglePhotos) throw new Error('Connect Google Photos from the updated desktop app so Google can return authorization securely.');
      const result = await desktop.connectGooglePhotos(); if (!result?.ok) throw new Error(result?.error || 'Google Photos could not start sign-in.');
    }, 'gp-picker-status');
    $('gp-picker-choose').onclick = event => action(event.currentTarget, async () => {
      if (!desktop?.chooseGooglePhotos) throw new Error('Choose photos from the updated desktop app to open Google’s picker in your normal browser.');
      const result = await desktop.chooseGooglePhotos(); if (!result?.ok) throw new Error(result?.error || 'Google Photos could not open a selection.');
    }, 'gp-picker-status');
    $('gp-picker-import').onclick = event => action(event.currentTarget, () => post('/api/google-photos/picker/import'), 'gp-picker-status');
    $('gp-picker-check').onclick = event => action(event.currentTarget, () => post('/api/google-photos/picker/check'), 'gp-picker-status');
    $('gp-picker-stop').onclick = event => action(event.currentTarget, () => post('/api/google-photos/picker/cancel'), 'gp-picker-status');
    $('gp-picker-disconnect').onclick = event => action(event.currentTarget, () => post('/api/google-photos/picker/disconnect'), 'gp-picker-status');
    $('gp-takeout-pick').onclick = event => action(event.currentTarget, async () => {
      if (!desktop?.pickFolder) throw new Error('Paste the extracted folder path above, or use Choose folder in the updated desktop app.');
      const folder = await desktop.pickFolder({ title: 'Choose extracted Google Photos Takeout folder', defaultPath: $('gp-takeout-folder').value || undefined });
      if (folder) $('gp-takeout-folder').value = folder;
    }, 'gp-takeout-status');
    $('gp-takeout-import').onclick = event => action(event.currentTarget, async () => {
      let folder = $('gp-takeout-folder').value.trim();
      if (!folder && desktop?.pickFolder) { folder = await desktop.pickFolder({ title: 'Choose extracted Google Photos Takeout folder' }); if (folder) $('gp-takeout-folder').value = folder; }
      if (!folder) throw new Error('Choose the extracted Google Photos folder first. ZIP files must be extracted before import.');
      await post('/api/google-photos/import-folder', { folder });
      note('gp-takeout-status', 'Reading your exported files…');
    }, 'gp-takeout-status');
    $('gp-takeout-stop').onclick = event => action(event.currentTarget, () => post('/api/google-photos/cancel'), 'gp-takeout-status');
  }

  function setupGmail() {
    const cloud = $('cloud-sec'); if (!cloud) return;
    const host = document.createElement('section'); host.id = 'gmail-sec'; host.className = 'sec'; host.setAttribute('aria-label', 'Gmail attachment import');
    host.innerHTML = `<div class="sec-title">Gmail attachments</div>
      <p class="muted small">Find attachments in Gmail and save their original files in this archive, with sender, subject and date. Google’s read-only Gmail permission lets this app read mail. It cannot send, change or delete messages.</p>
      <p id="gmail-status" role="status" aria-live="polite" class="muted small">Checking Gmail connection…</p><p id="gmail-last" class="muted small"></p>
      <div class="row wrap"><button id="gmail-connect" class="btn primary" type="button">Connect Gmail…</button><button id="gmail-sync" class="btn" type="button">Import attachments</button><button id="gmail-stop" class="btn hidden" type="button">Stop import</button><button id="gmail-disconnect" class="btn danger" type="button">Disconnect Gmail</button></div>
      <details id="gmail-setup"><summary>Google connection setup · shared Desktop OAuth client</summary>
        <p class="muted small">A real Google Desktop OAuth client is required. This app has no shared client ID. Your Google sign-in opens in your normal browser; your password stays with Google.</p>
        <ol class="muted small"><li>Create or select a Google Cloud project. Enable <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a> for mail attachments and <a href="https://console.cloud.google.com/apis/library/photospicker.googleapis.com" target="_blank" rel="noopener">Google Photos Picker API</a> for photo selections.</li><li>Configure the OAuth consent screen. If the app is in testing, add your own Google account as a test user.</li><li>Create an OAuth client of type <b>Desktop app</b>. Copy its client ID and optional client secret below.</li><li>Save the client, then choose Connect Gmail or Connect Google Photos. Each service asks for its own permission and keeps a separate connection.</li></ol>
        <p class="muted small"><a href="https://developers.google.com/workspace/gmail/api/quickstart/nodejs" target="_blank" rel="noopener">Google’s desktop OAuth setup guide</a></p>
        <label class="lbl" for="gmail-client-id">Desktop OAuth client ID</label><div class="row"><input id="gmail-client-id" class="txt" style="width:100%;min-width:0" placeholder="…apps.googleusercontent.com" autocomplete="off" spellcheck="false"></div>
        <label class="lbl" for="gmail-client-secret">Client secret, if Google provided one</label><div class="row"><input id="gmail-client-secret" class="txt" type="password" style="width:100%;min-width:0" placeholder="Leave blank to keep a saved secret" autocomplete="new-password"></div>
        <div class="row wrap"><button id="gmail-save-client" class="btn" type="button">Save Google client</button><span id="gmail-client-note" class="muted small" role="status"></span></div>
        <p class="muted small">Client secrets and Google tokens are encrypted in Windows storage. They are not saved in browser storage.</p>
      </details>
      <div class="sec-title" style="margin-top:18px;font-size:12px">What to import</div>
      <label class="lbl" for="gmail-query">Gmail search</label><div class="row"><input id="gmail-query" class="txt" style="width:100%;min-width:0" value="has:attachment" placeholder="has:attachment newer_than:1y" maxlength="3000"></div>
      <p class="muted small">Use Gmail search to narrow the import, for example <code>has:attachment filename:pdf</code>. Each saved file retains its message provenance.</p>
      <div class="row wrap"><label class="muted small" for="gmail-max-size">Largest attachment (MB) <input id="gmail-max-size" class="num" type="number" min="1" max="1000" value="25"></label><label class="muted small" for="gmail-max-messages">Messages per run <input id="gmail-max-messages" class="num" type="number" min="1" max="10000" value="500"></label></div>
      <label class="row toggle"><input id="gmail-enabled" type="checkbox"><span class="switch"></span><span>Enable scheduled Gmail imports</span></label>
      <div class="row wrap"><label class="muted small" for="gmail-sync-minutes">Import every <select id="gmail-sync-minutes" class="txt"><option value="0">Only when I click</option><option value="15">15 minutes</option><option value="60">Hour</option><option value="360">6 hours</option><option value="1440">Day</option></select></label><button id="gmail-save-options" class="btn" type="button">Save Gmail options</button></div>
      <p id="gmail-options-note" class="muted small" role="status"></p><p id="gmail-count" class="muted small"></p>`;
    cloud.before(host);
    for (const id of ['gmail-query', 'gmail-max-size', 'gmail-max-messages', 'gmail-enabled', 'gmail-sync-minutes']) $(id).addEventListener('input', () => { gmailDirty = true; note('gmail-options-note', 'Options changed — choose Save Gmail options.'); });
    $('gmail-save-client').onclick = event => action(event.currentTarget, async () => {
      if (!desktop?.configureGmail) throw new Error('Save the Google client in the updated Windows desktop app.');
      const clientId = $('gmail-client-id').value.trim(), clientSecret = $('gmail-client-secret').value.trim();
      if (!clientId) throw new Error('Paste your Google Desktop OAuth client ID first.');
      const result = await desktop.configureGmail({ clientId, ...(clientSecret ? { clientSecret } : {}) });
      if (!result?.ok) throw new Error(result?.error || 'Could not save the Google client.');
      $('gmail-client-secret').value = ''; note('gmail-client-note', 'Google client saved. Choose Connect Gmail or Connect Google Photos.');
    }, 'gmail-client-note');
    $('gmail-connect').onclick = event => action(event.currentTarget, async () => {
      if (!desktop?.connectGmail) throw new Error('Connect Gmail from the updated desktop app so Google can return sign-in securely.');
      const result = await desktop.connectGmail();
      if (!result?.ok) throw new Error(result?.error || 'Could not start Google sign-in.');
      note('gmail-status', 'Complete Google sign-in in your normal browser.');
    }, 'gmail-status');
    $('gmail-sync').onclick = event => action(event.currentTarget, () => post('/api/gmail/sync'), 'gmail-status');
    $('gmail-stop').onclick = event => action(event.currentTarget, () => post('/api/gmail/cancel'), 'gmail-status');
    $('gmail-disconnect').onclick = event => action(event.currentTarget, () => post('/api/gmail/disconnect'), 'gmail-status');
    $('gmail-save-options').onclick = event => action(event.currentTarget, saveGmailOptions, 'gmail-options-note');
  }

  async function saveGmailOptions() {
    const body = { gmailEnabled: $('gmail-enabled').checked, gmailQuery: $('gmail-query').value.trim(), gmailSyncMinutes: Number($('gmail-sync-minutes').value), gmailMaxAttachmentMB: Number($('gmail-max-size').value), gmailMaxMessagesPerSync: Number($('gmail-max-messages').value) };
    if (!body.gmailQuery) throw new Error('Enter a Gmail search, such as has:attachment.');
    if (!Number.isInteger(body.gmailMaxAttachmentMB) || body.gmailMaxAttachmentMB < 1 || body.gmailMaxAttachmentMB > 1000 || !Number.isInteger(body.gmailMaxMessagesPerSync) || body.gmailMaxMessagesPerSync < 1 || body.gmailMaxMessagesPerSync > 10000) throw new Error('Use 1–1,000 MB and 1–10,000 messages per run.');
    const result = await post('/api/settings', body);
    if (result.rejected?.some(key => key.startsWith('gmail'))) throw new Error('One Gmail option was rejected. Check the limits and try again.');
    gmailDirty = false; note('gmail-options-note', 'Gmail options saved.');
  }

  function renderPhotos(state) {
    if (!$('gp-takeout-status')) return;
    const run = state.lastRun, progress = state.progress || {};
    if (state.busy && progress.phase === 'takeout') note('gp-takeout-status', `${state.stopping ? 'Stopping…' : 'Reading export…'} ${progress.found || 0} found · ${progress.saved || 0} saved · ${progress.skipped || 0} already saved · ${progress.failed || 0} failed`);
    else if (state.busy) note('gp-takeout-status', state.status === 'connecting' ? 'Experimental browser sign-in is open. Google may reject it; Takeout import does not need it.' : 'An experimental browser import is running.');
    else if (state.lastError) note('gp-takeout-status', state.lastError, true);
    else if (run?.method === 'takeout') note('gp-takeout-status', run.cancelled ? 'Import stopped. Saved files were kept; import this folder again to continue.' : run.complete ? 'Export imported. Choose another exported folder whenever you want to add more.' : 'Export import incomplete. Retry to add the remaining files.');
    else note('gp-takeout-status', state.hasSavedSession && !state.connectionVerified ? 'A browser session is saved, but its connection has not been verified. Importing a Takeout export does not need that session.' : 'Ready to import your extracted Google Photos export.');
    const bits = run ? [`${run.method === 'takeout' ? 'Export' : 'Browser'} import: ${run.saved || 0} saved · ${run.skipped || 0} already saved · ${run.failed || 0} failed`, date(run.finishedAt || run.at)] : [];
    note('gp-takeout-last', bits.filter(Boolean).join(' · '));
    for (const id of ['gp-takeout-pick', 'gp-takeout-import']) $(id).disabled = !!state.busy || !!latestPicker?.busy || $(id).dataset.working === 'true';
    $('gp-takeout-stop').classList.toggle('hidden', !state.busy); $('gp-takeout-stop').disabled = !!state.stopping;
    $('gp-takeout-stop').textContent = state.status === 'connecting' ? 'Cancel sign-in' : 'Stop import';
    if (run?.finishedAt && !state.busy && run.finishedAt !== lastPhotosImport) { lastPhotosImport = run.finishedAt; if (run.saved) { loadItems(true); fillSourceWhere(); } }
  }

  function renderPicker(state, legacy = {}) {
    latestPicker = state; if (!$('gp-picker-status')) return;
    const session = state.session, run = state.lastRun, progress = state.progress || {};
    const text = state.lastError && !state.busy ? state.lastError : state.status === 'connecting' ? 'Complete Google Photos authorization in your normal browser.'
      : state.busy && state.status === 'scanning' ? `${state.stopping ? 'Stopping…' : 'Importing selection…'} ${progress.processed || 0} / ${progress.selected || 0} checked · ${progress.saved || 0} saved · ${progress.skipped || 0} already saved · ${progress.failed || 0} failed`
      : session?.ready ? 'Your Google Photos selection is ready. Choose Import selection.' : session ? 'Choose your photos in the Google Photos browser tab and press Done there. This app will check for your completed selection.'
        : state.linked ? 'Connected through Google Photos Picker. Choose photos to start an import.' : !state.configured ? 'Setup required: add a Google Desktop OAuth client below and enable Google Photos Picker API.' : 'Google client saved. Connect Google Photos to allow access to the photos you select.';
    note('gp-picker-status', text, !!state.lastError && !state.busy);
    $('gp-picker-connect').textContent = !state.configured ? 'Set up Google connection' : state.linked ? 'Reconnect Google Photos…' : 'Connect Google Photos…';
    for (const id of ['gp-picker-connect', 'gp-picker-choose', 'gp-picker-import', 'gp-picker-disconnect']) $(id).disabled = !!state.busy || !!legacy.busy || $(id).dataset.working === 'true';
    $('gp-picker-choose').disabled ||= !state.linked;
    $('gp-picker-import').disabled ||= !session?.ready;
    $('gp-picker-disconnect').disabled ||= !state.linked;
    $('gp-picker-stop').classList.toggle('hidden', !(state.busy || session)); $('gp-picker-stop').disabled = !!state.stopping;
    $('gp-picker-stop').textContent = state.status === 'connecting' ? 'Cancel sign-in' : state.status === 'scanning' ? 'Stop import' : 'Cancel selection';
    $('gp-picker-check').classList.toggle('hidden', !session || session.ready); $('gp-picker-check').disabled = !!state.busy || !!legacy.busy;
    note('gp-picker-last', run ? `${run.saved || 0} saved · ${run.duplicates || 0} duplicate files · ${run.failed || 0} failed · ${date(run.finishedAt || run.at)}${run.cancelled ? ' · stopped, completed files kept' : ''}` : 'No Google Photos Picker import completed yet.');
    if (run?.finishedAt && !state.busy && run.finishedAt !== lastPickerImport) { lastPickerImport = run.finishedAt; if (run.saved) { loadItems(true); fillSourceWhere(); } }
  }

  function renderGmail(state) {
    if (!$('gmail-status')) return;
    const progress = state.progress || {}, run = state.lastRun;
    let text = state.busy ? state.status === 'connecting' ? 'Complete Google sign-in in your normal browser.' : `${state.stopping ? 'Stopping…' : 'Importing…'} ${progress.messages || 0} messages checked · ${progress.saved || 0} saved · ${progress.duplicates || 0} duplicate files · ${progress.failed || 0} failed${progress.currentFile ? ' · ' + progress.currentFile : ''}`
      : state.lastError ? state.lastError : state.linked ? `Connected${state.account ? ' as ' + state.account : ''}. Read-only access.` : !state.configured ? 'Setup required: add your Google Desktop OAuth client, then connect Gmail.' : 'Google client saved. Choose Connect Gmail to grant read-only access.';
    note('gmail-status', text, !!state.lastError && !state.busy);
    const last = run ? `${run.saved || 0} attachments saved · ${run.duplicates || 0} duplicates · ${run.skipped || 0} skipped · ${run.failed || 0} failed · ${date(run.finishedAt || run.at)}${run.cancelled ? ' · stopped, completed files kept' : run.complete === false ? ' · incomplete' : ''}` : 'No attachment import completed yet.';
    note('gmail-last', last + (state.nextScanAt && !state.busy ? ' · next import ' + date(state.nextScanAt) : ''));
    $('gmail-connect').disabled = !!state.busy || !state.configured || $('gmail-connect').dataset.working === 'true';
    $('gmail-sync').disabled = !!state.busy || !state.linked || $('gmail-sync').dataset.working === 'true';
    $('gmail-disconnect').disabled = !!state.busy || !state.linked || $('gmail-disconnect').dataset.working === 'true';
    $('gmail-stop').classList.toggle('hidden', !state.busy); $('gmail-stop').disabled = !!state.stopping;
    $('gmail-stop').textContent = state.status === 'connecting' ? 'Cancel sign-in' : 'Stop import';
    if (!state.configured) $('gmail-setup').open = true;
    if (run?.finishedAt && !state.busy && run.finishedAt !== lastGmailImport) { lastGmailImport = run.finishedAt; if (run.saved) { loadItems(true); fillSourceWhere(); refreshCounts(); } }
  }

  async function refreshCounts() {
    try { const summary = await requestJson('/api/sources/summary'); const count = summary.gmail?.count || 0; note('gmail-count', `${count.toLocaleString()} saved Gmail attachments in this archive. Filter the Library by Gmail to see their provenance.`); } catch (_) {}
  }
  async function loadOptions() {
    if (!$('gmail-query') || gmailDirty) return;
    try {
      const value = (await requestJson('/api/settings')).settings;
      $('gmail-query').value = value.gmailQuery || 'has:attachment'; $('gmail-enabled').checked = !!value.gmailEnabled;
      $('gmail-max-size').value = value.gmailMaxAttachmentMB || 25; $('gmail-max-messages').value = value.gmailMaxMessagesPerSync || 500;
      const minutes = String(value.gmailSyncMinutes || 0), select = $('gmail-sync-minutes');
      if (![...select.options].some(option => option.value === minutes)) select.add(new Option(minutes + ' minutes', minutes));
      select.value = minutes;
      if (document.activeElement !== $('gmail-client-id')) $('gmail-client-id').value = value.gmailClientId || '';
      if (value.gmailSecretStored) note('gmail-client-note', 'A client secret is stored securely. Leave the secret blank to keep it.');
    } catch (error) { note('gmail-options-note', 'Could not load Gmail options: ' + error.message, true); }
  }
  async function refresh() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      const results = await Promise.allSettled([requestJson('/api/google-photos/state'), requestJson('/api/gmail/state'), requestJson('/api/google-photos/picker/state')]);
      if (results[2].status === 'fulfilled') {
        let picker = results[2].value;
        if (picker.status === 'choosing' && picker.session && !picker.session.ready && !picker.busy && !(results[0].status === 'fulfilled' && results[0].value.busy) && Date.now() >= (picker.session.nextCheckAt || 0)) {
          try { const checked = await post('/api/google-photos/picker/check'); if (checked.ok) picker = await requestJson('/api/google-photos/picker/state'); } catch (_) {}
        }
        renderPicker(picker, results[0].status === 'fulfilled' ? results[0].value : {});
      } else note('gp-picker-status', 'Google Photos Picker status is unavailable. Update and restart the desktop app.', true);
      if (results[0].status === 'fulfilled') renderPhotos(results[0].value); else note('gp-takeout-status', 'Google Photos import status is unavailable. Retry after restarting the app.', true);
      if (results[1].status === 'fulfilled') renderGmail(results[1].value); else note('gmail-status', 'Gmail status is unavailable. Update and restart the desktop app.', true);
    } finally { refreshing = false; }
  }
  function start() { active = true; loadOptions(); refreshCounts(); refresh(); clearInterval(timer); timer = setInterval(() => { if (active) refresh(); }, 2500); }
  function stop() { active = false; clearInterval(timer); timer = null; if ($('gmail-client-secret')) $('gmail-client-secret').value = ''; }
  setupPhotos(); setupGmail();
  const shortcuts=document.createElement('nav');shortcuts.className='source-shortcuts row wrap';shortcuts.setAttribute('aria-label','Jump to a source');
  for(const [name,id]of [['WhatsApp','conn-status'],['ChatGPT','cgpt-status'],['Gemini','gem-status'],['Google Photos','gp-sec'],['Gmail','gmail-sec'],['Cloud folder','cloud-sec']]){
    const button=document.createElement('button');button.type='button';button.className='btn small';button.textContent=name;button.onclick=()=>{const target=$(id);(target?.closest('.sec')||target)?.scrollIntoView({block:'start',behavior:'auto'});};shortcuts.append(button);
  }
  document.querySelector('[data-pane="connection"]')?.prepend(shortcuts);
  if (typeof SourceCards !== 'undefined') SourceCards.push({ start, stop, refresh });
  return { start, stop, refresh };
})();
