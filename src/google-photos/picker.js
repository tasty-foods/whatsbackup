'use strict';
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const auth = require('./picker-auth');
const lock = require('./lock');
const { hashFile, mediaType } = require('./download');
const API = 'https://photospicker.googleapis.com/v1';
const MAX_ITEMS = 2000, MAX_BYTES = 2 * 1024 * 1024 * 1024;
const recordId = id => 'googlephotos_picker_' + crypto.createHash('sha256').update(id).digest('hex');
const safeName = value => path.win32.basename(path.posix.basename(String(value || 'Google Photos media'))).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
const duration = (text, fallback) => /^\d+(?:\.\d+)?s$/.test(String(text)) ? Number(String(text).slice(0, -1)) * 1000 : fallback;
const validPickerUri = value => { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'photos.google.com' && !url.username && !url.password && !url.port ? url.href : null; } catch (_) { return null; } };
function mediaUrl(value) {
  let url; try { url = new URL(value); } catch (_) {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !(/^(?:lh\d+|photos|video-downloads)\.googleusercontent\.com$/i.test(url.hostname) || /^(?:[a-z0-9-]+\.)+googlevideo\.com$/i.test(url.hostname))) throw new Error('Google returned an unexpected media download host. No credentials were sent.');
  return url;
}
const MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif', 'image/tiff': 'tiff', 'image/bmp': 'bmp', 'image/x-adobe-dng': 'dng', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/mpeg': 'mpeg', 'video/mp2t': 'mts', 'video/3gpp': '3gp' };

