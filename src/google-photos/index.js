'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');
const cfg = require('../config');
const settings = require('../settings');
const store = require('../store');
const history = require('../source-history');
const { ORIGIN, walkLibrary, photoTime } = require('./library');
const { createDownloader, hashFile } = require('./download');
const auth = require('./auth');
const takeout = require('./takeout');
const lock = require('./lock');

const PROFILE_DIR = paths.GOOGLE_PHOTOS_DIR;
const MARKER = path.join(PROFILE_DIR, 'linked.json');
const SEEN_FILE = path.join(paths.DATA_DIR, 'googlephotos-seen.json');
const state = { status: 'off', linked: false, busy: false, lastScanAt: null, lastError: null, lastRun: null, nextScanAt: null, progress: null, stopping: false };
let browser = null, closingBrowser = null, timer = null, startupTimer = null, controller = null;
const log = (...args) => console.log('[google-photos]', ...args);
const hasProfile = () => fs.existsSync(MARKER);
const recordId = mediaId => 'googlephotos_' + crypto.createHash('sha256').update(mediaId).digest('hex');

function markLinked(linked) {
  if (linked) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify({ at: Date.now() }));
  } else fs.rmSync(MARKER, { force: true });
  state.linked = linked;
}

async function launch({ headed = false } = {}) {
  const profile = require('../browser-profile');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  profile.forgetTabs(PROFILE_DIR);
  const args = ['--disable-gpu', '--lang=en-US', ...profile.QUIET_ARGS];
  if (process.env.WB_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  browser = await require('puppeteer').launch({
    headless: !headed, args, userDataDir: PROFILE_DIR,
    defaultViewport: headed ? null : { width: 1280, height: 900 }, protocolTimeout: 120000,
    ...(cfg.CHROME_PATH ? { executablePath: cfg.CHROME_PATH } : {}),
  });
  return browser;
}

async function closeBrowser() {
  if (closingBrowser) return closingBrowser;
  const current = browser; browser = null;
  if (current) {
    closingBrowser = current.close().catch(() => {});
    try { await closingBrowser; } finally { closingBrowser = null; }
  }
}

async function openPage(b, url = ORIGIN + '/?hl=en') {
  const page = await b.newPage();
  page.setDefaultTimeout(60000);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

async function requireSignIn(page) {
  // A slow grid must not erase a valid session. Only an explicit login page
  // clears the marker; other loading failures remain retryable.
  for (let i = 0; i < 20; i++) {
    const current = await auth.inspect(page);
    if (current.blocked) { markLinked(false); throw new Error(auth.blockedMessage()); }
    if (current.ready) { markLinked(true); return; }
    if (current.login) {
      markLinked(false);
      throw new Error('Google Photos is signed out. Browser sign-in may be blocked by Google. ' + auth.TAKEOUT_HELP);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Google Photos did not expose a readable signed-in library. ' + auth.TAKEOUT_HELP);
}

async function connect() {
  if (state.busy) return { ok: false, error: 'Google Photos is already busy' };
  const release = lock.acquire('browser-sign-in');
  if (!release) return { ok: false, busy: true, error: 'Another Google Photos operation is running.' };
  state.busy = true; state.status = 'connecting'; state.lastError = null;
  controller = new AbortController();
  const signal = controller.signal;
  clearTimeout(timer); state.nextScanAt = null;
  try {
    const b = await launch({ headed: true });
    const page = await openPage(b);
    const until = Date.now() + 10 * 60000;
    while (Date.now() < until && !page.isClosed()) {
      signal.throwIfAborted();
      const current = await auth.inspect(page);
      if (current.blocked) { markLinked(false); throw new Error(auth.blockedMessage()); }
      if (current.ready) {
        markLinked(true); state.status = 'linked';
        return { ok: true };
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error(page.isClosed() ? 'Sign-in window closed before Google Photos connected. ' + auth.TAKEOUT_HELP : 'No Google Photos sign-in within ten minutes. ' + auth.TAKEOUT_HELP);
  } catch (error) {
    state.lastError = error.message; state.status = state.linked ? 'error' : 'unlinked';
    return { ok: false, error: error.message };
  } finally { await closeBrowser(); state.busy = false; state.stopping = false; controller = null; release(); schedule(); }
}

async function checkLink() {
  if (state.busy) return state.linked;
  if (!hasProfile()) { state.linked = false; state.status = 'unlinked'; return false; }
  const release = lock.acquire('browser-check'); if (!release) return false;
  state.busy = true;
  try {
    await requireSignIn(await openPage(await launch()));
    state.status = 'linked'; state.lastError = null;
    return true;
  } catch (error) { state.lastError = error.message; state.status = state.linked ? 'error' : 'unlinked'; return false; }
  finally { await closeBrowser(); state.busy = false; release(); schedule(); }
}

async function disconnect() {
  if (state.busy) return { ok: false, error: 'Stop the Google Photos import before forgetting this account.' };
  const release = lock.acquire('browser-forget'); if (!release) return { ok: false, busy: true, error: 'Another Google Photos operation is running.' };
  state.busy = true;
  clearTimeout(timer); clearTimeout(startupTimer); timer = startupTimer = null;
  try {
    await closeBrowser();
    // This path is fixed by paths.js and always names this connector's profile.
    if (path.resolve(PROFILE_DIR) !== path.resolve(paths.APP_HOME, 'google-photos-session')) throw new Error('Unexpected Google Photos profile path');
    await fs.promises.rm(PROFILE_DIR, { recursive: true, force: true });
    state.linked = false; state.status = 'unlinked'; state.lastError = null; state.nextScanAt = null;
    return { ok: true };
  } catch (error) { state.lastError = error.message; return { ok: false, error: 'Could not forget Google Photos: ' + error.message }; }
  finally { state.busy = false; release(); schedule(); }
}

function readSeen() {
  try {
    const value = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}
function writeSeen(seen) {
  fs.mkdirSync(paths.DATA_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE + '.tmp', JSON.stringify(seen));
  fs.renameSync(SEEN_FILE + '.tmp', SEEN_FILE);
}

// Google Takeout is the supported full-library path. Read only the selected,
// extracted directory; leave the export untouched and keep a separate original.
async function importFolder({ folder, reason = 'takeout' } = {}) {
  if (state.busy) return { ok: false, error: 'Google Photos is already busy' };
  const release = lock.acquire('takeout'); if (!release) return { ok: false, busy: true, error: 'Another Google Photos operation is running.' };
  state.busy = true; state.status = 'scanning'; state.lastError = null; state.stopping = false;
  state.nextScanAt = null; clearTimeout(timer); clearTimeout(startupTimer);
  controller = new AbortController();
  const signal = controller.signal;
  const run = { method: 'takeout', images: 0, videos: 0, saved: 0, skipped: 0, ignored: 0, failed: 0, complete: false, cancelled: false, firstError: null, at: Date.now(), reason };
  state.progress = { phase: 'takeout', found: 0, images: 0, videos: 0, saved: 0, skipped: 0, ignored: 0, failed: 0 };
  try {
    const root = await takeout.validateFolder(folder, [cfg.IMAGES_DIR, cfg.LOCAL_VIDEO_DIR, cfg.FILES_DIR, paths.DATA_DIR, PROFILE_DIR]);
    const metadataFor = takeout.metadataReader();
    const held = new Map(store.listRecords({}).filter(rec => rec.source === 'googlephotos' && rec.hash).map(rec => [rec.hash, rec.id]));
    let consecutiveFailures = 0;
    for await (const item of takeout.walkMedia(root, { signal, onProgress: progress => { Object.assign(state.progress, progress); run.ignored = progress.ignored; } })) {
      signal.throwIfAborted();
      if (item.kind === 'video') run.videos++; else run.images++;
      try {
        const original = await takeout.inspectFile(item, root, signal);
        const id = recordId('takeout:' + original.hash);
        if (held.has(original.hash) || store.has(id)) { run.skipped++; consecutiveFailures = 0; continue; }
        const metadata = await metadataFor(item);
        signal.throwIfAborted();
        const dated = takeout.takenTime(metadata, original.mtimeMs);
        const filename = `${new Date(dated.ts).toISOString().slice(0, 19).replace(/[-:T]/g, '')}__googlephotos__${id.slice(-24)}.${item.ext}`;
        const directory = item.kind === 'video' ? cfg.LOCAL_VIDEO_DIR : cfg.IMAGES_DIR;
        await fs.promises.mkdir(directory, { recursive: true });
        const target = path.join(directory, filename);
        await takeout.copyOriginal(original, target, signal);
        // Copy completion and byte count are checked before the archive index is
        // changed. On an index failure, the unchanged export can safely retry.
        const size = (await fs.promises.stat(target)).size;
        const rec = {
          id, ...dated, importedAt: Date.now(), dir: 'in', kind: item.kind, source: 'googlephotos', chat: 'Google Photos', number: '',
          mimetype: item.mime, filename, docName: item.name,
          serve: '/media/' + (item.kind === 'video' ? 'videos/' : 'images/') + encodeURIComponent(filename),
          size, caption: typeof metadata?.description === 'string' ? metadata.description.slice(0, 3000) : '',
          generated: false, cloud: false, hash: original.hash, importMethod: 'takeout',
        };
        if (store.addRecord(rec)) {
          held.set(original.hash, id); run.saved++;
          try { require('../ai').noteNewMedia(rec); } catch (_) {}
          if (run.saved === 1 || run.saved % 25 === 0) { try { require('../backup').nudge(); } catch (_) {} }
        } else run.skipped++;
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) throw error;
        run.failed++; run.firstError ||= error.message;
        if (++consecutiveFailures >= 3) throw new Error('Three exported files failed in a row. Import stopped; fix the storage problem and retry. ' + run.firstError);
      } finally {
        Object.assign(state.progress, { images: run.images, videos: run.videos, saved: run.saved, skipped: run.skipped, failed: run.failed });
      }
    }
    if (!run.images && !run.videos) throw new Error('No supported photos or videos were found. Extract every Google Photos Takeout ZIP, then choose its extracted Google Photos folder.');
    run.complete = !run.failed;
    state.status = run.complete ? state.linked ? 'linked' : hasProfile() ? 'unverified' : 'unlinked' : 'error';
    state.lastError = run.firstError;
    return { ok: run.complete, ...run };
  } catch (error) {
    run.cancelled = signal.aborted;
    if (!run.cancelled) { run.failed = Math.max(1, run.failed); run.firstError ||= error.message; state.lastError = error.message; }
    state.status = run.cancelled ? state.linked ? 'linked' : 'unlinked' : 'error';
    return { ok: run.cancelled, error: run.cancelled ? undefined : error.message, ...run };
  } finally {
    run.finishedAt = Date.now(); state.lastRun = run; state.lastScanAt = run.finishedAt;
    try { history.write('googlephotos', run); } catch (_) {}
    state.busy = false; state.progress = null; state.stopping = false; controller = null;
    if (run.saved) { try { require('../backup').nudge(); } catch (_) {} }
    log(`${reason}: ${run.saved} saved, ${run.skipped} already saved, ${run.failed} failed${run.cancelled ? ', stopped' : ''}`);
    release(); schedule();
  }
}

async function scan({ reason = 'manual' } = {}) {
  if (state.busy) return { ok: false, error: 'Google Photos is already busy' };
  if (!hasProfile()) { state.status = 'unlinked'; return { ok: false, error: 'Connect Google Photos first.' }; }
  const release = lock.acquire('browser-import'); if (!release) return { ok: false, busy: true, error: 'Another Google Photos operation is running.' };
  state.busy = true; state.status = 'scanning'; state.lastError = null; state.stopping = false;
  state.nextScanAt = null; clearTimeout(timer); clearTimeout(startupTimer);
  controller = new AbortController();
  const signal = controller.signal;
  const run = { images: 0, videos: 0, saved: 0, skipped: 0, failed: 0, complete: false, cancelled: false, firstError: null, at: Date.now(), reason };
  state.progress = { phase: 'photos', images: 0, saved: 0, skipped: 0, failed: 0 };
  let staging = null, downloader = null;
  try {
    const aliases = readSeen();
    const held = new Map(store.listRecords({}).filter(rec => rec.source === 'googlephotos' && rec.hash).map(rec => [rec.hash, rec.id]));
    let consecutiveFailures = 0;
    const b = await launch();
    signal.throwIfAborted();
    const grid = await openPage(b);
    signal.throwIfAborted();
    await requireSignIn(grid);
    staging = await fs.promises.mkdtemp(path.join(paths.DATA_DIR, 'googlephotos-download-'));
    downloader = await createDownloader(b, staging, cfg.DOWNLOAD_TIMEOUT_MS || 90000);
    const detail = await b.newPage();
    detail.setDefaultTimeout(60000);
    await detail.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    const walked = await walkLibrary(grid, async item => {
      run.images++; state.progress.images = run.images;
      const id = recordId(item.mediaId);
      if (store.has(id) || (aliases[id] && store.has(aliases[id]))) { run.skipped++; state.progress.skipped = run.skipped; return; }
      let download = null;
      try {
        await detail.goto(item.url + '?hl=en', { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (new URL(detail.url()).hostname === 'accounts.google.com') { markLinked(false); throw new Error('Google Photos is signed out — connect again.'); }
        download = await downloader.download(detail, signal);
        const hash = await hashFile(download.file);
        if (held.has(hash)) {
          aliases[id] = held.get(hash); writeSeen(aliases);
          consecutiveFailures = 0;
          run.skipped++;
          return;
        }
        signal.throwIfAborted();
        const importedAt = Date.now();
        const dated = photoTime(item, importedAt);
        const filename = `${new Date(dated.ts).toISOString().slice(0, 19).replace(/[-:T]/g, '')}__googlephotos__${id.slice(-24)}.${download.ext}`;
        // Video serving and the backup sweep already search this local fallback.
        const directory = download.kind === 'video' ? cfg.LOCAL_VIDEO_DIR : cfg.IMAGES_DIR;
        await fs.promises.mkdir(directory, { recursive: true });
        const target = path.join(directory, filename);
        // Staging and the chosen media folder can be on different drives.
        try { await fs.promises.copyFile(download.file, target, fs.constants.COPYFILE_EXCL); }
        catch (error) {
          // Recover a completed copy left by a crash before the index append.
          if (error.code !== 'EEXIST' || await hashFile(target) !== hash) throw error;
        }
        const size = (await fs.promises.stat(target)).size;
        const rec = {
          id, ...dated, importedAt, dir: 'in', kind: download.kind, source: 'googlephotos', chat: 'Google Photos', number: '',
          mimetype: download.mime, filename, docName: path.win32.basename(download.filename),
          serve: '/media/' + (download.kind === 'video' ? 'videos/' : 'images/') + encodeURIComponent(filename),
          size, caption: '', generated: false, cloud: false, hash,
        };
        if (store.addRecord(rec)) {
          consecutiveFailures = 0;
          held.set(hash, id); run.saved++;
          if (download.kind === 'video') run.videos++;
          try { require('../ai').noteNewMedia(rec); } catch (_) {}
          if (run.saved === 1 || run.saved % 25 === 0) { try { require('../backup').nudge(); } catch (_) {} }
        }
      } catch (error) {
        if (signal.aborted || !state.linked) throw error;
        run.failed++; run.firstError ||= error.message;
        if (++consecutiveFailures >= 3) throw new Error('Three Google Photos files failed in a row. Import stopped; check this error and retry. ' + run.firstError);
      } finally {
        if (download) { try { await fs.promises.unlink(download.file); } catch (_) {} }
        Object.assign(state.progress, { saved: run.saved, skipped: run.skipped, failed: run.failed });
      }
    }, { signal });
    run.complete = walked.complete && !run.failed;
    if (!walked.complete) run.firstError ||= 'The scan reached its scroll limit. Your saved files are safe; this library needs a larger scan limit.';
    state.status = run.complete ? 'linked' : 'error';
    state.lastError = run.complete ? null : run.firstError;
    return { ok: true, ...run };
  } catch (error) {
    run.cancelled = signal.aborted;
    if (!run.cancelled) { run.failed = Math.max(1, run.failed); run.firstError ||= error.message; state.lastError = error.message; }
    state.status = run.cancelled ? 'linked' : state.linked ? 'error' : 'unlinked';
    return { ok: run.cancelled, error: run.cancelled ? undefined : error.message, ...run };
  } finally {
    if (downloader) await downloader.close();
    await closeBrowser();
    if (staging && path.dirname(staging) === path.resolve(paths.DATA_DIR) && path.basename(staging).startsWith('googlephotos-download-')) {
      try { await fs.promises.rm(staging, { recursive: true, force: true }); } catch (_) {}
    }
    run.finishedAt = Date.now(); state.lastRun = run; state.lastScanAt = run.finishedAt;
    try { history.write('googlephotos', run); } catch (_) {}
    state.busy = false; state.progress = null; state.stopping = false; controller = null;
    if (run.saved) { try { require('../backup').nudge(); } catch (_) {} }
    log(`${reason}: ${run.saved} saved, ${run.skipped} already saved, ${run.failed} failed${run.cancelled ? ', stopped' : ''}`);
    release(); schedule();
  }
}

function cancel() {
  if (!controller) return { ok: false, error: 'No Google Photos import is running.' };
  state.stopping = true;
  controller.abort(new Error('Import stopped'));
  // Closing the browser releases a pending navigation or menu wait promptly.
  closeBrowser();
  return { ok: true };
}

function schedule() {
  clearTimeout(timer); clearTimeout(startupTimer); timer = startupTimer = null;
  const s = settings.read();
  state.nextScanAt = null;
  // Do not repeatedly launch a browser after a known failed connection. The
  // user can retry the experimental connector, or use the supported export.
  if (!s.googlePhotosEnabled || !hasProfile() || state.busy || state.status === 'error') return;
  const delay = Math.max(1, Math.min(168, parseInt(s.googlePhotosScanHours, 10) || 6)) * 3600000;
  state.nextScanAt = Date.now() + delay;
  timer = setTimeout(async () => { timer = null; if (settings.read().googlePhotosEnabled) { const result = await scan({ reason: 'scheduled' }); if (result.busy) schedule(); } }, delay);
  timer.unref?.();
}

function init() {
  state.lastRun = history.read('googlephotos');
  state.lastScanAt = state.lastRun?.finishedAt || state.lastRun?.at || null;
  state.linked = false; // A saved marker is not proof that sign-in still works.
  state.lastError = state.lastRun?.failed ? state.lastRun.firstError || 'The previous Google Photos import failed. ' + auth.TAKEOUT_HELP : null;
  state.status = state.lastError ? 'error' : hasProfile() ? 'unverified' : settings.read().googlePhotosEnabled ? 'unlinked' : 'off';
  schedule();
  if (settings.read().googlePhotosEnabled && hasProfile() && !state.lastError) {
    // Avoid launching alongside WhatsApp, ChatGPT, and Gemini on startup.
    startupTimer = setTimeout(() => { startupTimer = null; if (settings.read().googlePhotosEnabled) scan({ reason: 'startup' }); }, 180000);
    startupTimer.unref?.();
  }
}

function getState() {
  const s = settings.read();
  return { ...state, enabled: !!s.googlePhotosEnabled, scanHours: s.googlePhotosScanHours || 6, hasSavedSession: hasProfile(), connectionVerified: state.linked,
    takeoutSupported: true, recommendedImport: 'takeout', browserImportExperimental: true,
    takeoutUrl: 'https://takeout.google.com/', takeoutGuideUrl: 'https://support.google.com/accounts/answer/3024190' };
}

module.exports = { init, connect, disconnect, checkLink, scan, importFolder, cancel, schedule, getState };
