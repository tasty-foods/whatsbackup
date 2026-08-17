'use strict';
// One-time import from the pre-desktop version: the gallery index, the message
// database, and — the part that matters most — the linked WhatsApp session, so
// nobody has to scan a QR code again.
//
// Rules learned the hard way: never copy a live SQLite database (the -wal holds
// writes that aren't in the .db yet), always copy rather than move, and verify
// the counts before telling anyone it worked.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function dirSize(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { bytes += fs.statSync(p).size; } catch (_) {} }
    }
  }
  return bytes;
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; }
  catch (_) { return 0; }
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length; } catch (_) { return 0; }
}

function countMessages(dbFile) {
  if (!fs.existsSync(dbFile)) return 0;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM messages').get();
    db.close();
    return row ? row.c : 0;
  } catch (_) { return 0; }
}

// Is an old copy still running? Copying its database out from under it is how
// you lose messages, so this is a hard stop rather than a warning.
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// A candidate is any folder that looks like the old app: a gallery index or a
// linked session sitting next to each other.
function describe(dir) {
  const data = path.join(dir, 'data');
  const session = path.join(dir, '.wwebjs_auth');
  const images = path.join(dir, 'media', 'images');
  const index = path.join(data, 'index.ndjson');
  const db = path.join(data, 'messages.db');
  const hasAnything = fs.existsSync(index) || fs.existsSync(session);
  if (!hasAnything) return null;
  return {
    path: dir,
    images: countFiles(images),
    records: countLines(index),
    messages: countMessages(db),
    hasSession: fs.existsSync(session),
    sessionBytes: fs.existsSync(session) ? dirSize(session) : 0,
    port: (() => { try { return JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).port || 8788; } catch (_) { return 8788; } })(),
  };
}

function findOldInstall(appRoot) {
  const candidates = [
    appRoot,
    path.join(process.env.USERPROFILE || '', 'Projects', 'pcloud whatsapp'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { if (!fs.existsSync(c)) continue; } catch (_) { continue; }
    const d = describe(c);
    if (d && (d.records > 0 || d.hasSession)) return d;
  }
  return null;
}

// robocopy is the right tool here: it retries locked files, preserves
// timestamps, and doesn't choke on the deep paths inside a Chromium profile.
function robocopy(from, to, onProgress, label) {
  return new Promise((resolve) => {
    if (!fs.existsSync(from)) return resolve({ skipped: true });
    fs.mkdirSync(to, { recursive: true });
    onProgress({ step: label, state: 'copying' });
    const p = spawn('robocopy', [from, to, '/E', '/R:2', '/W:1', '/MT:8', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true });
    p.on('error', () => resolve({ ok: false, error: 'robocopy not available' }));
    p.on('exit', (code) => resolve({ ok: code < 8, code }));   // robocopy: <8 means success
  });
}

async function run(from, home, onProgress = () => {}) {
  const src = describe(from);
  if (!src) return { ok: false, message: 'That folder does not look like a previous installation.' };

  if (await probePort(src.port)) {
    return {
      ok: false,
      message: `The old version is still running on port ${src.port}. Close it first (right-click its tray icon, or end the "node" process in Task Manager) so its database can be copied safely.`,
    };
  }

  const targets = {
    session: path.join(home, 'session'),
    data: path.join(home, 'data'),
    images: path.join(home, 'media', 'images'),
  };

  const steps = [];
  if (src.hasSession) {
    onProgress({ step: 'session', state: 'start', bytes: src.sessionBytes });
    steps.push(['session', await robocopy(path.join(from, '.wwebjs_auth'), targets.session, onProgress, 'session')]);
  }
  steps.push(['data', await robocopy(path.join(from, 'data'), targets.data, onProgress, 'data')]);
  steps.push(['images', await robocopy(path.join(from, 'media', 'images'), targets.images, onProgress, 'images')]);

  const failed = steps.filter(([, r]) => r && r.ok === false);
  if (failed.length) {
    return { ok: false, message: `Copying failed at: ${failed.map(([n]) => n).join(', ')}. Nothing was removed from the old folder.` };
  }

  // Verify against the source before claiming success.
  const after = {
    records: countLines(path.join(targets.data, 'index.ndjson')),
    messages: countMessages(path.join(targets.data, 'messages.db')),
    images: countFiles(targets.images),
  };
  const complete = after.records >= src.records && after.messages >= src.messages && after.images >= src.images;

  // The imported settings decide where videos go; mark setup done so someone
  // who already linked isn't sent back through the first-run wizard.
  try {
    const settingsFile = path.join(targets.data, 'settings.json');
    const s = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    s.setupComplete = true;
    s.consentAccepted = true;
    s.mediaRoot = '';                       // media now lives in the app home
    fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  } catch (_) {}

  onProgress({ step: 'done', state: 'done' });
  return {
    ok: true,
    complete,
    imported: after,
    expected: { records: src.records, messages: src.messages, images: src.images },
    sessionCopied: !!src.hasSession,
    message: complete
      ? `Imported ${after.images} images, ${after.records} gallery entries and ${after.messages} messages.${src.hasSession ? ' Your WhatsApp link came across too — no new QR scan needed.' : ''}`
      : `Imported, but some counts came up short (${after.images}/${src.images} images, ${after.messages}/${src.messages} messages). The old folder is untouched — try again with the old app fully closed.`,
  };
}

module.exports = { findOldInstall, run, describe };
