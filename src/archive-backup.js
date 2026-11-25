'use strict';
// The archive's own records, copied to the cloud folder.
//
// Pictures, videos and files are mirrored to the cloud folder by backup.js.
// What was not: the conversations themselves (messages.db, which also holds
// contacts, labels, topics and transcripts) and the index that says which
// file belongs to which chat. Lose the PC and the media survived as a heap
// of files, with every word and all of the order gone.
//
// When "Keep a copy of conversations in the cloud folder" is on, once a day:
//   <cloud folder>/Archive data/conversations.db   (+ conversations.previous.db)
//   <cloud folder>/Archive data/index.ndjson       (+ index.previous.ndjson)
//   <cloud folder>/Archive data/library.json, quarantine.json
//   <cloud folder>/Archive data/READ ME.txt
// Off by default: message text leaves this PC only when asked to. Settings
// are never copied (they hold the encrypted keys, which only this PC can read).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const settings = require('./settings');
const messages = require('./messages');

const FOLDER = 'Archive data';
const EVERY_MS = 24 * 3600 * 1000;
const CHECK_MS = 30 * 60 * 1000;
const FIRST_CHECK_MS = 3 * 60 * 1000;

const state = { running: false, lastAt: 0, lastError: null, bytes: 0, files: 0 };
let timer = null;

const log = (...a) => console.log('[archive-backup]', ...a);
const targetDir = () => (cfg.CLOUD_ROOT ? path.join(cfg.CLOUD_ROOT, FOLDER) : null);
const enabled = () => !!settings.read().backupConversations;
const previousOf = (file) => file.replace(/(\.[^.\\/]+)$/, '.previous$1');
const sizeOf = async (file) => { try { return (await fs.promises.stat(file)).size; } catch (_) { return 0; } };

// A consistent copy of the live database. The online backup reads it page by
// page without holding the engine up; VACUUM INTO is the fallback where the
// runtime does not offer one.
async function snapshotDatabase(file) {
  await fs.promises.rm(file, { force: true });
  const db = messages.handle();
  const sqlite = require('node:sqlite');
  if (typeof sqlite.backup === 'function') await sqlite.backup(db, file, { rate: 2000 });
  else db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
}

// The new copy is written beside the old one and only then takes its name;
// the one it replaces is kept as ".previous", so there are always two days.
async function place(src, dest) {
  const part = dest + '.whatsbackup-part';
  await fs.promises.copyFile(src, part);
  if (await sizeOf(part) !== await sizeOf(src)) { await fs.promises.rm(part, { force: true }); throw new Error('the copy of ' + path.basename(dest) + ' came out incomplete'); }
  if (await sizeOf(dest)) {
    await fs.promises.rm(previousOf(dest), { force: true });
    await fs.promises.rename(dest, previousOf(dest));
  }
  await fs.promises.rename(part, dest);
  return sizeOf(dest);
}

const READ_ME = [
  'WhatsBackUp — archive data',
  '',
  'conversations.db   every saved message, contact, AI label, topic and transcript',
  'index.ndjson       which saved picture, video or file belongs to which chat',
  'library.json       favourites and saved views',
  '*.previous.*       the copy from the day before',
  '',
  'To put them back on a new PC: install WhatsBackUp, quit it completely (tray icon → Quit),',
  'then copy conversations.db to %LOCALAPPDATA%\\WhatsBackUp\\data\\messages.db',
  '(delete messages.db-wal and messages.db-shm there if present), and index.ndjson and',
  'library.json into the same folder. Start the app again and point it at this cloud folder.',
  '',
].join('\r\n');

async function run({ force = false, reason = 'manual' } = {}) {
  if (state.running) return { ok: false, error: 'A copy is already being made.' };
  const dir = targetDir();
  if (!dir) return { ok: false, error: 'Choose a cloud folder first.' };
  try { if (!(await fs.promises.stat(cfg.CLOUD_ROOT)).isDirectory()) throw new Error(); }
  catch (_) { state.lastError = 'The cloud folder is not reachable right now.'; return { ok: false, error: state.lastError }; }

  state.running = true;
  const snap = path.join(cfg.DATA_DIR, 'archive-backup-snapshot.db');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await snapshotDatabase(snap);
    // A nearly empty archive must not replace a full one: that is what a
    // fresh install on a new PC would do to the very copy it should be
    // restored from.
    const have = await sizeOf(path.join(dir, 'conversations.db'));
    const mine = await sizeOf(snap);
    if (!force && have > 1024 * 1024 && mine < have / 2) {
      throw new Error('The copy in the cloud folder is much larger than this archive, so it was left as it is. If this PC is the one to keep, use "Copy now" to replace it.');
    }
    let bytes = 0, files = 0;
    bytes += await place(snap, path.join(dir, 'conversations.db')); files++;
    for (const name of ['index.ndjson', 'library.json', 'quarantine.json']) {
      const src = path.join(cfg.DATA_DIR, name);
      if (!(await sizeOf(src))) continue;
      bytes += await place(src, path.join(dir, name)); files++;
    }
    await fs.promises.writeFile(path.join(dir, 'READ ME.txt'), READ_ME);
    Object.assign(state, { lastAt: Date.now(), lastError: null, bytes, files });
    try { settings.write({ lastArchiveBackupAt: state.lastAt }); } catch (_) {}
    log(`conversations and index copied to ${dir} (${Math.round(bytes / 1048576)} MB, ${reason})`);
    return { ok: true, at: state.lastAt, bytes, files, dir };
  } catch (e) {
    state.lastError = String((e && e.message) || e);
    console.warn('[archive-backup] not copied:', state.lastError);
    return { ok: false, error: state.lastError };
  } finally {
    state.running = false;
    try { await fs.promises.rm(snap, { force: true }); } catch (_) {}
  }
}

function status() {
  const s = settings.read();
  return {
    enabled: !!s.backupConversations,
    configured: !!cfg.CLOUD_ROOT,
    dir: targetDir(),
    running: state.running,
    lastAt: state.lastAt || s.lastArchiveBackupAt || 0,
    lastError: state.lastError,
    bytes: state.bytes,
  };
}

// Daily, checked every half hour so a PC that slept through the hour still
// gets its copy the same day.
async function check() {
  try {
    if (!enabled() || state.running || !cfg.CLOUD_ROOT) return;
    const last = state.lastAt || settings.read().lastArchiveBackupAt || 0;
    if (Date.now() - last < EVERY_MS) return;
    await run({ reason: 'daily' });
  } catch (e) { console.warn('[archive-backup] check failed:', e.message); }
}

function init() {
  if (timer) return;
  const first = setTimeout(check, FIRST_CHECK_MS);
  timer = setInterval(check, CHECK_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
}

module.exports = { init, run, status, check, FOLDER };
