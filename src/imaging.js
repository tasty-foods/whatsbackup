'use strict';
// Pictures and video frames for the engine, which has no decoder of its own.
//
// Two ways to get one: the Electron shell (Chromium's decoders, over the
// request channel in src/shell.js), and — when the engine runs on its own,
// from source or under test — the `sharp` module if it happens to be
// installed. Neither is required: every function answers null when it
// cannot help, and the callers carry on without.
//
// Also owns the thumbnail cache. A gallery of a thousand phone photos at full
// size is a thousand multi-megabyte decodes; a 400px JPEG each makes the grid
// instant, and a video gets a real first frame instead of a request to a
// cloud drive for its metadata.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shell = require('./shell');
const paths = require('./paths');

const THUMB_DIR = path.join(paths.APP_HOME, 'thumbs');
const THUMB_EDGE = 420;
const FRAME_EDGE = 768;

let sharp = null;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

const hasShell = () => shell.available();

// A JPEG no larger than `max` on its longest side, or null.
async function resize(bytes, max) {
  const r = await shell.request('shrink', { max, data: new Uint8Array(bytes) }, 15000);
  if (r && r.data) return Buffer.from(r.data);
  if (sharp) {
    try { return await sharp(bytes).rotate().resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(); }
    catch (_) { return null; }
  }
  return null;
}

// A few frames from a video, as JPEG buffers, or null when nothing can decode it.
async function videoFrames(file, { count = 3, max = FRAME_EDGE } = {}) {
  const r = await shell.request('frames', { file, count, max }, 45000);
  if (r && Array.isArray(r.frames) && r.frames.length) return r.frames.map((f) => Buffer.from(f));
  return null;
}

// A perceptual fingerprint (difference hash, 64 bits) plus the image size.
// Two pictures that differ only by a re-encode or a small edit sit a few bits
// apart; unrelated pictures sit around thirty apart.
async function fingerprint(bytes) {
  const r = await shell.request('fingerprint', { data: new Uint8Array(bytes) }, 15000);
  if (r && r.hash) return { hash: r.hash, width: r.width || 0, height: r.height || 0 };
  if (sharp) {
    try {
      const img = sharp(bytes).rotate();
      const meta = await img.metadata();
      const { data } = await img.grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
      return { hash: dhashFromGray(data, 9, 8), width: meta.width || 0, height: meta.height || 0 };
    } catch (_) { return null; }
  }
  return null;
}

// Shared with the shell, which computes the same thing from Chromium's bitmap.
function dhashFromGray(gray, w, h) {
  let bits = '';
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) bits += gray[y * w + x] > gray[y * w + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/* ---------------- thumbnails ---------------- */
const thumbPath = (id) => path.join(THUMB_DIR, crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 24) + '.jpg');
const inflight = new Map();

// The cached thumbnail's path, made on first request. Images are resized;
// videos get their first usable frame. Null when it cannot be made, in which
// case the caller serves the original.
async function thumbnail(rec, file) {
  if (!rec || !file) return null;
  const out = thumbPath(rec.id);
  try { if (fs.existsSync(out)) return out; } catch (_) {}
  if (inflight.has(rec.id)) return inflight.get(rec.id);
  const job = (async () => {
    try {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      let jpeg = null;
      if (rec.kind === 'video') {
        const frames = await videoFrames(file, { count: 1, max: THUMB_EDGE });
        jpeg = frames && frames[0];
      } else if (rec.kind === 'image' || rec.kind === 'sticker') {
        const bytes = fs.readFileSync(file);
        jpeg = await resize(bytes, THUMB_EDGE);
        // Nothing to shrink (a small picture already) — serve the original.
        if (!jpeg && bytes.length < 120 * 1024) return null;
      }
      if (!jpeg) return null;
      const tmp = out + '.part';
      fs.writeFileSync(tmp, jpeg);
      fs.renameSync(tmp, out);
      return out;
    } catch (_) { return null; }
    finally { inflight.delete(rec.id); }
  })();
  inflight.set(rec.id, job);
  return job;
}

function dropThumbnail(id) { try { fs.rmSync(thumbPath(id), { force: true }); } catch (_) {} }

module.exports = { resize, videoFrames, fingerprint, dhashFromGray, hammingHex, thumbnail, dropThumbnail, hasShell, THUMB_DIR, hasSharp: () => !!sharp };
