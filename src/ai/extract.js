'use strict';
// Text out of the documents people send each other: PDFs, Word, Excel,
// PowerPoint, OpenDocument, and plain text. No vision model reads a PDF as a
// picture well, and posting a 3 MB file as base64 is a charged call that
// mostly fails — so the words are taken out here, on this PC, and only the
// words go to the model.
//
// PDF text comes from pdfjs (pure JavaScript, no worker). The Office formats
// are zip files of XML; a tiny reader here pulls the text runs out of the
// parts that carry them. Nothing is rendered, nothing is executed.
const zlib = require('zlib');

const MAX_CHARS = 9000;
const MAX_PDF_PAGES = 12;
const MAX_BYTES = 30 * 1024 * 1024;

const SUPPORTED = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv', 'md', 'json', 'rtf', 'html', 'htm', 'xml']);
const canRead = (ext) => SUPPORTED.has(String(ext || '').toLowerCase());

const clean = (s) => String(s || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/* ---------------- a minimal zip reader (store + deflate) ---------------- */
function zipEntries(buf) {
  // Walk back from the end to the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    out.set(name, { method, csize, offset });
    p += 46 + nlen + elen + clen;
  }
  return {
    names: () => [...out.keys()],
    read(name) {
      const e = out.get(name);
      if (!e) return null;
      const lh = e.offset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
      const nlen = buf.readUInt16LE(lh + 26), elen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nlen + elen;
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data);
      return null;
    },
  };
}

const decodeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

// Text runs of a WordprocessingML / DrawingML / ODF part, paragraphs kept.
function xmlText(xml, { para = /<\/(w:p|a:p|text:p|text:h|row)>/g, run = /<(?:w:t|a:t|text:p|text:h|text:span|t|v)(?:\s[^>]*)?>([^<]*)<\//g } = {}) {
  const withBreaks = String(xml).replace(para, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<text:line-break\/>/g, '\n');
  const parts = [];
  let m;
  while ((m = run.exec(withBreaks))) parts.push(decodeXml(m[1]));
  // Keep the paragraph breaks: a run that follows a newline in the source gets one.
  const lines = withBreaks.split('\n').map((line) => {
    const inner = [];
    let r; const re = new RegExp(run.source, 'g');
    while ((r = re.exec(line))) inner.push(decodeXml(r[1]));
    return inner.join('');
  }).filter((l) => l.trim());
  return lines.length ? lines.join('\n') : parts.join(' ');
}

function officeText(buf, ext) {
  const z = zipEntries(buf);
  const names = z.names();
  const read = (n) => { const d = z.read(n); return d ? d.toString('utf8') : ''; };
  if (ext === 'docx') return xmlText(read('word/document.xml'));
  if (ext === 'pptx') {
    return names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
      .map((n, i) => `[slide ${i + 1}]\n` + xmlText(read(n))).join('\n\n');
  }
  if (ext === 'xlsx') {
    const shared = [];
    const ss = read('xl/sharedStrings.xml');
    let m; const re = /<si>([\s\S]*?)<\/si>/g;
    while ((m = re.exec(ss))) shared.push(xmlText(m[1], { para: /$^/g, run: /<t(?:\s[^>]*)?>([^<]*)<\//g }).replace(/\n/g, ' '));
    const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    const out = [];
    for (const n of sheets) {
      const xml = read(n);
      const rows = [];
      const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
      let r;
      while ((r = rowRe.exec(xml))) {
        const cells = [];
        const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>/g;
        let c;
        while ((c = cellRe.exec(r[1]))) {
          const attrs = c[1], inner = c[2];
          const v = /<v>([^<]*)<\/v>/.exec(inner);
          const t = /<t(?:\s[^>]*)?>([^<]*)<\//.exec(inner);
          if (/t="s"/.test(attrs) && v) cells.push(shared[parseInt(v[1], 10)] || '');
          else if (t) cells.push(decodeXml(t[1]));
          else if (v) cells.push(decodeXml(v[1]));
        }
        if (cells.some((x) => x !== '')) rows.push(cells.join(' | '));
        if (rows.length > 300) break;
      }
      if (rows.length) out.push(`[${n.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, '')}]\n` + rows.join('\n'));
    }
    return out.join('\n\n');
  }
  if (ext === 'odt' || ext === 'ods' || ext === 'odp') return xmlText(read('content.xml'));
  return '';
}

// Loaded by file URL: inside Electron's engine process the ESM loader takes
// nothing else for an absolute path on Windows, and a bare name resolves
// from this file's own folder either way.
let pdfjsModule = null;
async function loadPdfjs() {
  if (!pdfjsModule) {
    const { pathToFileURL } = require('url');
    pdfjsModule = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  }
  return pdfjsModule;
}

async function pdfText(buf) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  const out = [];
  let chars = 0;
  for (let i = 1; i <= pages && chars < MAX_CHARS; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Items carry their own line breaks (hasEOL); join on those, space otherwise.
    let line = '';
    const lines = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; } else if (it.str && !/\s$/.test(it.str)) line += ' ';
    }
    if (line) lines.push(line);
    const text = lines.join('\n');
    chars += text.length;
    out.push(text);
    try { page.cleanup(); } catch (_) {}
  }
  const total = doc.numPages;
  try { await doc.destroy(); } catch (_) {}
  return { text: out.join('\n\n'), pages: total, read: pages };
}

const stripHtml = (s) => decodeXml(String(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' '));
const stripRtf = (s) => String(s).replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^{}]*\}/g, '').replace(/\\'[0-9a-f]{2}/g, '').replace(/\\[a-z]+-?\d* ?/g, '').replace(/[{}]/g, '');

// { text, pages?, note? } — text may be empty (a scanned PDF has none).
async function extractText(buf, ext) {
  ext = String(ext || '').toLowerCase();
  if (buf.length > MAX_BYTES) return { text: '', note: 'too large to read' };
  let text = '', pages;
  if (ext === 'pdf') { const r = await pdfText(buf); text = r.text; pages = r.pages; }
  else if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(ext)) text = officeText(buf, ext);
  else if (ext === 'html' || ext === 'htm') text = stripHtml(buf.toString('utf8'));
  else if (ext === 'rtf') text = stripRtf(buf.toString('latin1'));
  else if (['txt', 'csv', 'md', 'json', 'xml'].includes(ext)) text = buf.toString('utf8');
  else return { text: '', note: 'unsupported type' };
  text = clean(text);
  const truncated = text.length > MAX_CHARS;
  return { text: text.slice(0, MAX_CHARS), pages, truncated, note: text ? null : 'no readable text (a scan or a picture)' };
}

module.exports = { extractText, canRead, officeText, zipEntries, SUPPORTED, MAX_CHARS };
