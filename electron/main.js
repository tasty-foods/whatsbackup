'use strict';
// WhatsBackUp — desktop shell.
//
// The capture engine (Express + whatsapp-web.js + its own Chrome) runs in a
// utilityProcess so a crash there can't take the window with it; this process
// owns the window, the tray, startup registration, updates, and supervision.
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, Notification, nativeImage, safeStorage, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP_NAME = 'WhatsBackUp';
const HOME = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), APP_NAME);
fs.mkdirSync(HOME, { recursive: true });
// Set before anything requires src/paths.js: both this process and the engine
// must agree on where settings and data live.
process.env.WB_HOME = HOME;
app.setPath('userData', path.join(HOME, 'shell'));   // Electron's own cache, kept apart from user data
app.setAppUserModelId('be.tastyfoods.whatsbackup');  // Windows needs this for notifications + taskbar identity
// Take the lock before loading the engine, updater or native image dependencies.
// Double-clicks during an update must not create several half-started shells.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.exit(0);

const ROOT = path.join(__dirname, '..');
const RESOURCES = process.resourcesPath || ROOT;
const isPackaged = app.isPackaged;

const settings = require(path.join(ROOT, 'src', 'settings.js'));
const migrate = require('./migrate');

let win = null;
let tray = null;
let child = null;
let childRestarts = 0;
let quitting = false;
let suspended = false;      // engine deliberately stopped (migration) — don't auto-restart
let serverPort = null;
let lastHealthy = true;
let restartTimer = null;    // pending crash-restart backoff timer, so it can be cancelled
let portConflict = false;   // engine can't bind the port — surface the dialog only once

// ---------- the Chrome we ship ----------
// Packaged builds carry their own Chrome so the target machine needs nothing
// installed; from source, puppeteer uses whatever it downloaded.
function bundledChrome() {
  if (!isPackaged) return null;
  const base = path.join(RESOURCES, 'chromium');
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === 'chrome.exe') return p;
    }
  }
  return null;
}

// ---------- icons ----------
function icon(name) {
  for (const dir of [path.join(RESOURCES, 'icons'), path.join(ROOT, 'build', 'icons')]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  return nativeImage.createEmpty();
}

// ---------- trusting the network's own certificate authority ----------
// Plenty of machines sit behind software that inspects HTTPS — a school or
// company filter, some antivirus. It re-signs every certificate with a root of
// its own, which Windows is told to trust. Electron carries its own certificate
// store and never asks Windows, so to the engine every request to an AI
// provider looks like a forgery and dies as UNABLE_TO_GET_ISSUER_CERT_LOCALLY —
// which reads, wrongly, like the provider being broken.
//
// So: export what Windows trusts to a PEM once, and point the engine's Node at
// it. Cached for a week, because it changes about never, and failure here is
// non-fatal — a machine with no interception works either way.
const CA_BUNDLE = path.join(HOME, 'system-roots.pem');
const CA_MAX_AGE = 7 * 24 * 3600 * 1000;

function refreshCaBundle() {
  try {
    fs.mkdirSync(path.dirname(CA_BUNDLE), { recursive: true });
    const st = fs.existsSync(CA_BUNDLE) ? fs.statSync(CA_BUNDLE) : null;
    if (st && st.size > 1000 && Date.now() - st.mtimeMs < CA_MAX_AGE) return CA_BUNDLE;
    const ps = '$out = @(); Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root '
      + '-ErrorAction SilentlyContinue | Sort-Object Thumbprint -Unique | ForEach-Object { '
      + "$out += '-----BEGIN CERTIFICATE-----'; "
      + "$out += [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'); "
      + "$out += '-----END CERTIFICATE-----' }; "
      // Single-quoted on the PowerShell side: it takes backslashes literally, so
      // a Windows path needs no escaping — and doubling them would break it.
      + "Set-Content -LiteralPath '" + CA_BUNDLE + "' -Value $out -Encoding ascii";
    require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 30000, windowsHide: true });
    const after = fs.statSync(CA_BUNDLE);
    console.log('[ca] exported the system certificate roots (' + Math.round(after.size / 1024) + ' KB)');
    return CA_BUNDLE;
  } catch (e) {
    console.error('[ca] could not export system roots:', e.message);
    return fs.existsSync(CA_BUNDLE) ? CA_BUNDLE : null;
  }
}

