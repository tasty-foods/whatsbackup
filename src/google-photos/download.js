'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = {
  jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], png: ['image', 'image/png'],
  gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], avif: ['image', 'image/avif'],
  heic: ['image', 'image/heic'], heif: ['image', 'image/heif'], tif: ['image', 'image/tiff'],
  tiff: ['image', 'image/tiff'], bmp: ['image', 'image/bmp'], dng: ['image', 'image/x-adobe-dng'],
  mp4: ['video', 'video/mp4'], mov: ['video', 'video/quicktime'], m4v: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'], avi: ['video', 'video/x-msvideo'], mkv: ['video', 'video/x-matroska'],
  '3gp': ['video', 'video/3gpp'], mpg: ['video', 'video/mpeg'], mpeg: ['video', 'video/mpeg'],
  mts: ['video', 'video/mp2t'], m2ts: ['video', 'video/mp2t'],
};

function mediaType(filename) {
  const ext = path.extname(String(filename)).slice(1).toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new Error('Google Photos returned an unsupported download type: ' + (ext || 'no extension'));
  return { ext, kind: type[0], mime: type[1] };
}

async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, signal ? { signal } : undefined)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}

async function triggerDownload(page) {
  const selector = 'button[aria-label="More options"], [role="button"][aria-label="More options"], button[aria-label="More"]';
  const more = await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  await more.click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')]
    .some(el => /^download\b/i.test(el.textContent.trim())), { timeout: 10000 });
  await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')]
    .find(el => /^download\b/i.test(el.textContent.trim())).click());
}

// Download the file offered by Photos, never a grid thumbnail. Chrome writes
// GUID filenames into our staging directory; Google's filename is metadata only.
async function createDownloader(browser, directory, timeoutMs) {
  fs.mkdirSync(directory, { recursive: true });
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: directory, eventsEnabled: true });
  let active = null;
  return {
    async download(page, signal) {
      signal?.throwIfAborted();
      if (active) throw new Error('A Google Photos download is already running');
      let guid = '', filename = '', timer;
      const pending = new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          session.off('Browser.downloadWillBegin', begin);
          session.off('Browser.downloadProgress', progress);
          signal?.removeEventListener('abort', abort);
          active = null;
        };
        const finish = (error, result) => { cleanup(); error ? reject(error) : resolve(result); };
        const abort = () => finish(signal.reason || new Error('Import stopped'));
        const begin = event => {
          if (guid) return;
          if (!/^[A-Za-z0-9-]+$/.test(event.guid)) return finish(new Error('Invalid Google Photos download id'));
          guid = event.guid; filename = event.suggestedFilename;
        };
        const progress = event => {
          if (!guid || event.guid !== guid) return;
          if (event.state === 'canceled') finish(new Error('Google Photos canceled the download'));
          else if (event.state === 'completed') finish(null, { file: path.join(directory, guid), filename });
        };
        active = error => finish(error);
        session.on('Browser.downloadWillBegin', begin);
        session.on('Browser.downloadProgress', progress);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(new Error('Google Photos download timed out; increase the download timeout in Settings or retry.')), timeoutMs);
      });
      pending.catch(() => {}); // A timeout can precede the menu action finishing.
      try {
        await triggerDownload(page);
        const result = await pending;
        if (!(await fs.promises.stat(result.file)).size) throw new Error('Google Photos returned an empty download');
        // Reject a login/error page or ZIP instead of indexing it as a photo.
        const handle = await fs.promises.open(result.file, 'r');
        try {
          const buffer = Buffer.alloc(256);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (/^\s*(?:<!doctype|<html)/i.test(buffer.subarray(0, bytesRead).toString()) || buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
            throw new Error('Google Photos returned a web page or ZIP rather than a single photo or video');
          }
        } finally { await handle.close(); }
        return { ...result, ...mediaType(result.filename) };
      } catch (error) {
        if (active) active(error);
        if (guid) { try { await session.send('Browser.cancelDownload', { guid }); } catch (_) {} }
        throw error;
      }
    },
    async close() {
      if (active) active(new Error('Import stopped'));
      try { await session.detach(); } catch (_) {}
    },
  };
}

module.exports = { mediaType, hashFile, triggerDownload, createDownloader };
