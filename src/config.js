'use strict';
const path = require('path');
const fs = require('fs');
const paths = require('./paths');
const settings = require('./settings');

const s = settings.read();

// Media lives wherever the user chose on first run; empty means "in the app's
// own folder". Videos additionally go to a cloud folder when one is configured.
const MEDIA_ROOT = (s.mediaRoot && s.mediaRoot.trim()) || path.join(paths.APP_HOME, 'media');
const CLOUD_ROOT = (process.env.WA_CLOUD_DIR || s.cloudRoot || '').trim();

const config = {
  PROJECT_ROOT: paths.PROJECT_ROOT,
  APP_HOME: paths.APP_HOME,
  PACKAGED: paths.PACKAGED,
  PORT: parseInt(process.env.PORT || s.port || 8788, 10),

  MEDIA_ROOT,
  IMAGES_DIR: path.join(MEDIA_ROOT, 'images'),
  LOCAL_VIDEO_DIR: path.join(MEDIA_ROOT, 'videos'),
  FILES_DIR: path.join(MEDIA_ROOT, 'files'),     // voice notes, audio, documents, stickers

  CLOUD_ROOT,
  CLOUD_CONFIGURED: !!CLOUD_ROOT,
  VIDEO_DIR: CLOUD_ROOT ? path.join(CLOUD_ROOT, 'Videos') : path.join(MEDIA_ROOT, 'videos'),
  IMAGE_CLOUD_DIR: CLOUD_ROOT ? path.join(CLOUD_ROOT, 'Images') : path.join(MEDIA_ROOT, 'images-cloud'),
  MIRROR_IMAGES_TO_CLOUD: process.env.WA_MIRROR_IMAGES === '1' ? true : !!s.mirrorImages,

  DATA_DIR: paths.DATA_DIR,
  INDEX_FILE: path.join(paths.DATA_DIR, 'index.ndjson'),
  SETTINGS_FILE: settings.FILE,
  LOGS_DIR: paths.LOGS_DIR,
  LOG_FILE: path.join(paths.LOGS_DIR, 'whatsbackup.log'),   // must match logger.FILE

  AUTH_DIR: paths.AUTH_DIR,
  PUBLIC_DIR: path.join(paths.PROJECT_ROOT, 'public'),

  // Installed builds ship their own Chrome; from source, puppeteer picks its own.
  CHROME_PATH: process.env.WB_CHROME || null,

  BACKFILL_LIMIT: s.backfillLimit || 400,
  DOWNLOAD_TIMEOUT_MS: Math.max(10, s.downloadTimeoutSec || 90) * 1000,
};

function cloudWritable() {
  if (!config.CLOUD_ROOT) return false;
  try { fs.mkdirSync(path.join(config.CLOUD_ROOT, 'Videos'), { recursive: true }); return true; }
  catch (e) { return false; }
}

// Synchronous sleep without spinning the CPU (used only during startup wait).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

// Decide where videos go. `wait` retries for a bit so a cloud drive that mounts
// a few seconds after login (the app starts at login) isn't permanently missed.
function applyCloud(wait) {
  if (!config.CLOUD_ROOT) {           // no cloud configured — everything stays local
    config.VIDEO_DIR = config.LOCAL_VIDEO_DIR;
    config.IMAGE_CLOUD_DIR = path.join(config.MEDIA_ROOT, 'images-cloud');
    config.CLOUD_AVAILABLE = false;
    return false;
  }
  let ok = cloudWritable();
  if (!ok && wait) {
    const tries = parseInt(process.env.WA_CLOUD_WAIT || '8', 10);
    for (let i = 0; i < tries && !ok; i++) { sleepSync(1000); ok = cloudWritable(); }
  }
  if (ok) {
    config.VIDEO_DIR = path.join(config.CLOUD_ROOT, 'Videos');
    config.IMAGE_CLOUD_DIR = path.join(config.CLOUD_ROOT, 'Images');
    config.CLOUD_AVAILABLE = true;
  } else {
    config.VIDEO_DIR = config.LOCAL_VIDEO_DIR;
    config.IMAGE_CLOUD_DIR = path.join(config.MEDIA_ROOT, 'images-cloud');
    config.CLOUD_AVAILABLE = false;
  }
  return config.CLOUD_AVAILABLE;
}

// Lightweight runtime health check — flips CLOUD_AVAILABLE if the drive drops or
// (re)appears, so the UI reflects reality. Does not relocate the session's video
// folder (kept stable to avoid split storage); the video route falls back to the
// local folder when serving.
function recheckCloud() {
  const before = config.CLOUD_AVAILABLE;
  const ok = cloudWritable();
  config.CLOUD_AVAILABLE = ok;
  return before !== ok;
}

applyCloud(true);
if (config.CLOUD_ROOT && !config.CLOUD_AVAILABLE) {
  console.warn(`[config] Cloud folder "${config.CLOUD_ROOT}" not writable yet — videos will be saved locally to ${config.VIDEO_DIR}. They move to the cloud folder after a restart once the drive is available.`);
}

config.recheckCloud = recheckCloud;
module.exports = config;
