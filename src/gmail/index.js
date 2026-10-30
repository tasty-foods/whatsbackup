'use strict';
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { startLoopback, tokenRequest, SCOPE } = require('./auth');
const { createApi } = require('./client');
const mime = require('./mime');
const files = require('./files');
const clamp = (value, low, high, fallback) => Math.max(low, Math.min(high, Number(value) || fallback));

function createConnector({ settings, cfg, paths, store, history, fetchImpl = fetch, noteNewMedia = () => {}, nudgeBackup = () => {} }) {
  const journalFile = path.join(paths.DATA_DIR, 'gmail-attachments.ndjson');
  const checkpointFile = path.join(paths.DATA_DIR, 'gmail-checkpoint.json');
  const state = { status: 'off', linked: false, account: null, busy: false, stopping: false, lastError: null, lastRun: null, lastScanAt: null, nextScanAt: null, progress: null, resumable: false };
  let vault = null, tokens = null, loaded = false, loading = null, refreshing = null, clientSecret = '', session = null, timer = null, controller = null, activeRun = null, closing = false;
  function setVault(value) { vault = value; tokens = null; loaded = false; loading = null; }
  function setClientSecret(value) { clientSecret = typeof value === 'string' ? value.slice(0, 16384) : ''; }
  const readyVault = () => !!vault && ['load', 'save', 'clear'].every(key => typeof vault[key] === 'function');
  async function loadTokens() {
    if (loaded) return tokens;
    if (!readyVault()) throw new Error('Gmail requires the installed desktop app to save its connection securely.');
    if (!loading) loading = (async () => {
      const value = await vault.load();
      tokens = value && typeof value === 'object' && typeof value.clientId === 'string' && (typeof value.refreshToken === 'string' || typeof value.accessToken === 'string') ? value : null;
      loaded = true; state.linked = !!tokens; state.account = tokens?.account || null;
      return tokens;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function persistTokens(value) {
    if (!readyVault()) throw new Error('Secure Gmail storage is unavailable. Restart the desktop app.');
    const result = await vault.save(value);
    if (result === false || result?.ok === false) throw new Error('Gmail credentials could not be saved securely. Restart the desktop app and connect again.');
    tokens = value; loaded = true; state.linked = true; state.account = value.account || null;
  }
  async function refreshToken(signal) {
    await loadTokens();
    if (!tokens?.refreshToken) throw new Error('Connect Gmail again to renew authorization.');
    const clientId = String(settings.read().gmailClientId || '').trim();
    if (clientId !== tokens.clientId) throw new Error('The Google OAuth client changed. Connect Gmail again.');
    if (!refreshing) refreshing = (async () => {
      const fields = { client_id: clientId, grant_type: 'refresh_token', refresh_token: tokens.refreshToken };
      if (clientSecret) fields.client_secret = clientSecret;
      const fresh = await tokenRequest(fields, { fetchImpl, signal });
      signal?.throwIfAborted();
      await persistTokens({ ...tokens, ...fresh, refreshToken: fresh.refreshToken || tokens.refreshToken });
      return fresh.accessToken;
    })().catch(error => { if (error.reconnect) { state.linked = false; state.status = 'unlinked'; } throw error; }).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function getAccessToken(signal) {
    await loadTokens();
    if (!tokens) throw new Error('Connect Gmail first.');
    if (String(settings.read().gmailClientId || '').trim() !== tokens.clientId) throw new Error('The Google OAuth client changed. Connect Gmail again.');
    return tokens.accessToken && Number(tokens.expiresAt) > Date.now() + 60000 ? tokens.accessToken : refreshToken(signal);
  }
  const api = createApi({ getAccessToken, refreshToken, fetchImpl });
  function status() {
    const s = settings.read();
    return { ...state, progress: state.progress ? { ...state.progress } : null, enabled: !!s.gmailEnabled, configured: !!String(s.gmailClientId || '').trim(), vaultConfigured: readyVault(), query: String(s.gmailQuery || 'has:attachment'), syncMinutes: Number(s.gmailSyncMinutes) || 0, maxAttachmentMB: clamp(s.gmailMaxAttachmentMB, 1, 100, 25), maxMessagesPerSync: clamp(s.gmailMaxMessagesPerSync, 1, 5000, 500) };
  }
  async function beginConnect() {
    if (state.busy || session) return { ok: false, error: 'Stop the Gmail import or current sign-in before connecting again.' };
    if (!readyVault()) return { ok: false, error: 'Connect Gmail from the installed desktop app so credentials can be stored securely.' };
    clearTimeout(timer); state.nextScanAt = null; state.lastError = null; state.status = 'connecting'; state.busy = true;
    try {
      session = await startLoopback({ clientId: String(settings.read().gmailClientId || '').trim(), clientSecret, fetchImpl,
        onTokens: async (fresh, signal) => {
          const profile = await api.profile({ token: fresh.accessToken, signal });
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(profile.emailAddress || ''))) throw new Error('Google returned no Gmail account identity. Connect again.');
          signal.throwIfAborted();
          await persistTokens({ ...fresh, account: profile.emailAddress.toLowerCase(), scope: fresh.scope || SCOPE });
          return { account: state.account };
        },
      });
      const current = session;
      current.result.then(() => { state.status = 'linked'; state.lastError = null; }, error => { state.status = state.linked ? 'linked' : 'unlinked'; state.lastError = error.message; }).finally(() => { if (session === current) session = null; state.busy = false; schedule(); });
      return { ok: true, authUrl: current.authUrl, expiresAt: current.expiresAt };
    } catch (error) { state.busy = false; state.status = state.linked ? 'linked' : 'unlinked'; state.lastError = error.message; schedule(); return { ok: false, error: error.message }; }
  }
  async function readCheckpoint() {
    try {
      const raw = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
      return raw && typeof raw.account === 'string' && Array.isArray(raw.pending) ? raw : null;
    } catch (_) { return null; }
  }
  async function writeCheckpoint(value) {
    await fs.mkdir(paths.DATA_DIR, { recursive: true });
    if (!value) { await fs.unlink(checkpointFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); state.resumable = false; return; }
    await fs.writeFile(checkpointFile + '.tmp', JSON.stringify(value), { mode: 0o600 });
    await fs.rename(checkpointFile + '.tmp', checkpointFile); state.resumable = true;
  }
  async function readJournal() {
    const aliases = new Map();
    try {
      const input = nativeFs.createReadStream(journalFile, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      let inputError;
      input.on('error', error => { inputError = error; lines.close(); });
      for await (const line of lines) {
        if (line.length > 65536) continue;
        try { const row = JSON.parse(line); if (/^gmail_[a-f0-9]{64}$/.test(row.id) && typeof row.recordId === 'string' && /^[a-f0-9]{64}$/.test(row.hash)) aliases.set(row.id, row); } catch (_) {}
      }
      if (inputError) throw inputError;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return aliases;
  }
  async function appendAlias(row) { await fs.mkdir(paths.DATA_DIR, { recursive: true }); await fs.appendFile(journalFile, JSON.stringify(row) + '\n', { mode: 0o600 }); }
  async function verifiedRecord(record, expectedHash, signal) {
    if (!record || record.source !== 'gmail' || !record.filename || path.basename(record.filename) !== record.filename || record.hash !== expectedHash) return false;
    const directories = record.kind === 'image' ? [cfg.IMAGES_DIR] : record.kind === 'video' ? [cfg.LOCAL_VIDEO_DIR, cfg.VIDEO_DIR] : [cfg.FILES_DIR];
    for (const directory of new Set(directories.filter(Boolean))) {
      try { if (await files.hashFile(path.join(directory, record.filename), signal) === expectedHash) return true; }
      catch (_) { signal?.throwIfAborted(); }
    }
    return false;
  }
  async function sync({ reason = 'manual' } = {}) {
    if (state.busy || session) return { ok: false, error: 'Gmail is already busy.' };
    state.busy = true; state.status = 'scanning'; state.lastError = null; state.stopping = false; state.nextScanAt = null; clearTimeout(timer);
    controller = new AbortController(); const signal = controller.signal;
    const run = { saved: 0, images: 0, videos: 0, documents: 0, audio: 0, messages: 0, skipped: 0, duplicates: 0, failed: 0, complete: false, cancelled: false, firstError: null, issues: [], at: Date.now(), reason };
    state.progress = { phase: 'messages', messages: 0, saved: 0, skipped: 0, duplicates: 0, failed: 0 };
    const task = (async () => {
      let checkpoint;
      const issue = (name, error) => { run.firstError ||= error; if (run.issues.length < 25) run.issues.push({ name: String(name || 'Gmail attachment').slice(0, 300), error }); };
      const progress = () => { Object.assign(state.progress, { messages: run.messages, saved: run.saved, skipped: run.skipped, duplicates: run.duplicates, failed: run.failed }); };
      try {
        await loadTokens(); signal.throwIfAborted();
        const profile = await api.profile({ signal });
        const account = String(profile.emailAddress || '').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) throw new Error('Could not identify this Gmail account. Connect again.');
        state.account = account; state.linked = true;
        const s = settings.read(), query = String(s.gmailQuery || 'has:attachment').slice(0, 2000), maxMessages = Math.floor(clamp(s.gmailMaxMessagesPerSync, 1, 5000, 500));
        const limitBytes = Math.floor(clamp(s.gmailMaxAttachmentMB, 1, 100, 25) * 1024 * 1024), jsonLimit = Math.ceil(limitBytes / 3) * 4 + 4 * 1024 * 1024;
        const aliases = await readJournal(), candidates = new Map(), verified = new Set(), tried = new Set(), listedPages = new Set();
        for (const record of store.listRecords({})) if (record.source === 'gmail' && /^[a-f0-9]{64}$/.test(record.hash)) { if (!candidates.has(record.hash)) candidates.set(record.hash, []); candidates.get(record.hash).push(record); }
        checkpoint = await readCheckpoint();
        if (checkpoint?.account !== account || checkpoint?.query !== query) checkpoint = { account, query, pageToken: '', nextPageToken: '', pending: [], atEnd: false };
        await writeCheckpoint(checkpoint);
        while (run.messages < maxMessages) {
          signal.throwIfAborted();
          if (!checkpoint.pending.length) {
            if (checkpoint.atEnd) { run.complete = true; await writeCheckpoint(null); break; }
            const pageKey = checkpoint.pageToken || 'first';
            if (listedPages.has(pageKey)) throw new Error('Gmail repeated a page token. Retry the import later.');
            listedPages.add(pageKey);
            const page = await api.list({ query, pageToken: checkpoint.pageToken, maxResults: Math.min(100, maxMessages - run.messages), signal });
            checkpoint.pending = [...new Set((page.messages || []).map(item => String(item.id || '')).filter(Boolean))];
            checkpoint.nextPageToken = String(page.nextPageToken || ''); checkpoint.atEnd = !checkpoint.nextPageToken;
            await writeCheckpoint(checkpoint);
            if (!checkpoint.pending.length) { checkpoint.pageToken = checkpoint.nextPageToken; continue; }
          }
          const messageId = checkpoint.pending.find(id => !tried.has(id));
          if (!messageId) break; // Failed messages remain queued for the next run.
          tried.add(messageId); run.messages++; state.progress.phase = 'messages';
          let messageComplete = true;
          try {
            const message = await api.message(messageId, { signal, limit: jsonLimit });
            for (const part of mime.attachments(message.payload)) {
              signal.throwIfAborted();
              const id = mime.recordId(account, messageId, part.partId), alias = aliases.get(id), prior = store.get(alias?.recordId || id);
              const hidden = store.hiddenIds?.() || new Set();
              if (prior && hidden.has(prior.id)) { run.skipped++; continue; }
              if (prior && await verifiedRecord(prior, alias?.hash || prior.hash, signal)) { run.skipped++; continue; }
              const original = mime.safeName(part.filename, part.mime);
              state.progress.phase = 'attachment'; state.progress.currentFile = original; progress();
              if (part.size > limitBytes) { run.skipped++; issue(original, 'Larger than the configured attachment limit. Raise the limit to import it on a later scan.'); continue; }
              let prepared;
              try {
                const body = part.attachmentId ? await api.attachment(messageId, part.attachmentId, { signal, limit: jsonLimit }) : part;
                const declaredSize = Number.isFinite(Number(body.size)) ? Number(body.size) : part.size;
                if (declaredSize > limitBytes) { run.skipped++; issue(original, 'Larger than the configured attachment limit.'); continue; }
                const provenance = mime.provenance({ ...message, id: messageId }, account, part);
                const kind = mime.mediaKind(part.mime, original), directory = kind === 'image' ? cfg.IMAGES_DIR : kind === 'video' ? cfg.LOCAL_VIDEO_DIR : cfg.FILES_DIR;
                const filename = new Date(provenance.originalTimestamp).toISOString().slice(0, 19).replace(/[-:T]/g, '') + '__gmail__' + id.slice(6, 38) + '__' + original;
                prepared = await files.saveAttachment({ data: body.data, directory, filename, limitBytes, declaredSize, signal });
                let canonical = null;
                for (const candidate of candidates.get(prepared.hash) || []) {
                  const key = candidate.id + ':' + prepared.hash;
                  if (verified.has(key) || await verifiedRecord(candidate, prepared.hash, signal)) { verified.add(key); canonical = candidate; break; }
                }
                if (canonical) { run.duplicates++; run.skipped++; }
                else {
                  await files.commitAttachment(prepared, signal);
                  canonical = { id, ts: provenance.originalTimestamp, importedAt: Date.now(), dateSource: 'gmail', dir: 'in', kind, source: 'gmail', chat: provenance.sender || 'Gmail', number: '', mimetype: part.mime, filename, docName: part.filename, serve: '/media/' + (kind === 'image' ? 'images/' : kind === 'video' ? 'videos/' : 'files/') + encodeURIComponent(filename), size: prepared.size, caption: provenance.subject, generated: false, cloud: false, hash: prepared.hash, ...provenance };
                  const added = store.addRecord(canonical);
                  if (added) { run.saved++; run[kind === 'image' ? 'images' : kind === 'video' ? 'videos' : kind === 'audio' ? 'audio' : 'documents']++; try { noteNewMedia(canonical); } catch (_) {} }
                  else run.skipped++;
                  if (!candidates.has(prepared.hash)) candidates.set(prepared.hash, []); candidates.get(prepared.hash).push(canonical); verified.add(canonical.id + ':' + prepared.hash);
                }
                const row = { id, recordId: canonical.id, hash: prepared.hash, size: prepared.size, provenance, importedAt: Date.now() };
                await appendAlias(row); aliases.set(id, row);
              } catch (error) {
                signal.throwIfAborted(); if (error.reconnect || error.status === 401 || error.status === 403 || error.status === 429) throw error;
                messageComplete = false; run.failed++; issue(original, error.message);
              } finally { if (prepared) await fs.unlink(prepared.temporary).catch(() => {}); progress(); }
            }
          } catch (error) {
            signal.throwIfAborted();
            if (error.reconnect || error.status === 401 || error.status === 403 || error.status === 429) throw error;
            if (error.status === 404) { run.skipped++; issue('Email no longer available', error.message); }
            else { messageComplete = false; run.failed++; issue('Email attachment scan', error.message); }
          }
          if (messageComplete) checkpoint.pending = checkpoint.pending.filter(id => id !== messageId);
          if (!checkpoint.pending.length && checkpoint.nextPageToken) { checkpoint.pageToken = checkpoint.nextPageToken; checkpoint.nextPageToken = ''; }
          await writeCheckpoint(checkpoint); progress();
        }
        if (!checkpoint.pending.length && checkpoint.atEnd) { run.complete = true; await writeCheckpoint(null); }
        state.status = run.failed ? 'error' : 'linked'; state.lastError = run.failed ? run.firstError : null;
        return { ok: !run.failed, ...run, resumable: state.resumable };
      } catch (error) {
        run.cancelled = signal.aborted;
        if (!run.cancelled) { run.failed++; issue('Gmail import', error.message); state.lastError = error.message; if (error.reconnect) state.linked = false; }
        state.status = state.linked ? run.cancelled ? 'linked' : 'error' : 'unlinked';
        return { ok: run.cancelled, error: run.cancelled ? undefined : error.message, ...run, resumable: state.resumable };
      } finally {
        run.finishedAt = Date.now(); state.lastRun = run; state.lastScanAt = run.finishedAt;
        try { history.write('gmail', run); } catch (_) {}
        state.busy = false; state.stopping = false; state.progress = null; controller = null; activeRun = null;
        if (run.saved) { try { nudgeBackup(); } catch (_) {} } schedule();
      }
    })();
    activeRun = task; return task;
  }
  function stop() {
    if (session) { session.cancel(); return { ok: true }; }
    if (!controller) return { ok: false, error: 'No Gmail import is running.' };
    state.stopping = true; controller.abort(new Error('Gmail import stopped. Your progress is saved.')); return { ok: true };
  }
  async function disconnect() {
    const pendingSession = session; pendingSession?.cancel();
    controller?.abort(new Error('Gmail disconnected.'));
    await Promise.allSettled([activeRun, pendingSession?.result].filter(Boolean));
    clearTimeout(timer); state.nextScanAt = null;
    try {
      if (!readyVault()) throw new Error('Open the installed desktop app to forget this connection securely.');
      const result = await vault.clear(); if (result === false || result?.ok === false) throw new Error('Could not clear the saved Gmail connection. Retry.');
      tokens = null; loaded = true; session = null; state.linked = false; state.account = null; state.status = 'unlinked'; state.lastError = null;
      return { ok: true };
    } catch (error) { state.lastError = error.message; return { ok: false, error: error.message }; }
  }
  function schedule() {
    clearTimeout(timer); timer = null; state.nextScanAt = null;
    const s = settings.read(), minutes = Number(s.gmailSyncMinutes) || 0;
    if (closing || !s.gmailEnabled || !state.linked || state.busy || session || minutes <= 0) return;
    const delay = clamp(minutes, 5, 10080, 60) * 60000; state.nextScanAt = Date.now() + delay;
    timer = setTimeout(() => { timer = null; if (settings.read().gmailEnabled) sync({ reason: 'scheduled' }).catch(() => {}); }, delay); timer.unref?.();
  }
  async function init() {
    closing = false; state.lastRun = history.read('gmail'); state.lastScanAt = state.lastRun?.finishedAt || null;
    try { await loadTokens(); state.resumable = !!await readCheckpoint(); state.status = state.linked ? 'linked' : settings.read().gmailEnabled ? 'unlinked' : 'off'; }
    catch (error) { state.status = 'unlinked'; state.lastError = error.message; }
    schedule();
  }
  async function shutdown() { closing = true; clearTimeout(timer); const current = session; current?.cancel(); controller?.abort(new Error('App closing; import progress is saved.')); await Promise.allSettled([activeRun, current?.result].filter(Boolean)); }
  return { setVault, setClientSecret, init, beginConnect, connect: beginConnect, disconnect, sync, scan: sync, stop, cancel: stop, schedule, status, getState: status, shutdown };
}

let instance;
function current() {
  if (!instance) instance = createConnector({ settings: require('../settings'), cfg: require('../config'), paths: require('../paths'), store: require('../store'), history: require('../source-history'), noteNewMedia: record => require('../ai').noteNewMedia(record), nudgeBackup: () => require('../backup').nudge() });
  return instance;
}
module.exports = { createConnector };
for (const method of ['setVault', 'setClientSecret', 'init', 'beginConnect', 'connect', 'disconnect', 'sync', 'scan', 'stop', 'cancel', 'schedule', 'status', 'getState', 'shutdown']) module.exports[method] = (...args) => current()[method](...args);
