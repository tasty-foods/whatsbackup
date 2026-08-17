'use strict';
const path = require('path');
const fs = require('fs');
const settings = require('./settings');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const s = settings.read();

const CLOUD_ROOT = process.env.WA_CLOUD_DIR || s.cloudRoot || 'P:/WhatsApp Media';

const config = {
  PROJECT_ROOT,
  PORT: parseInt(process.env.PORT || s.port || 8788, 10),

  IMAGES_DIR: path.join(PROJECT_ROOT, 'media', 'images'),

  CLOUD_ROOT,
  VIDEO_DIR: path.join(CLOUD_ROOT, 'Videos'),
  IMAGE_CLOUD_DIR: path.join(CLOUD_ROOT, 'Images'),
  LOCAL_VIDEO_DIR: path.join(PROJECT_ROOT, 'media', 'videos'),

  MIRROR_IMAGES_TO_CLOUD: process.env.WA_MIRROR_IMAGES === '1' ? true : !!s.mirrorImages,

  DATA_DIR: path.join(PROJECT_ROOT, 'data'),
  INDEX_FILE: path.join(PROJECT_ROOT, 'data', 'index.ndjson'),
  SETTINGS_FILE: settings.FILE,
  LOG_FILE: path.join(PROJECT_ROOT, 'logs', 'dashboard.log'),

  AUTH_DIR: path.join(PROJECT_ROOT, '.wwebjs_auth'),
  PUBLIC_DIR: path.join(PROJECT_ROOT, 'public'),

  BACKFILL_LIMIT: s.backfillLimit || 400,
};

function cloudWritable() {
  try { fs.mkdirSync(path.join(config.CLOUD_ROOT, 'Videos'), { recursive: true }); return true; }
  catch (e) { return false; }
}

// Synchronous sleep without spinning the CPU (used only during startup wait).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

// Decide where videos go. `wait` retries for a bit so a pCloud drive that mounts
// a few seconds after login (the app auto-starts at login) isn't permanently missed.
function applyCloud(wait) {
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
    config.IMAGE_CLOUD_DIR = path.join(PROJECT_ROOT, 'media', 'images-cloud');
    config.CLOUD_AVAILABLE = false;
  }
  return config.CLOUD_AVAILABLE;
}

// Lightweight runtime health check — flips CLOUD_AVAILABLE if the drive drops or
// (re)appears, so /api/state and the UI reflect reality. Does not relocate the
// session's video folder (kept stable to avoid split storage); the video route
// falls back to the local folder when serving.
function recheckCloud() {
  const before = config.CLOUD_AVAILABLE;
  const ok = cloudWritable();
  config.CLOUD_AVAILABLE = ok;
  return before !== ok;
}

applyCloud(true);
if (!config.CLOUD_AVAILABLE) {
  console.warn(`[config] Cloud folder "${config.CLOUD_ROOT}" not writable yet — videos will be saved locally to ${config.VIDEO_DIR}. They move to pCloud after a restart once the drive is available.`);
}

config.recheckCloud = recheckCloud;
module.exports = config;
