'use strict';
const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');
const settings = require('./settings');
const maintenance = require('./maintenance');
const messages = require('./messages');
const exporter = require('./exporter');
const contacts = require('./contacts');
const logger = require('./logger');
const { getState, runBackfill, unlink, reconnectNow } = require('./whatsapp');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

// Reject requests whose Host header isn't a loopback name — defeats DNS-rebinding
// even though we also bind to 127.0.0.1.
function localHostOnly(req, res, next) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host && !LOCAL_HOSTS.has(host)) return res.status(403).json({ error: 'forbidden host' });
  next();
}

// For state-changing routes, reject cross-site Origins (CSRF defense-in-depth).
function sameOrigin(req, res, next) {
  const o = req.headers.origin;
  if (o) {
    try { if (!LOCAL_HOSTS.has(new URL(o).hostname.toLowerCase())) return res.status(403).json({ error: 'bad origin' }); }
    catch (_) { return res.status(403).json({ error: 'bad origin' }); }
  }
  next();
}

function safeName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (path.basename(name) !== name) return null;
  return name;
}

// One place that says what each setting is, so the POST handler can validate
// generically instead of growing an if-branch per field.
const SETTING_SPEC = {
  port: { type: 'int', min: 1, max: 65535, restart: true },
  mediaRoot: { type: 'path', restart: true },
  cloudRoot: { type: 'path', restart: true },
  mirrorImages: { type: 'bool' },
  captureImages: { type: 'bool' },
  captureVideos: { type: 'bool' },
  captureVoice: { type: 'bool' },
  captureAudio: { type: 'bool' },
  captureDocuments: { type: 'bool' },
  captureStickers: { type: 'bool' },
  captureSent: { type: 'bool' },
  captureReceived: { type: 'bool' },
  captureGroups: { type: 'bool' },
  captureConversations: { type: 'bool' },
  excludedChats: { type: 'list' },
  backfillLimit: { type: 'int', min: 50, max: 5000 },
  downloadTimeoutSec: { type: 'int', min: 10, max: 600, restart: true },
  startWithWindows: { type: 'bool' },
  startMinimized: { type: 'bool' },
  closeToTray: { type: 'bool' },
  notifyOnProblem: { type: 'bool' },
  autoUpdate: { type: 'bool' },
  logMaxMB: { type: 'int', min: 1, max: 100, restart: true },
  retentionDays: { type: 'int', min: 0, max: 3650 },
  setupComplete: { type: 'bool' },
  consentAccepted: { type: 'bool' },
};

function coerce(spec, value) {
  if (spec.type === 'bool') return typeof value === 'boolean' ? value : undefined;
  if (spec.type === 'int') {
    const n = typeof value === 'number' ? Math.floor(value) : parseInt(value, 10);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) return undefined;
    return n;
  }
  if (spec.type === 'path') return typeof value === 'string' ? value.trim() : undefined;
  if (spec.type === 'list') return Array.isArray(value) ? value.filter((x) => typeof x === 'string').slice(0, 500) : undefined;
  return undefined;
}