// ---------- capture engine ----------
function startEngine() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) return;   // never run two engines at once — they'd fight over the port and the session folder
  const chrome = bundledChrome();
  const env = {
    ...process.env,
    WB_HOME: HOME,
    WB_VERSION: app.getVersion(),
  };
  // Node reads this at startup, so it has to be in place before the fork.
  const caBundle = refreshCaBundle();
  if (caBundle) env.NODE_EXTRA_CA_CERTS = caBundle;
  if (chrome) env.WB_CHROME = chrome;

  child = utilityProcess.fork(path.join(ROOT, 'src', 'index.js'), [], {
    env,
    stdio: 'pipe',
    // Trust the Windows certificate store as well as Node's bundled roots, so
    // an AI provider stays reachable on a network that inspects HTTPS.
    execArgv: ['--use-system-ca'],
  });

  // The engine logs to its own rotating file; mirror to stdout for `npm run dev`.
  if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
  if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'listening') {
      serverPort = msg.port;
      childRestarts = 0;
      portConflict = false;
      sendAiKey();
      // First start opens and shows the window; an engine restart keeps the
      // existing one as the user left it (no surprise show / focus steal).
      if (!win || win.isDestroyed()) openWindow();
    }
    // The engine has no image decoder of its own: a utilityProcess gets only
    // { net, systemPreferences } out of require('electron'). Chromium's is here,
    // so shrinking a photo before it is sent to a vision model happens here and
    // the result goes straight back. A failure answers ok:false rather than
    // going quiet, so the engine falls back to the original bytes instead of
    // waiting out its timeout.
    if (msg.type === 'shrink') {
      let reply = { type: 'shrunk', id: msg.id, ok: false };
      try {
        const img = nativeImage.createFromBuffer(Buffer.from(msg.data));
        const size = img.getSize();
        const max = Math.max(64, Math.min(4096, msg.max || 1024));
        const longest = Math.max(size.width, size.height);
        if (!img.isEmpty() && longest > max) {
          const scaled = size.width >= size.height
            ? img.resize({ width: max, quality: 'good' })
            : img.resize({ height: max, quality: 'good' });
          const jpeg = scaled.toJPEG(82);
          if (jpeg && jpeg.length) reply = { type: 'shrunk', id: msg.id, ok: true, data: new Uint8Array(jpeg) };
        }
      } catch (_) {}
      try { child.postMessage(reply); } catch (_) {}
    }
    // A perceptual fingerprint of a picture (difference hash over a 9x8
    // grey version), so the engine can tell "the same design, edited" from
    // "a different picture" without sending anything anywhere.
    if (msg.type === 'fingerprint') {
      let reply = { type: 'fingerprint-done', id: msg.id, ok: false };
      try {
        const img = nativeImage.createFromBuffer(Buffer.from(msg.data));
        const size = img.getSize();
        if (!img.isEmpty()) {
          const small = img.resize({ width: 9, height: 8, quality: 'good' });
          const bmp = small.toBitmap();                       // BGRA, 9x8
          const gray = new Uint8Array(72);
          for (let i = 0; i < 72; i++) gray[i] = Math.round(0.114 * bmp[i * 4] + 0.587 * bmp[i * 4 + 1] + 0.299 * bmp[i * 4 + 2]);
          let bits = '';
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? '1' : '0';
          let hex = '';
          for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
          reply = { type: 'fingerprint-done', id: msg.id, ok: true, hash: hex, width: size.width, height: size.height };
        }
      } catch (_) {}
      try { child.postMessage(reply); } catch (_) {}
    }
    // Frames out of a video, drawn by a hidden window — the fallback for a
    // clip the engine's own ffmpeg could not read. One at a time, with a deadline.
    if (msg.type === 'frames') {
      extractFrames(msg.file, msg.count || 3, msg.max || 768)
        .then((frames) => { try { child.postMessage({ type: 'frames-done', id: msg.id, ok: !!(frames && frames.length), frames: frames || [] }); } catch (_) {} })
        .catch(() => { try { child.postMessage({ type: 'frames-done', id: msg.id, ok: false }); } catch (_) {} });
    }
    if (msg.type === 'restart-requested') restartEngine();
    if (msg.type === 'port-in-use') {
      if (!portConflict) {
        portConflict = true;
        dialog.showErrorBox(APP_NAME,
          `Port ${msg.port} is already in use, so the dashboard can't start.\n\nChange the port in Settings, or close whatever is using it.`);
      }
    }
  });

  child.on('exit', (code) => {
    child = null;
    if (quitting || suspended) return;
    // Back off so a permanently broken engine doesn't spin the CPU.
    const delay = Math.min(60000, 2000 * Math.pow(2, childRestarts));
    childRestarts++;
    console.error(`[shell] capture engine exited (code ${code}) — restarting in ${Math.round(delay / 1000)}s`);
    updateTray();
    if (restartTimer) clearTimeout(restartTimer);
    // Re-check state when the timer fires, not just when it's set: a migration
    // may have suspended the engine during the backoff window, and launching it
    // then would run Chrome onto the session folder mid-copy.
    restartTimer = setTimeout(() => { restartTimer = null; if (!quitting && !suspended) startEngine(); }, delay);
  });
}

