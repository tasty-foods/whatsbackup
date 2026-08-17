'use strict';
const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const store = require('./store');
const settings = require('./settings');
const maintenance = require('./maintenance');
const messages = require('./messages');
const exporter = require('./exporter');
const contacts = require('./contacts');
const { getState, runBackfill } = require('./whatsapp');

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

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(localHostOnly);
  app.use(express.json());

  // Images: static (fast, safe). Videos: dynamic so we always serve from the
  // current video folder and fall back to the local folder if the cloud drive
  // isn't reachable — instead of a silent 404.
  app.use('/media/images', express.static(cfg.IMAGES_DIR, { maxAge: '1h' }));
  app.get('/media/videos/:name', (req, res) => {
    const name = safeName(req.params.name); // express already URL-decodes params
    if (!name) return res.status(400).end();
    const candidate = [path.join(cfg.VIDEO_DIR, name), path.join(cfg.LOCAL_VIDEO_DIR, name)]
      .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
    if (!candidate) return res.status(404).end();
    res.sendFile(candidate, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  app.use(express.static(cfg.PUBLIC_DIR));

  app.get('/api/state', (req, res) => res.json(getState()));

  app.get('/api/list', (req, res) => {
    const { kind, dir, chat } = req.query;
    const since = req.query.since ? parseInt(req.query.since, 10) : 0;
    res.json(store.listRecords({ kind: kind || undefined, direction: dir || undefined, chat: chat || undefined, since: since || undefined }));
  });

  // Download every image as a single zip. (Videos live in pCloud already.)
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
      cloudAvailable: cfg.CLOUD_AVAILABLE,
      effectiveCloudRoot: cfg.CLOUD_ROOT,
      paths: {
        app: cfg.PROJECT_ROOT, images: cfg.IMAGES_DIR, videos: cfg.VIDEO_DIR,
        data: cfg.DATA_DIR, settingsFile: cfg.SETTINGS_FILE, indexFile: cfg.INDEX_FILE,
        log: cfg.LOG_FILE, auth: cfg.AUTH_DIR,
      },
      port: cfg.PORT,
    });
  });

  app.post('/api/settings', sameOrigin, (req, res) => {
    const b = req.body || {};
    const patch = {};
    let restartRequired = false;
    if (typeof b.mirrorImages === 'boolean') patch.mirrorImages = b.mirrorImages;
    if (typeof b.captureConversations === 'boolean') patch.captureConversations = b.captureConversations;
    if (typeof b.backfillLimit === 'number' && b.backfillLimit > 0) patch.backfillLimit = Math.min(5000, Math.floor(b.backfillLimit));
    if (typeof b.cloudRoot === 'string' && b.cloudRoot.trim()) { patch.cloudRoot = b.cloudRoot.trim(); if (patch.cloudRoot !== settings.read().cloudRoot) restartRequired = true; }
    if (typeof b.port === 'number' && b.port >= 1 && b.port <= 65535) { patch.port = Math.floor(b.port); if (patch.port !== settings.read().port) restartRequired = true; }
    const saved = settings.write(patch);
    res.json({ ok: true, settings: saved, restartRequired });
  });

  app.post('/api/check-path', sameOrigin, (req, res) => {
    let dir = (req.body && req.body.path || '').trim();
    if (!dir) return res.json({ ok: false, writable: false, message: 'Empty path' });
    if (dir.startsWith('\\\\') || dir.startsWith('//')) return res.json({ ok: false, writable: false, message: 'Network (UNC) paths are not allowed.' });
    const target = path.join(dir, 'Videos');
    try {
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, '.probe');
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
      res.json({ ok: true, writable: true, message: `Writable — videos will go to ${target}` });
    } catch (e) {
      res.json({ ok: true, writable: false, message: 'Not writable (' + e.code + ')' });
    }
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

  // ---- Maintenance ----
  app.post('/api/reset', sameOrigin, (req, res) => {
    const all = !!(req.body && req.body.all);
    res.json({ ok: true, ...maintenance.clearGallery({ all }) });
  });

  app.post('/api/restart', sameOrigin, (req, res) => {
    res.json({ ok: true, message: 'Restarting…' });
    const vbs = path.join(cfg.PROJECT_ROOT, 'launch-hidden.vbs');
    try {
      spawn('cmd', ['/c', `timeout /t 2 /nobreak >nul & wscript "${vbs}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { console.error('restart spawn failed', e.message); }
    setTimeout(() => process.exit(0), 400);
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