// Folder sizes for the storage readout. Walks are bounded and cached — the
// cloud folder can sit on a slow network drive.
const sizeCache = new Map();
function folderSize(dir, ttlMs = 60000) {
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  let bytes = 0, files = 0;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { try { bytes += fs.statSync(p).size; files++; } catch (_) {} }
    }
  };
  walk(dir, 0);
  const value = { bytes, files };
  sizeCache.set(dir, { at: Date.now(), value });
  return value;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(localHostOnly);
  app.use(express.json());

  // Images: static (fast, safe). Videos and files: dynamic so we always serve
  // from the current folder and fall back to the local folder if the cloud
  // drive isn't reachable — instead of a silent 404.
  app.use('/media/images', express.static(cfg.IMAGES_DIR, { maxAge: '1h' }));
  const serveFrom = (dirs) => (req, res) => {
    const name = safeName(req.params.name); // express already URL-decodes params
    if (!name) return res.status(400).end();
    const candidate = dirs.map((d) => path.join(d, name))
      .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
    if (!candidate) return res.status(404).end();
    res.sendFile(candidate, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  };
  app.get('/media/videos/:name', (req, res) => serveFrom([cfg.VIDEO_DIR, cfg.LOCAL_VIDEO_DIR])(req, res));
  app.get('/media/files/:name', (req, res) => serveFrom([cfg.FILES_DIR])(req, res));

  app.use(express.static(cfg.PUBLIC_DIR));

  app.get('/api/state', (req, res) => res.json(getState()));

  app.get('/api/list', (req, res) => {
    const { kind, dir, chat } = req.query;
    const since = req.query.since ? parseInt(req.query.since, 10) : 0;
    res.json(store.listRecords({ kind: kind || undefined, direction: dir || undefined, chat: chat || undefined, since: since || undefined }));
  });

  // Download every image as a single zip. (Videos may live on a cloud drive.)
  app.get('/api/zip', (req, res) => {
    const recs = store.listRecords({ kind: 'image' });
    if (!recs.length) return res.status(404).json({ error: 'No images to download yet.' });
    res.attachment(`whatsapp-images-${new Date().toISOString().slice(0, 10)}.zip`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => { console.error('zip error', err); try { res.status(500).end(); } catch (_) {} });
    archive.pipe(res);
    for (const r of recs) {
      const p = path.join(cfg.IMAGES_DIR, r.filename);
      if (fs.existsSync(p)) archive.file(p, { name: r.filename });
    }
    archive.finalize();
  });

  // ---- Settings ----
  app.get('/api/settings', (req, res) => {
    res.json({
      settings: settings.read(),
      defaults: settings.DEFAULTS,
      cloudConfigured: cfg.CLOUD_CONFIGURED,
      cloudAvailable: cfg.CLOUD_AVAILABLE,
      effectiveCloudRoot: cfg.CLOUD_ROOT,
      packaged: cfg.PACKAGED,
      paths: {
        home: cfg.APP_HOME, images: cfg.IMAGES_DIR, videos: cfg.VIDEO_DIR, files: cfg.FILES_DIR,
        data: cfg.DATA_DIR, settingsFile: cfg.SETTINGS_FILE, indexFile: cfg.INDEX_FILE,
        log: logger.FILE, auth: cfg.AUTH_DIR,
      },
      port: cfg.PORT,
    });
  });

  app.post('/api/settings', sameOrigin, (req, res) => {
    const body = req.body || {};
    const patch = {};
    const rejected = [];
    let restartRequired = false;
    const current = settings.read();
    for (const [key, value] of Object.entries(body)) {
      const spec = SETTING_SPEC[key];
      if (!spec) { rejected.push(key); continue; }
      const clean = coerce(spec, value);
      if (clean === undefined) { rejected.push(key); continue; }
      patch[key] = clean;
      if (spec.restart && JSON.stringify(clean) !== JSON.stringify(current[key])) restartRequired = true;
    }
    const saved = settings.write(patch);
    res.json({ ok: true, settings: saved, restartRequired, rejected });
  });

  app.post('/api/check-path', sameOrigin, (req, res) => {
    let dir = (req.body && req.body.path || '').trim();
    const sub = (req.body && req.body.sub) || 'Videos';
    if (!dir) return res.json({ ok: false, writable: false, message: 'Empty path' });
    if (dir.startsWith('\\\\') || dir.startsWith('//')) return res.json({ ok: false, writable: false, message: 'Network (UNC) paths are not allowed.' });
    const target = sub ? path.join(dir, sub) : dir;
    try {
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, '.probe');
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
      res.json({ ok: true, writable: true, message: `Writable — ${target}` });
    } catch (e) {
      res.json({ ok: true, writable: false, message: 'Not writable (' + e.code + ')' });
    }
  });

  // ---- Storage readout ----
  app.get('/api/storage', (req, res) => {
    const images = folderSize(cfg.IMAGES_DIR);
    const files = folderSize(cfg.FILES_DIR);
    const videos = folderSize(cfg.VIDEO_DIR);
    const data = folderSize(cfg.DATA_DIR);
    res.json({
      images: { ...images, dir: cfg.IMAGES_DIR },
      files: { ...files, dir: cfg.FILES_DIR },
      videos: { ...videos, dir: cfg.VIDEO_DIR, cloud: cfg.CLOUD_AVAILABLE },
      data: { ...data, dir: cfg.DATA_DIR },
      total: images.bytes + files.bytes + videos.bytes + data.bytes,
    });
  });

  // ---- History import ----
  app.post('/api/backfill', sameOrigin, (req, res) => {
    const limit = req.body && req.body.limit ? parseInt(req.body.limit, 10) : undefined;
    const st = getState();
    if (st.status !== 'ready') return res.status(409).json({ ok: false, message: 'Not linked yet — scan the QR first.' });
    if (st.backfill.running) return res.json({ ok: true, alreadyRunning: true });
    runBackfill(limit);
    res.json({ ok: true, started: true });
  });

  // ---- Connection ----
  app.post('/api/unlink', sameOrigin, async (req, res) => {
    try { res.json(await unlink()); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.post('/api/reconnect', sameOrigin, (req, res) => res.json(reconnectNow()));

  // ---- Maintenance ----
  app.post('/api/reset', sameOrigin, (req, res) => {
    const all = !!(req.body && req.body.all);
    res.json({ ok: true, ...maintenance.clearGallery({ all }) });
  });

  // Restarting is the shell's job — it owns the process. From source there is
  // no shell, so say so rather than pretending.
  app.post('/api/restart', sameOrigin, (req, res) => {
    if (!process.parentPort) return res.json({ ok: false, message: 'Restart the app manually when running from source.' });
    res.json({ ok: true, message: 'Restarting…' });
    try { process.parentPort.postMessage({ type: 'restart-requested' }); } catch (_) {}
  });

  // A single blob of everything useful for support, without asking anyone to
  // find a log file. Paths only — no message content.
  app.get('/api/diagnostics', (req, res) => {
    const st = getState();
    let tail = '';
    try {
      const raw = fs.readFileSync(logger.FILE, 'utf8');
      tail = raw.slice(-8000);
    } catch (_) {}
    res.json({
      app: { version: process.env.WB_VERSION || 'dev', packaged: cfg.PACKAGED, home: cfg.APP_HOME },
      versions: { node: process.versions.node, electron: process.versions.electron || null, chrome: process.versions.chrome || null },
      state: { status: st.status, me: st.me ? 'linked' : null, lastError: st.lastError, needsRelink: st.needsRelink, health: st.health },
      counts: st.counts,
      conversations: st.conversations,
      cloud: { configured: cfg.CLOUD_CONFIGURED, available: cfg.CLOUD_AVAILABLE, root: cfg.CLOUD_ROOT },
      settings: settings.read(),
      logTail: tail,
    });
  });

  // ---- Conversations ----
  // Resolve any group-author ids to contact names at read time (belt & suspenders).
  const withNames = (rows) => { for (const r of rows) { if (r.author && r.author !== 'me') { const n = contacts.resolve(r.author); if (n) r.author = n; } } return rows; };

  app.get('/api/chats', (req, res) => { try { res.json(messages.listChats()); } catch (e) { res.json([]); } });
  app.get('/api/thread', (req, res) => {
    const chat = req.query.chat;
    if (!chat) return res.status(400).json({ error: 'chat required' });
    const limit = Math.min(500, parseInt(req.query.limit || '200', 10));
    try {
      if (req.query.after) return res.json(withNames(messages.getNewer(chat, parseInt(req.query.after, 10), limit)));
      const before = req.query.before ? parseInt(req.query.before, 10) : undefined;
      res.json(withNames(messages.getThread(chat, before, limit)));
    } catch (e) { res.json([]); }
  });
  app.get('/api/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    try { res.json(messages.search(q, 200)); } catch (e) { res.json([]); }
  });
  app.post('/api/export', sameOrigin, (req, res) => {
    try { res.json({ ok: true, ...exporter.exportTranscript() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  return app;
}

module.exports = createApp;
