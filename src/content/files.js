'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const cfg = require('../config');
const settings = require('../settings');
// Separate small thumbnail queue: a slow cloud video never holds up the library.
function lane(timeout) {
  let worker, busy = false, sequence = 0;
  const queue = [];
  function next() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    worker ||= new Worker(path.join(__dirname, 'worker.js'));
    worker.ref();
    let timer;
    const finish = (error, result) => {
      clearTimeout(timer);
      const current = worker;
      current?.removeAllListeners('message'); current?.removeAllListeners('error'); current?.removeAllListeners('exit');
      if (error) { worker = null; current?.terminate(); job.reject(error); }
      else { current.unref(); job.resolve(result); }
      busy = false; next();
    };
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', finish);
    worker.once('exit', () => finish(new Error('File reader stopped. Retry this item.')));
    timer = setTimeout(() => finish(new Error('File reading timed out. Make cloud files available offline and retry.')), timeout);
    worker.postMessage({ ...job.task, id: ++sequence });
  }
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}
const indexing = lane(120000), thumbs = lane(20000);
const dirsFor = rec => rec.kind === 'video' ? [cfg.LOCAL_VIDEO_DIR, cfg.VIDEO_DIR] : rec.kind === 'document' ? [cfg.FILES_DIR] : [cfg.IMAGES_DIR];
const thumbnailPath = rec => path.join(cfg.DATA_DIR, 'thumbnails', crypto.createHash('sha256').update(`${rec.id}:${rec.size}:${rec.filename}`).digest('hex') + '.jpg');
const extract = (rec, options = {}) => { const s = settings.read(); return indexing({ ...rec, dirs: dirsFor(rec), frames: s.aiVideoFrames, pages: s.aiDocumentPages, ocrPages: s.aiOcrPages, poster: rec.kind === 'video' ? thumbnailPath(rec) : null, ...options }); };
const pending = new Map();
async function thumbnail(rec) {
  const key = crypto.createHash('sha256').update(`${rec.id}:${rec.size}:${rec.filename}`).digest('hex');
  const destination = path.join(cfg.DATA_DIR, 'thumbnails', key + '.jpg');
  try { await fs.access(destination); return destination; } catch (_) {}
  if (rec.kind === 'video') return null;
  if (!pending.has(key)) pending.set(key, thumbs({ action: 'thumbnail', filename: rec.filename, dirs: dirsFor(rec), destination }).finally(() => pending.delete(key)));
  return pending.get(key);
}
module.exports = { extract, thumbnail, dirsFor };
