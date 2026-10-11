'use strict';
// Decoding, PDF parsing and cloud reads stay off the capture engine's event loop.
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
sharp.concurrency(1);
sharp.cache({ memory: 24, files: 0, items: 30 });
const LIMIT = 200000;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const image = async (bytes, edge = 1280) => ({ mediaType: 'image/jpeg', data: (await sharp(bytes, { limitInputPixels: 80000000 }).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()).toString('base64') });
const xmlText = s => s.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function ffmpeg(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(require('ffmpeg-static'), ['-hide_banner', '-nostdin', ...args], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      // Probing with ffmpeg -i intentionally exits 1, with duration on stderr.
      if (error) return reject(Object.assign(new Error(error.killed ? 'Video reading timed out. Check that the file is available offline.' : 'This video could not be decoded.'), { detail: String(stderr).slice(-400) }));
      resolve({ stdout, stderr: String(stderr) });
    });
  });
}
async function duration(file) {
  return new Promise((resolve, reject) => {
    execFile(require('ffmpeg-static'), ['-hide_banner', '-nostdin', '-i', file], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return reject(new Error('Cannot read video duration. Make the file available offline and retry.'));
      resolve(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
  });
}
async function resolveFile(dirs, filename) {
  if (!filename || path.basename(filename) !== filename) throw new Error('Invalid file name.');
  for (const dir of [...new Set(dirs)]) {
    const file = path.join(dir, filename);
    try { if ((await fs.stat(file)).isFile()) return file; } catch (_) {}
  }
  throw new Error('File is missing or its drive is disconnected.');
}
async function extract(task) {
  const file = await resolveFile(task.dirs, task.filename);
  const stat = await fs.stat(file);
  if (task.kind === 'video') {
    const seconds = await duration(file);
    const count = Math.min(task.frames || 6, Math.max(1, Math.ceil(seconds / 2)));
    const frames = [];
    for (let i = 0; i < count; i++) {
      const at = Math.max(0, Math.min(seconds - .15, count === 1 ? 0 : .2 + (seconds - .4) * i / (count - 1)));
      const r = await ffmpeg(['-threads', '1', '-ss', String(at), '-i', file, '-frames:v', '1', '-an', '-vf', 'scale=960:960:force_original_aspect_ratio=decrease', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
      frames.push({ seconds: Math.round(at * 10) / 10, mediaType: 'image/jpeg', data: r.stdout.toString('base64') });
      if (i === 0 && task.poster) { await fs.mkdir(path.dirname(task.poster), { recursive: true }); await fs.writeFile(task.poster, await sharp(r.stdout).resize({ width: 440, height: 440, fit: 'inside' }).jpeg({ quality: 72 }).toBuffer()); }
    }
    return { hash: hash(`${stat.size}:${stat.mtimeMs}:${count}`), duration: seconds, frames };
  }
  const ext = path.extname(task.docName || file).toLowerCase();
  const isPdf = ext === '.pdf' || task.mimetype === 'application/pdf';
  const sizeLimitMB = isPdf ? 200 : 50;
  if (stat.size > sizeLimitMB * 1024 * 1024) throw new Error(`File exceeds the ${sizeLimitMB} MB indexing limit.`);
  const bytes = await fs.readFile(file);
  if (task.kind === 'image') return { hash: hash(bytes), image: await image(bytes) };
  const chunks = [], scans = [];
  let truncated = false, totalPages = null;
  if (/^image\//.test(task.mimetype || '') || ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif'].includes(ext)) {
    chunks.push({ page: 1, text: '' }); totalPages = 1;
    if ((task.ocrPages ?? 4) > 0) scans.push({ page: 1, documentImage: true, ...await image(bytes, 1500) });
  } else if (isPdf) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const root = path.dirname(require.resolve('pdfjs-dist/package.json')) + path.sep;
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, cMapUrl: root + 'cmaps/', cMapPacked: true, standardFontDataUrl: root + 'standard_fonts/', verbosity: 0 });
    const pdf = await loading.promise;
    try {
      totalPages = pdf.numPages;
      const max = Math.min(pdf.numPages, task.pages || 30);
      let chars = 0;
      for (let n = 1; n <= max && chars < LIMIT; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').slice(0, LIMIT - chars);
        chunks.push({ page: n, text }); chars += text.length;
        if (text.trim().length < 60 && scans.length < (task.ocrPages ?? 4)) {
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 1500 / Math.max(base.width, base.height)) });
          const canvas = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          try {
            await page.render({ canvasContext: canvas.context, viewport }).promise;
            scans.push({ page: n, ...await image(canvas.canvas.toBuffer('image/png'), 1500) });
          } finally { pdf.canvasFactory.destroy(canvas); }
        }
        page.cleanup();
      }
      truncated = max < pdf.numPages || chars >= LIMIT;
    } finally { await loading.destroy(); }
  } else if (['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'].includes(ext)) {
    // Unzip only document XML; never execute macros, scripts, links or embedded files.
    const { unzipSync, strFromU8 } = require('fflate');
    let expanded = 0;
    const parts = unzipSync(bytes, { filter: entry => {
      const wanted = /^(word\/(document|header\d+|footer\d+)|xl\/(sharedStrings|worksheets\/sheet\d+)|ppt\/slides\/slide\d+|content)\.xml$/.test(entry.name);
      if (!wanted) return false;
      expanded += entry.originalSize;
      if (expanded > 30 * 1024 * 1024) throw new Error('Document is too large to unpack safely.');
      return true;
    } });
    if (ext === '.xlsx') {
      const shared = strFromU8(parts['xl/sharedStrings.xml'] || new Uint8Array()).match(/<si\b[^>]*>[\s\S]*?<\/si>/g)?.map(xmlText) || [];
      let total = 0;
      for (const [name, data] of Object.entries(parts).filter(([name]) => /xl\/worksheets\//.test(name)).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
        const rows = strFromU8(data).match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
        const text = rows.map(row => (row.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) || []).map(cell => {
          const value = cell.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] || '';
          return /\bt=["']s["']/.test(cell) ? shared[Number(value)] || '' : /\bt=["']inlineStr["']/.test(cell) ? xmlText(cell) : xmlText(value);
        }).join(' | ')).join('\n').slice(0, LIMIT - total);
        chunks.push({ section: 'Sheet ' + name.match(/sheet(\d+)/)[1], text }); total += text.length;
        if (total >= LIMIT) { truncated = true; break; }
      }
      return { hash: hash(bytes), chunks, scans, truncated, totalPages };
    }
    let length = 0;
    for (const [name, data] of Object.entries(parts).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
      if (length >= LIMIT) { truncated = true; break; }
      const text = xmlText(strFromU8(data)).slice(0, LIMIT - length);
      chunks.push({ section: name.includes('slide') ? 'Slide ' + name.match(/slide(\d+)/)[1] : name.includes('sheet') ? 'Sheet ' + name.match(/sheet(\d+)/)[1] : 'Document', text }); length += text.length;
    }
  } else if (['.txt', '.csv', '.tsv', '.md', '.json', '.xml', '.html', '.htm', '.log', '.rtf'].includes(ext) || /^text\//.test(task.mimetype || '')) {
    let text = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8');
    if (['.html', '.htm', '.xml'].includes(ext)) text = xmlText(text.replace(/<script[\s\S]*?<\/script>/gi, ''));
    if (ext === '.rtf') text = text.replace(/\\[a-z]+-?\d* ?|[{}]/gi, ' ');
    truncated = text.length > LIMIT;
    chunks.push({ text: text.slice(0, LIMIT) });
  } else throw new Error('Unsupported document format. Use PDF, DOCX, XLSX, PPTX, OpenDocument or a text file.');
  return { hash: hash(bytes), chunks, scans, truncated, totalPages };
}

parentPort.on('message', async task => {
  try {
    let result;
    if (task.action === 'thumbnail') {
      const file = await resolveFile(task.dirs, task.filename);
      const bytes = await sharp(file, { limitInputPixels: 80000000 }).rotate().resize({ width: 440, height: 440, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
      await fs.mkdir(path.dirname(task.destination), { recursive: true });
      await fs.writeFile(task.destination, bytes);
      result = task.destination;
    } else result = await extract(task);
    parentPort.postMessage({ id: task.id, result });
  } catch (e) { parentPort.postMessage({ id: task.id, error: e.message }); }
});