function createConnector({ settings, cfg, paths, store, history, fetchImpl = fetch, noteNewMedia = () => {}, nudgeBackup = () => {} }) {
  const state = { status: 'unlinked', linked: false, busy: false, stopping: false, lastError: null, lastRun: null, progress: null };
  const aliasesFile = path.join(paths.DATA_DIR, 'googlephotos-picker-seen.json');
  let vault = null, tokens = null, loaded = false, loading = null, refreshing = null, clientSecret = '', oauth = null, selection = null, controller = null, epoch = 0, disconnecting = false;
  const work = new Set(), saves = new Set();
  const clientId = () => String(settings.read().gmailClientId || '').trim();
  const readyVault = () => !!vault && ['load', 'save', 'clear'].every(key => typeof vault[key] === 'function');
  const tracked = task => { work.add(task); task.finally(() => work.delete(task)).catch(() => {}); return task; };
  const status = () => ({ ...state, configured: !!clientId(), vaultConfigured: readyVault(), progress: state.progress ? { ...state.progress } : null, session: selection ? { ready: selection.ready, pickerUri: selection.pickerUri, expiresAt: selection.expiresAt, pollIntervalMs: selection.pollIntervalMs, nextCheckAt: selection.nextCheckAt } : null, maxSelection: MAX_ITEMS, maxDownloadBytes: MAX_BYTES });
  function setVault(value) { vault = value; tokens = null; loaded = false; }
  function setClientSecret(value) { clientSecret = typeof value === 'string' ? value.slice(0, 16384) : ''; }
  async function loadTokens() {
    if (loaded) return tokens;
    if (!readyVault()) throw new Error('Connect Google Photos in the updated desktop app so credentials can be stored securely.');
    if (!loading) loading = (async () => {
      const value = await vault.load();
      tokens = value && value.clientId === clientId() && (typeof value.refreshToken === 'string' || typeof value.accessToken === 'string') && String(value.scope || '').split(/\s+/).includes(auth.SCOPE) ? value : null;
      loaded = true; state.linked = !!tokens; return tokens;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function persist(value, version = epoch) {
    if (version !== epoch || disconnecting || !readyVault()) throw new Error('Google Photos connection was stopped.');
    const task = Promise.resolve().then(() => vault.save(value)); saves.add(task);
    let result; try { result = await task; } finally { saves.delete(task); }
    if (result === false || result?.ok === false) throw new Error('The Google Photos connection could not be saved securely.');
    if (version !== epoch || disconnecting) throw new Error('Google Photos connection was stopped.');
    tokens = value; loaded = true; state.linked = true;
  }
  async function access(signal, force = false) {
    await loadTokens(); signal?.throwIfAborted();
    if (!tokens || tokens.clientId !== clientId()) throw new Error('Connect Google Photos first. Check the shared Google Desktop OAuth client setup.');
    if (!force && tokens.accessToken && Number(tokens.expiresAt) > Date.now() + 60000) return tokens.accessToken;
    if (!tokens.refreshToken) { state.linked = false; throw new Error('Google Photos authorization expired. Connect again.'); }
    if (!refreshing) {
      const version = epoch, previous = tokens;
      refreshing = auth.tokenRequest({ client_id: clientId(), grant_type: 'refresh_token', refresh_token: previous.refreshToken, ...(clientSecret ? { client_secret: clientSecret } : {}) }, { fetchImpl, signal })
        .then(async fresh => { signal?.throwIfAborted(); await persist({ ...previous, ...fresh, refreshToken: fresh.refreshToken || previous.refreshToken }, version); return fresh.accessToken; })
        .catch(error => { if (error.reconnect) { state.linked = false; state.status = 'unlinked'; } throw error; }).finally(() => { refreshing = null; });
    }
    return refreshing;
  }
  async function request(relative, { method = 'GET', body, signal, retry = true } = {}) {
    const token = await access(signal);
    const response = await fetchImpl(API + relative, { method, redirect: 'error', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (response.status === 401 && retry) { await response.body?.cancel().catch(() => {}); await access(signal, true); return request(relative, { method, body, signal, retry: false }); }
    if (response.status === 204) return {};
    const value = await auth.readJson(response, 4 * 1024 * 1024);
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'Google Photos authorization expired. Connect again.' : response.status === 403 ? 'Google Photos access was denied. Enable Google Photos Picker API in your Google project and allow selected-photo access.' : response.status === 404 || response.status === 410 ? 'This Google Photos selection expired. Choose photos again.' : response.status === 429 ? 'Google Photos is rate limiting this request. Wait a minute and retry.' : 'Google Photos could not complete this request. Retry the connection or selection.');
      error.status = response.status; if (response.status === 401) state.linked = false; throw error;
    }
    return value;
  }
  async function beginConnect() {
    if (state.busy || disconnecting) return { ok: false, error: 'Stop the current Google Photos operation before reconnecting.' };
    if (!readyVault()) return { ok: false, error: 'Connect Google Photos from the updated desktop app.' };
    const release = lock.acquire('picker-sign-in'); if (!release) return { ok: false, error: 'Another Google Photos operation is running.' };
    state.busy = true; state.status = 'connecting'; state.lastError = null;
    return tracked((async () => {
      try {
        const version = epoch;
        const created = await auth.startLoopback({ clientId: clientId(), clientSecret, fetchImpl, onTokens: async (fresh, signal) => { signal.throwIfAborted(); await persist({ ...fresh, scope: fresh.scope || auth.SCOPE }, version); return { linked: true }; } });
        if (version !== epoch || disconnecting) { created.cancel(); await created.result.catch(() => {}); throw new Error('Google Photos sign-in was stopped.'); }
        oauth = created;
        const current = oauth;
        tracked(current.result.then(() => { state.status = 'linked'; state.lastError = null; }, error => { state.lastError = error.message; state.status = state.linked ? 'linked' : 'unlinked'; }).finally(() => { if (oauth === current) oauth = null; state.busy = false; state.stopping = false; release(); }));
        return { ok: true, authUrl: current.authUrl, expiresAt: current.expiresAt };
      } catch (error) { state.busy = false; state.status = state.linked ? 'linked' : 'unlinked'; state.lastError = error.message; release(); return { ok: false, error: error.message }; }
    })());
  }
  function updateSession(value, prior = selection) {
    if (typeof value.id !== 'string' || !value.id || value.id.length > 2000) throw new Error('Google returned an invalid picking session.');
    const uri = validPickerUri(value.pickerUri || prior?.pickerUri); if (!uri) throw new Error('Google returned an unexpected selection address.');
    const expiresAt = Date.parse(value.expireTime) || prior?.expiresAt || Date.now() + 10 * 60000;
    const pollIntervalMs = Math.max(1000, Math.min(60000, duration(value.pollingConfig?.pollInterval, prior?.pollIntervalMs || 5000)));
    const timeout = duration(value.pollingConfig?.timeoutIn, expiresAt - Date.now());
    selection = { id: value.id, pickerUri: uri, ready: !!value.mediaItemsSet, expiresAt, pollIntervalMs, timeoutAt: Math.min(expiresAt, Date.now() + Math.max(0, timeout)), nextCheckAt: Date.now() + pollIntervalMs };
  }
  async function deleteSelection() {
    const old = selection; selection = null;
    if (old && tokens) { try { await request('/sessions/' + encodeURIComponent(old.id), { method: 'DELETE', signal: AbortSignal.timeout(5000) }); } catch (_) {} }
  }
  async function createSession() {
    if (state.busy || disconnecting) return { ok: false, error: 'Google Photos is already busy.' };
    const release = lock.acquire('picker-selection'); if (!release) return { ok: false, error: 'Another Google Photos operation is running.' };
    state.busy = true; state.lastError = null; controller = new AbortController(); const signal = controller.signal;
    return tracked((async () => {
      try { await deleteSelection(); const value = await request('/sessions', { method: 'POST', body: { pickingConfig: { maxItemCount: String(MAX_ITEMS) } }, signal }); updateSession(value, null); state.status = selection.ready ? 'ready' : 'choosing'; return { ok: true, pickerUri: selection.pickerUri }; }
      catch (error) { state.lastError = error.message; state.status = state.linked ? 'error' : 'unlinked'; return { ok: false, error: error.message }; }
      finally { state.busy = false; state.stopping = false; controller = null; release(); }
    })());
  }
  async function checkSession() {
    if (!selection) return { ok: false, error: 'Choose photos in Google Photos first.' };
    if (selection.ready || Date.now() < selection.nextCheckAt || state.busy) return { ok: true, ...status() };
    if (Date.now() >= Math.min(selection.expiresAt, selection.timeoutAt)) { state.lastError = 'This photo selection timed out. Choose photos again.'; state.status = 'error'; await deleteSelection(); return { ok: false, error: state.lastError }; }
    const release = lock.acquire('picker-check'); if (!release) return { ok: false, error: 'Another Google Photos operation is running.' };
    state.busy = true; controller = new AbortController(); const signal = controller.signal;
    return tracked((async () => {
      try { updateSession(await request('/sessions/' + encodeURIComponent(selection.id), { signal })); state.status = selection.ready ? 'ready' : 'choosing'; state.lastError = null; return { ok: true, ...status() }; }
      catch (error) { state.lastError = error.message; state.status = state.linked ? 'error' : 'unlinked'; return { ok: false, error: error.message }; }
      finally { state.busy = false; controller = null; release(); }
    })());
  }
  async function readAliases() { try { if ((await fs.stat(aliasesFile)).size > 20 * 1024 * 1024) return {}; const value = JSON.parse(await fs.readFile(aliasesFile, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch (_) { return {}; } }
  async function writeAliases(value) { await fs.mkdir(paths.DATA_DIR, { recursive: true }); await fs.writeFile(aliasesFile + '.tmp', JSON.stringify(value), { mode: 0o600 }); await fs.rename(aliasesFile + '.tmp', aliasesFile); }
  async function recordFile(record, signal) {
    if (!record || !/^[a-f0-9]{64}$/.test(record.hash || '')) return null;
    const dirs = record.kind === 'video' ? [cfg.LOCAL_VIDEO_DIR, cfg.VIDEO_DIR] : [cfg.IMAGES_DIR];
    for (const directory of dirs.filter(Boolean)) { const file = path.join(directory, record.filename); try { if (await hashFile(file, signal) === record.hash) return file; } catch (_) { signal?.throwIfAborted(); } }
    return null;
  }
  async function download(item, signal) {
    const type = item.type === 'PHOTO' ? 'image' : item.type === 'VIDEO' ? 'video' : null;
    if (!type || !item.mediaFile || typeof item.id !== 'string') throw new Error('Google returned an unsupported selected media item.');
    if (type === 'video' && item.mediaFile.mediaFileMetadata?.videoMetadata?.processingStatus !== 'READY') throw new Error('This video is still processing in Google Photos. Select it again when processing finishes.');
    const base = mediaUrl(item.mediaFile.baseUrl);
    if (base.search) throw new Error('Google returned an unexpected media URL format. Choose photos again.');
    let url = mediaUrl(base.href + (type === 'video' ? '=dv' : '=d')), response, refreshUsed = false;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(Math.max(10000, cfg.DOWNLOAD_TIMEOUT_MS || 90000))]);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const token = await access(timeout);
      response = await fetchImpl(url.href, { redirect: 'manual', headers: { Authorization: 'Bearer ' + token }, signal: timeout });
      if (response.status === 401 && !refreshUsed) { await response.body?.cancel().catch(() => {}); await access(timeout, true); refreshUsed = true; redirects--; continue; }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location'); await response.body?.cancel().catch(() => {});
        if (!next) throw new Error('Google returned a download redirect without a location.'); url = mediaUrl(new URL(next, url).href); continue;
      }
      break;
    }
    if (!response?.ok) { const error = new Error('Google could not download this selected file. Choose it again if the selection expired.'); error.status = response?.status; if (error.status === 401) state.linked = false; throw error; }
    const mime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const actualMime = MIME[mime] ? mime : !mime || mime === 'application/octet-stream' ? item.mediaFile.mimeType : '';
    const ext = MIME[actualMime]; if (!ext || !actualMime.startsWith(type + '/')) { await response.body?.cancel().catch(() => {}); throw new Error('Google returned a web page or unsupported file instead of the selected media.'); }
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw new Error('This file exceeds the 2 GB Picker download limit. Use Takeout for larger originals.'); }
    const directory = type === 'video' ? cfg.LOCAL_VIDEO_DIR : cfg.IMAGES_DIR; await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, '.picker-' + crypto.randomUUID() + '.part');
    let bytes = 0, head = Buffer.alloc(0); const hash = crypto.createHash('sha256');
    try {
      if (!response.body) throw new Error('Google returned an empty download.');
      const measure = new Transform({ transform(chunk, encoding, done) { bytes += chunk.length; if (bytes > MAX_BYTES) return done(new Error('This file exceeds the 2 GB Picker download limit. Use Takeout.')); hash.update(chunk); if (head.length < 256) head = Buffer.concat([head, chunk.subarray(0, 256 - head.length)]); done(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), measure, nativeFs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: timeout });
      if (!bytes || (declared > 0 && !response.headers.get('content-encoding') && declared !== bytes)) throw new Error('The selected file download was incomplete. Retry this selection.');
      if (/^\s*(?:<!doctype|<html|\{\s*"error")/i.test(head.toString()) || head.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new Error('Google returned an error page or archive instead of selected media.');
      return { temporary, directory, size: bytes, hash: hash.digest('hex'), kind: type, mime: actualMime, ext };
    } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
  async function importSelected() {
    if (state.busy || disconnecting) return { ok: false, error: 'Google Photos is already busy.' };
    if (!selection?.ready || Date.now() >= selection.expiresAt) return { ok: false, error: 'Choose photos in Google Photos and finish the selection first.' };
    const release = lock.acquire('picker-import'); if (!release) return { ok: false, error: 'Another Google Photos operation is running.' };
    state.busy = true; state.status = 'scanning'; state.lastError = null; controller = new AbortController(); const signal = controller.signal;
    const run = { method: 'picker', at: Date.now(), saved: 0, images: 0, videos: 0, skipped: 0, duplicates: 0, failed: 0, processed: 0, complete: false, cancelled: false, firstError: null, issues: [] };
    state.progress = { phase: 'selection', selected: 0, processed: 0, saved: 0, skipped: 0, duplicates: 0, failed: 0 };
    return tracked((async () => {
      try {
        const picked = [], pages = new Set(); let pageToken = '';
        do {
          signal.throwIfAborted();
          const query = new URLSearchParams({ sessionId: selection.id, pageSize: '100', ...(pageToken ? { pageToken } : {}) });
          const page = await request('/mediaItems?' + query, { signal });
          if (page.mediaItems && !Array.isArray(page.mediaItems)) throw new Error('Google returned an unreadable media selection.');
          picked.push(...(page.mediaItems || [])); if (picked.length > MAX_ITEMS) throw new Error('Google returned more than 2,000 selected items. Select fewer files.');
          pageToken = page.nextPageToken || ''; if (pageToken && (typeof pageToken !== 'string' || pages.has(pageToken))) throw new Error('Google repeated a selection page. Choose photos again.'); pages.add(pageToken);
        } while (pageToken);
        state.progress.selected = picked.length;
        const aliases = await readAliases(), records = store.listRecords({}).filter(rec => rec.source === 'googlephotos'), byId = new Map(records.map(rec => [rec.id, rec])), byHash = new Map(records.filter(rec => rec.hash).map(rec => [rec.hash, rec]));
        const hidden = store.hiddenIds?.() || new Set(); let failures = 0;
        for (const item of picked) {
          signal.throwIfAborted(); let prepared;
          try {
            if (typeof item?.id !== 'string' || !item.id || item.id.length > 2000) throw new Error('Google returned an invalid selected-file ID.');
            const id = recordId(item.id), prior = byId.get(aliases[id]?.recordId || id);
            state.progress.currentFile = safeName(item.mediaFile?.filename);
            if (hidden.has(id) || hidden.has(aliases[id]?.recordId) || (prior && hidden.has(prior.id))) { run.skipped++; continue; }
            if (prior && await recordFile(prior, signal)) { run.skipped++; failures = 0; continue; }
            prepared = await download(item, signal);
            const duplicate = byHash.get(prepared.hash);
            let record = duplicate && await recordFile(duplicate, signal) ? duplicate : null;
            if (record) { run.duplicates++; run.skipped++; }
            else {
              const parsed = Date.parse(item.createTime), ts = Number.isFinite(parsed) ? parsed : Date.now();
              const filename = new Date(ts).toISOString().slice(0, 19).replace(/[-:T]/g, '') + '__googlephotos_picker__' + id.slice(-32) + '.' + prepared.ext;
              const target = path.join(prepared.directory, filename);
              try { await fs.stat(target); if (await hashFile(target, signal) !== prepared.hash) throw new Error('A different archive file already uses this name. The existing file was kept.'); }
              catch (error) { if (error.code !== 'ENOENT') throw error; signal.throwIfAborted(); await fs.rename(prepared.temporary, target); }
              record = { id, ts, dateSource: Number.isFinite(parsed) ? 'googlephotos' : 'import', importedAt: Date.now(), source: 'googlephotos', dir: 'in', kind: prepared.kind, chat: 'Google Photos', number: '', filename, docName: safeName(item.mediaFile.filename), mimetype: prepared.mime, serve: '/media/' + (prepared.kind === 'video' ? 'videos/' : 'images/') + encodeURIComponent(filename), size: prepared.size, caption: '', hash: prepared.hash, cloud: false, generated: false, importMethod: 'picker', googlePhotosMediaId: item.id, googlePhotosDownload: prepared.kind === 'video' ? 'high-quality-transcoded-video' : 'photo-without-location-metadata' };
              if (store.addRecord(record)) { run.saved++; run[prepared.kind === 'video' ? 'videos' : 'images']++; try { noteNewMedia(record); } catch (_) {} }
              else run.skipped++;
              byId.set(id, record); byHash.set(prepared.hash, record);
            }
            aliases[id] = { recordId: record.id, hash: prepared.hash }; await writeAliases(aliases); failures = 0;
          } catch (error) {
            signal.throwIfAborted(); run.failed++; run.firstError ||= error.message;
            if (run.issues.length < 25) run.issues.push({ name: safeName(item?.mediaFile?.filename), error: error.message });
            if (++failures >= 3 || error.status === 401 || error.status === 403) throw error;
          } finally {
            if (prepared) await fs.unlink(prepared.temporary).catch(() => {});
            run.processed++; Object.assign(state.progress, { processed: run.processed, saved: run.saved, skipped: run.skipped, duplicates: run.duplicates, failed: run.failed });
          }
        }
        run.complete = !run.failed; if (run.complete) await deleteSelection();
        state.status = run.complete ? 'linked' : 'error'; state.lastError = run.firstError;
        return { ok: run.complete, ...run };
      } catch (error) { run.cancelled = signal.aborted; if (!run.cancelled) { run.failed = Math.max(1, run.failed); run.firstError ||= error.message; state.lastError = error.message; } state.status = state.linked ? run.cancelled ? 'linked' : 'error' : 'unlinked'; return { ok: run.cancelled, error: run.cancelled ? undefined : error.message, ...run }; }
      finally { run.finishedAt = Date.now(); state.lastRun = run; state.progress = null; state.busy = false; state.stopping = false; controller = null; release(); try { history.write('googlephotos-picker', run); } catch (_) {} if (run.saved) { try { nudgeBackup(); } catch (_) {} } }
    })());
  }
  async function cancel() { epoch++; state.stopping = true; oauth?.cancel(); controller?.abort(new Error('Google Photos import stopped. Completed files were kept.')); await Promise.allSettled([...work]); await Promise.allSettled([...saves]); await deleteSelection(); state.busy = false; state.stopping = false; state.status = state.linked ? 'linked' : 'unlinked'; return { ok: true }; }
  async function disconnect() {
    disconnecting = true; epoch++; oauth?.cancel(); controller?.abort(new Error('Google Photos disconnected.'));
    await Promise.allSettled([...work, loading, refreshing].filter(Boolean)); await Promise.allSettled([...saves]);
    const release = lock.acquire('picker-disconnect');
    try { if (!release) throw new Error('Another Google Photos operation is running. Stop it before disconnecting.'); await deleteSelection(); if (!readyVault()) throw new Error('Disconnect Google Photos from the updated desktop app.'); const result = await vault.clear(); if (result === false || result?.ok === false) throw new Error('Could not clear Google Photos authorization. Retry.'); tokens = null; loaded = true; state.linked = false; state.status = 'unlinked'; state.lastError = null; return { ok: true }; }
    catch (error) { state.lastError = error.message; return { ok: false, error: error.message }; }
    finally { release?.(); disconnecting = false; state.busy = false; state.stopping = false; }
  }
  async function init() { state.lastRun = history.read('googlephotos-picker'); try { await loadTokens(); state.status = state.linked ? 'linked' : 'unlinked'; } catch (error) { state.lastError = error.message; } }
  async function shutdown() { epoch++; oauth?.cancel(); controller?.abort(new Error('App closing. Completed Google Photos files were kept.')); await Promise.allSettled([...work, loading, refreshing].filter(Boolean)); await Promise.allSettled([...saves]); }
  return { setVault, setClientSecret, init, shutdown, getState: status, beginConnect, createSession, checkSession, importSelected, cancel, disconnect };
}
let instance;
const current = () => instance ||= createConnector({ settings: require('../settings'), cfg: require('../config'), paths: require('../paths'), store: require('../store'), history: require('../source-history'), noteNewMedia: record => require('../ai').noteNewMedia(record), nudgeBackup: () => require('../backup').nudge() });
module.exports = { createConnector, mediaUrl, validPickerUri, recordId };
for (const method of ['setVault', 'setClientSecret', 'init', 'shutdown', 'getState', 'beginConnect', 'createSession', 'checkSession', 'importSelected', 'cancel', 'disconnect']) module.exports[method] = (...args) => current()[method](...args);
