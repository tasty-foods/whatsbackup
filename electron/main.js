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
let updater = null;
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

// ---------- window ----------
function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  if (!serverPort) return;   // engine isn't listening yet — don't build a window pointed at http://127.0.0.1:null/
  const startHidden = settings.read().startMinimized && process.argv.includes('--hidden');

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    show: false,
    backgroundColor: '#0b141a',
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
function saveAiKey(plain) {
  if (!plain) { settings.write({ aiKeyEnc: '' }); sendAiKey(); return { ok: true, cleared: true }; }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'Windows could not provide secure storage for the key.' };
  settings.write({ aiKeyEnc: safeStorage.encryptString(plain).toString('base64') });
  sendAiKey();
  return { ok: true };
}

function readAiKey() {
  const enc = settings.read().aiKeyEnc;
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }
  catch (_) { return ''; }   // a different machine or Windows profile can't decrypt it
}

function sendAiKey() {
  if (!child) return;
  try { child.postMessage({ type: 'ai-key', key: readAiKey() }); } catch (_) {}
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
// What the updater is doing, in a shape the dashboard can render. Updating
// silently is right; being unable to find out is not — "am I on the current
// version" was previously answerable only by comparing two numbers by hand.
let updateState = { status: 'idle', version: null, percent: 0, error: null, checkedAt: 0 };
const setUpdateState = (patch) => { updateState = { ...updateState, ...patch }; };

function checkForUpdates(interactive) {
  try {
    if (!updater) {
      const { autoUpdater } = require('electron-updater');
      updater = autoUpdater;
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.on('checking-for-update', () => setUpdateState({ status: 'checking', error: null }));
      updater.on('update-available', (info) => setUpdateState({ status: 'downloading', version: info && info.version, percent: 0 }));
      updater.on('update-not-available', () => setUpdateState({ status: 'current', version: null, checkedAt: Date.now() }));
      updater.on('download-progress', (p) => setUpdateState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
      updater.on('update-downloaded', (info) => {
        setUpdateState({ status: 'ready', version: info && info.version, percent: 100, checkedAt: Date.now() });
        notify(`${APP_NAME} ${info.version} is ready`, 'It will be installed when you quit the app.', true);
      });
      updater.on('error', (e) => {
        setUpdateState({ status: 'error', error: (e && e.message) || 'update check failed' });
        console.error('[update] ' + (e && e.message));
      });
    }
    if (!isPackaged) {
      if (interactive) dialog.showMessageBox({ message: 'Updates only apply to installed builds.', buttons: ['OK'] });
      return;
    }
    updater.checkForUpdates().then((r) => {
      setUpdateState({ checkedAt: Date.now() });
      if (interactive) {
        const v = r && r.updateInfo && r.updateInfo.version;
        dialog.showMessageBox({
          title: APP_NAME,
          message: v && v !== app.getVersion() ? `Version ${v} is downloading. It installs when you quit.` : `You're on the latest version (${app.getVersion()}).`,
          buttons: ['OK'],
        });
      }
    }).catch((e) => { if (interactive) dialog.showErrorBox(APP_NAME, 'Could not check for updates: ' + e.message); });
  } catch (e) { console.error('[update] setup failed:', e.message); }
}

// ---------- IPC exposed to the dashboard ----------
function registerIpc() {
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

  ipcMain.handle('wb:setStartup', (_e, enabled) => {
    const now = setStartup(enabled);
    settings.write({ startWithWindows: now });
    return now;
  });

  ipcMain.handle('wb:restart', () => { restartEngine(); return true; });
  ipcMain.handle('wb:checkUpdates', () => { checkForUpdates(true); return true; });
  ipcMain.handle('wb:updateStatus', () => ({ ...updateState, current: app.getVersion(), packaged: isPackaged }));
  // Waiting for the next quit is fine by default, but someone who has just been
  // told an update is ready should be able to take it now.
  ipcMain.handle('wb:installUpdate', () => {
    if (!updater || updateState.status !== 'ready') return false;
    quitting = true;
    setImmediate(() => { try { updater.quitAndInstall(false, true); } catch (e) { console.error('[update] install failed:', e.message); } });
    return true;
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
  ipcMain.handle('wb:setAiKey', (_e, plain) => saveAiKey(typeof plain === 'string' ? plain.trim() : ''));
  ipcMain.handle('wb:hasAiKey', () => ({ stored: !!settings.read().aiKeyEnc, usable: !!readAiKey() }));

  ipcMain.handle('wb:copyDiagnostics', async () => {
    const d = await get('/api/diagnostics');
    const { clipboard } = require('electron');
    clipboard.writeText(JSON.stringify(d, null, 2));
    return true;
  });
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
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
    if (s.autoUpdate) setTimeout(() => checkForUpdates(false), 20000);
  });

  app.on('window-all-closed', (e) => { /* tray app: keep running */ });

  app.on('before-quit', () => {
    quitting = true;
    if (child) { try { child.kill(); } catch (_) {} }
  });
}