function restartEngine() {
  if (child) { try { child.kill(); } catch (_) {} child = null; }
  else startEngine();     // the exit handler restarts it when we killed one
}

// Stop the engine and wait for it to actually be gone. Chrome takes a moment to
// release the session folder, hence the grace period after exit.
function stopEngine() {
  return new Promise((resolve) => {
    // Set suspended (and cancel any pending crash-restart) up front, even if the
    // engine already died — otherwise a restart timer armed before this call
    // could relaunch it while a migration copies over the session folder.
    suspended = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (!child) return resolve();
    const c = child;
    const done = () => setTimeout(resolve, 1500);
    c.once('exit', done);
    try { c.kill(); } catch (_) { done(); }
    setTimeout(() => resolve(), 15000);     // never hang the UI on a stuck child
  });
}

// ---------- video frames for the engine ----------
// A hidden window that loads nothing remote: it is handed a local file path,
// seeks a <video> to a few moments and hands back JPEG frames. Kept open once
// made (creating a window costs more than the frames do) and serialised, so
// a burst of requests decodes one video at a time.
let framesWin = null;
let framesQueue = Promise.resolve();
const FRAMES_TIMEOUT_MS = 40000;

function framesWindow() {
  if (framesWin && !framesWin.isDestroyed()) return framesWin;
  framesWin = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: {
      offscreen: true, backgroundThrottling: false,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // The page is our own data: URL and the only thing it loads is the
      // local file it is asked for; file:// from a data: page needs this.
      webSecurity: false,
    },
  });
  framesWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  framesWin.webContents.setFrameRate(5);
  framesWin.loadURL('data:text/html,<!doctype html><title>frames</title>');
  return framesWin;
}

function extractFrames(file, count, max) {
  const run = async () => {
    if (!file || !fs.existsSync(file)) return null;
    const w = framesWindow();
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', r));
    const url = 'file:///' + file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    const script = `(async () => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.src = ${JSON.stringify(url)};
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('cannot decode')); setTimeout(() => rej(new Error('metadata timeout')), 15000); });
      let d = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      // A clip recorded without a length header reports Infinity until it is
      // seeked past its end; then it knows.
      if (!d) { v.currentTime = 1e9; await new Promise((r) => { v.onseeked = r; setTimeout(r, 3000); }); d = isFinite(v.duration) ? v.duration : 0; }
      const want = ${Math.max(1, Math.min(6, count))};
      let times = d <= 1.5 ? [Math.min(0.3, d / 2)] : want === 1 ? [Math.min(1.0, d * 0.1)] : Array.from({ length: want }, (_, i) => Math.min(d - 0.2, 0.6 + (d - 1.2) * i / (want - 1)));
      const scale = Math.min(1, ${max} / Math.max(v.videoWidth || 1, v.videoHeight || 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((v.videoWidth || 320) * scale)); c.height = Math.max(1, Math.round((v.videoHeight || 240) * scale));
      const ctx = c.getContext('2d');
      const out = [];
      for (const t of times) {
        await new Promise((res, rej) => { v.onseeked = res; v.onerror = () => rej(new Error('seek failed')); v.currentTime = t; setTimeout(res, 6000); });
        ctx.drawImage(v, 0, 0, c.width, c.height);
        out.push(c.toDataURL('image/jpeg', 0.8).split(',')[1]);
      }
      v.removeAttribute('src'); v.load();
      return out;
    })()`;
    const result = await Promise.race([
      w.webContents.executeJavaScript(script, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('frames timeout')), FRAMES_TIMEOUT_MS)),
    ]);
    return (result || []).map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
  };
  const job = framesQueue.then(run, run);
  framesQueue = job.catch(() => {});
  return job;
}

