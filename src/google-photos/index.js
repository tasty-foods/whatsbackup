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
  const args = ['--disable-gpu', '--lang=en-US', ...profile.QUIET_ARGS, '--disable-blink-features=AutomationControlled'];
  if (process.env.WB_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  browser = await require('puppeteer').launch({
    headless: !headed, args, userDataDir: PROFILE_DIR, ignoreDefaultArgs: ['--enable-automation'],
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
  const ua = await b.userAgent();
  await page.setUserAgent(ua.replace('HeadlessChrome', 'Chrome'));
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

async function signedIn(page) {
  if (page.isClosed() || new URL(page.url()).origin !== ORIGIN) return false;
  try { return await page.evaluate(() => !!document.querySelector('a[aria-label^="Google Account"], button[aria-label^="Google Account"], a[href*="accounts.google.com/SignOutOptions"], a[href*="/photo/"]')); }
  catch (_) { return false; }
}

async function requireSignIn(page) {
  // A slow grid must not erase a valid session. Only an explicit login page
  // clears the marker; other loading failures remain retryable.
  for (let i = 0; i < 20; i++) {
    if (await signedIn(page)) { markLinked(true); return; }
    if (new URL(page.url()).hostname === 'accounts.google.com') {
      markLinked(false);
      throw new Error('Google Photos is signed out — connect again.');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Could not read the Google Photos account. Try signing in again.');
}

async function connect() {
  if (state.busy) return { ok: false, error: 'Google Photos is already busy' };
  state.busy = true; state.status = 'connecting'; state.lastError = null;
  clearTimeout(timer); state.nextScanAt = null;
  try {
    const b = await launch({ headed: true });
    const page = await openPage(b);
    const until = Date.now() + 10 * 60000;
    while (Date.now() < until && !page.isClosed()) {
      if (await signedIn(page)) {
        markLinked(true); state.status = 'linked';
        return { ok: true };
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error(page.isClosed() ? 'Sign-in window closed before Google Photos connected.' : 'No Google Photos sign-in within ten minutes.');
  } catch (error) {
    state.lastError = error.message; state.status = state.linked ? 'error' : 'unlinked';
    return { ok: false, error: error.message };
  } finally { await closeBrowser(); state.busy = false; schedule(); }
}

async function checkLink() {
  if (state.busy) return state.linked;
  if (!hasProfile()) { state.linked = false; state.status = 'unlinked'; return false; }
  state.busy = true;
  try {
    await requireSignIn(await openPage(await launch()));
    state.status = 'linked'; state.lastError = null;
    return true;
  } catch (error) { state.lastError = error.message; state.status = state.linked ? 'error' : 'unlinked'; return false; }
  finally { await closeBrowser(); state.busy = false; schedule(); }
}

async function disconnect() {
  if (state.busy) return { ok: false, error: 'Stop the Google Photos import before forgetting this account.' };
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
  finally { state.busy = false; schedule(); }
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

async function scan({ reason = 'manual' } = {}) {
  if (state.busy) return { ok: false, error: 'Google Photos is already busy' };
  if (!hasProfile()) { state.status = 'unlinked'; return { ok: false, error: 'Connect Google Photos first.' }; }
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
    history.write('googlephotos', run);
    state.busy = false; state.progress = null; state.stopping = false; controller = null;
    if (run.saved) { try { require('../backup').nudge(); } catch (_) {} }
    log(`${reason}: ${run.saved} saved, ${run.skipped} already saved, ${run.failed} failed${run.cancelled ? ', stopped' : ''}`);
    schedule();
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
  if (!s.googlePhotosEnabled || !hasProfile() || state.busy) return;
  const delay = Math.max(1, Math.min(168, parseInt(s.googlePhotosScanHours, 10) || 6)) * 3600000;
  state.nextScanAt = Date.now() + delay;
  timer = setTimeout(() => { timer = null; if (settings.read().googlePhotosEnabled) scan({ reason: 'scheduled' }); }, delay);
  timer.unref?.();
}

function init() {
  state.lastRun = history.read('googlephotos');
  state.lastScanAt = state.lastRun?.finishedAt || state.lastRun?.at || null;
  state.linked = hasProfile();
  state.status = state.linked ? 'linked' : settings.read().googlePhotosEnabled ? 'unlinked' : 'off';
  schedule();
  if (settings.read().googlePhotosEnabled && state.linked) {
    // Avoid launching alongside WhatsApp, ChatGPT, and Gemini on startup.
    startupTimer = setTimeout(() => { startupTimer = null; if (settings.read().googlePhotosEnabled) scan({ reason: 'startup' }); }, 180000);
    startupTimer.unref?.();
  }
}

function getState() {
  const s = settings.read();
  return { ...state, enabled: !!s.googlePhotosEnabled, scanHours: s.googlePhotosScanHours || 6 };
}

module.exports = { init, connect, disconnect, checkLink, scan, cancel, schedule, getState };