// ---------- window ----------
function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  if (!serverPort) return;   // engine isn't listening yet — don't build a window pointed at http://127.0.0.1:null/
  const startHidden = settings.read().startMinimized && process.argv.includes('--hidden');

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    show: false,
    backgroundColor: '#f7f8f5',
    title: APP_NAME,
    icon: icon('app.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Links to anywhere else open in the real browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  win.on('close', (e) => {
    if (quitting || !settings.read().closeToTray) return;
    e.preventDefault();
    win.hide();
    notifyOnce('closeToTray', APP_NAME, 'Still running in the background — find it in the system tray.');
  });
}

// ---------- tray ----------
function updateTray() {
  if (!tray) return;
  const engineUp = !!child;
  const label = !engineUp ? 'Starting…' : lastHealthy ? 'Capturing' : 'Capture may be broken';
  tray.setToolTip(`${APP_NAME} — ${label}`);
  tray.setImage(icon(!engineUp ? 'tray-off.ico' : lastHealthy ? 'tray-ok.ico' : 'tray-warn.ico'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${APP_NAME} — ${label}`, enabled: false },
    { type: 'separator' },
    { label: 'Open dashboard', click: () => openWindow() },
    { label: 'Import history now', click: () => { post('/api/backfill'); openWindow(); } },
    { label: 'Reconnect', click: () => post('/api/reconnect') },
    { type: 'separator' },
    { label: 'Open media folder', click: () => shell.openPath(currentPaths().images) },
    { label: 'Check for updates', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// Windows matches login items by the exact command line, so the same path and
// args have to go into the read as went into the write — otherwise it reports
// "off" for an entry it just wrote, and the settings toggle flips itself back.
const LOGIN_ITEM = { path: process.execPath, args: ['--hidden'] };
const startupEnabled = () => {
  try { return app.getLoginItemSettings(LOGIN_ITEM).openAtLogin; } catch (_) { return false; }
};
const setStartup = (enabled) => {
  app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: !!enabled });
  return startupEnabled();
};

function currentPaths() {
  const s = settings.read();
  const mediaRoot = (s.mediaRoot && s.mediaRoot.trim()) || path.join(HOME, 'media');
  return { home: HOME, mediaRoot, images: path.join(mediaRoot, 'images'), logs: path.join(HOME, 'logs') };
}

// ---------- the AI key ----------
// Stored only as DPAPI ciphertext, and handed to the engine in memory. The
// plaintext never reaches settings.json, the log, or the diagnostic report.
// A chain needs a key per provider, not one key. Each is encrypted separately
// and stored under its provider's name; the old single-key field is still read
// so an existing install keeps working without being asked to paste anything
// again — it belongs to whichever provider was configured when it was saved.
function saveAiKey(plain, provider) {
  const who = (provider || settings.read().aiProvider || '').trim();
  if (!who) return { ok: false, message: 'Choose a provider before saving its key.' };
  const keys = { ...(settings.read().aiKeysEnc || {}) };
  if (!plain) {
    delete keys[who];
    const patch = { aiKeysEnc: keys };
    if (who === settings.read().aiProvider) patch.aiKeyEnc = '';   // clear the legacy slot too
    settings.write(patch);
    sendAiKey();
    return { ok: true, cleared: true };
  }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'Windows could not provide secure storage for the key.' };
  keys[who] = safeStorage.encryptString(plain).toString('base64');
  settings.write({ aiKeysEnc: keys });
  sendAiKey();
  return { ok: true };
}

const decrypt = (enc) => {
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }
  catch (_) { return ''; }   // a different machine or Windows profile can't decrypt it
};

// provider -> plaintext key, decrypted only here and only into memory.
function readAiKeys() {
  const s = settings.read();
  const out = {};
  for (const [who, enc] of Object.entries(s.aiKeysEnc || {})) {
    const k = decrypt(enc);
    if (k) out[who] = k;
  }
  // The pre-chain single key, attributed to the provider it was saved under.
  if (s.aiKeyEnc && s.aiProvider && !out[s.aiProvider]) {
    const k = decrypt(s.aiKeyEnc);
    if (k) out[s.aiProvider] = k;
  }
  return out;
}

const readAiKey = () => readAiKeys()[settings.read().aiProvider] || '';

function sendAiKey() {
  if (!child) return;
  try { child.postMessage({ type: 'ai-keys', keys: readAiKeys() }); } catch (_) {}
}

// ---------- helpers ----------
function post(route, body) {
  return new Promise((resolve) => {
    if (!serverPort) return resolve(null);
    const data = JSON.stringify(body || {});
    const req = http.request(
      { host: '127.0.0.1', port: serverPort, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } }); }
    );
    req.on('error', () => resolve(null));
    req.write(data); req.end();
  });
}

function get(route) {
  return new Promise((resolve) => {
    if (!serverPort) return resolve(null);
    http.get({ host: '127.0.0.1', port: serverPort, path: route }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

const notified = new Set();
function notifyOnce(key, title, body) {
  if (notified.has(key) || !Notification.isSupported()) return;
  notified.add(key);
  new Notification({ title, body, icon: icon('app.ico') }).show();
}

function notify(title, body, force) {
  // `force` bypasses the notifyOnProblem setting - an update being ready is
  // not a problem, and switching problem alerts off shouldn't hide it.
  if ((!force && !settings.read().notifyOnProblem) || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon('app.ico') });
  n.on('click', () => openWindow());
  n.show();
}

// Watch the engine's own health report. This is the safety net for the failure
// that already bit once: WhatsApp changes something, downloads start failing,
// and nothing tells anyone for weeks.
function watchHealth() {
  setInterval(async () => {
    const st = await get('/api/state');
    if (!st) return;
    const healthy = !st.health || st.health.ok !== false;
    if (healthy !== lastHealthy) {
      lastHealthy = healthy;
      updateTray();
      if (!healthy) {
        notify(`${APP_NAME}: capture may be broken`,
          `${st.health.consecutiveFailures} downloads failed in a row. WhatsApp may have changed — check for an update.`);
      }
    }
    if (st.needsRelink) notifyOnce('relink', `${APP_NAME}: device unlinked`, 'Open the app and scan the QR code again to reconnect.');
  }, 30000);
}

// ---------- updates ----------
// Persist desktop updater diagnostics; these requests run outside the capture
// engine, so its log cannot explain an update failure.
const updateLog = path.join(HOME, 'logs', 'updates.log');
const updateLogger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => {
  try {
    fs.mkdirSync(path.dirname(updateLog), { recursive: true });
    if (fs.existsSync(updateLog) && fs.statSync(updateLog).size > 1024 * 1024) {
      fs.copyFileSync(updateLog, updateLog + '.previous');
      fs.writeFileSync(updateLog, '');
    }
    fs.appendFileSync(updateLog, new Date().toISOString() + ' [' + level + '] ' + args.map(String).join(' ') + '\n');
  } catch (_) {} // A locked log must not break updates.
}]));
const updates = require('./updates').createUpdates({
  getUpdater: () => require('electron-updater').autoUpdater,
  packaged: isPackaged,
  current: app.getVersion(),
  logger: updateLogger,
  notify: version => notify(`${APP_NAME} ${version} is ready`, 'Choose Install and restart in the app, or quit to install it.', true),
  onInstallError: () => { quitting = false; suspended = false; startEngine(); },
});

async function checkForUpdates(interactive) {
  const u = await updates.check();
  if (!interactive) return;
  if (u.status === 'error') return dialog.showErrorBox(APP_NAME, 'Could not check for updates: ' + u.error);
  const message = !u.packaged ? 'Updates apply to the installed Windows app.'
    : u.status === 'ready' ? `Version ${u.version} is ready. Choose Install and restart in the app, or quit to install it.`
    : u.status === 'downloading' ? `Version ${u.version} is downloading (${u.percent}%). The app will show when it is ready.`
    : u.status === 'current' ? `No newer compatible update is available. Installed version: ${u.current}. Latest release: ${u.latestVersion}.`
    : 'An update is being installed.';
  return dialog.showMessageBox({ title: APP_NAME, message, buttons: ['OK'] });
}

// ---------- IPC exposed to the dashboard ----------
function registerIpc() {
  const fileActions = require(path.join(__dirname, 'file-actions')).createFileActions({
    // Do not expose the sibling session/key directories under HOME to copying.
    getRoots: () => { const s = settings.read(); return [path.join(HOME, 'media'), s.mediaRoot, s.cloudRoot]; },
    writeText: text => require('electron').clipboard.writeText(text),
  });
  for (const action of ['copyPaths', 'copyFileLinks', 'copyFiles']) {
    ipcMain.handle('wb:' + action, (_event, targets) => fileActions[action](targets));
  }
  ipcMain.handle('wb:info', () => ({
    version: app.getVersion(),
    packaged: isPackaged,
    home: HOME,
    paths: currentPaths(),
    startWithWindows: startupEnabled(),
    oldInstall: migrate.findOldInstall(ROOT),
  }));

  ipcMain.handle('wb:pickFolder', async (_e, { title, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(win || undefined, {
      title: title || 'Choose a folder',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('wb:openPath', async (_e, target) => {
    if (!target) return false;
    await shell.openPath(target);
    return true;
  });

  // Opens Explorer with the file selected. Only for files inside this app's
  // own folder or its cloud folder: the page asks, the shell checks.
  ipcMain.handle('wb:showInFolder', async (_e, target) => {
    if (typeof target !== 'string' || !target) return false;
    const fsx = require('fs');
    let real;
    try { real = fsx.realpathSync(target); } catch (_) { return false; }
    const inside = (root) => {
      if (!root) return false;
      let r; try { r = fsx.realpathSync(root); } catch (_) { r = path.resolve(root); }
      const rel = path.relative(r.toLowerCase(), real.toLowerCase());
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    const s = settings.read();
    if (!inside(HOME) && !inside(s.cloudRoot) && !inside(s.mediaRoot)) return false;
    shell.showItemInFolder(real);
    return true;
  });

  ipcMain.handle('wb:setStartup', (_e, enabled) => {
    const now = setStartup(enabled);
    settings.write({ startWithWindows: now });
    return now;
  });

  ipcMain.handle('wb:restart', () => { restartEngine(); return true; });
  // The header button reads the result itself; only the tray asks for a dialog.
  ipcMain.handle('wb:checkUpdates', (_e, quiet) => { checkForUpdates(!quiet); return true; });
  ipcMain.handle('wb:updateStatus', () => updates.status());
  // Waiting for the next quit is fine by default, but someone who has just been
  // told an update is ready should be able to take it now.
  ipcMain.handle('wb:installUpdate', async () => {
    if (updates.status().status !== 'ready') return false;
    if (await updates.install(async () => { await stopEngine(); quitting = true; })) return true;
    quitting = false;
    suspended = false;
    startEngine();
    return false;
  });
  ipcMain.handle('wb:quit', () => { quitting = true; app.quit(); return true; });

  // Chrome holds the session folder open, so the engine has to stand down
  // before anything copies a session on top of it.
  ipcMain.handle('wb:migrate', async (_e, from) => {
    await stopEngine();
    try {
      return await migrate.run(from, HOME, (m) => {
        if (win && !win.isDestroyed()) win.webContents.send('wb:migrate-progress', m);
      });
    } finally {
      suspended = false;
      startEngine();
    }
  });

  // The renderer can set or clear the key and ask whether one is stored — it
  // can never read it back.
  ipcMain.handle('wb:setAiKey', (_e, plain, provider) => saveAiKey(typeof plain === 'string' ? plain.trim() : '', provider));
  ipcMain.handle('wb:hasAiKey', () => {
    const keys = readAiKeys();
    return {
      stored: !!settings.read().aiKeyEnc || Object.keys(settings.read().aiKeysEnc || {}).length > 0,
      usable: !!readAiKey(),
      // Which providers in the chain actually have a working key behind them.
      providers: Object.keys(keys),
    };
  });

  ipcMain.handle('wb:copyDiagnostics', async () => {
    const d = await get('/api/diagnostics');
    const { clipboard } = require('electron');
    clipboard.writeText(JSON.stringify(d, null, 2));
    return true;
  });
}

// ---------- lifecycle ----------
if (!ownsInstance) {
  app.quit();
} else {
  app.on('second-instance', () => openWindow());

  app.whenReady().then(() => {
    registerIpc();

    tray = new Tray(icon('tray-off.ico'));
    tray.on('click', () => openWindow());
    updateTray();

    // Keep the login-item registration in step with the saved setting, in case
    // the app was moved or reinstalled.
    const s = settings.read();
    if (s.startWithWindows !== startupEnabled()) setStartup(s.startWithWindows);

    startEngine();
    watchHealth();
    setInterval(updateTray, 15000);
    updates.startAutomatic(() => settings.read().autoUpdate);
  });

  app.on('window-all-closed', (e) => { /* tray app: keep running */ });

  app.on('before-quit', () => {
    quitting = true;
    updates.stopAutomatic();
    if (child) { try { child.kill(); } catch (_) {} }
  });
}
