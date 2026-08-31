'use strict';
// Text statuses, rendered by us. The library exposes no font or background
// options for native text statuses, and WhatsApp's own palette is six flat
// colours — so instead of accepting that ceiling, text is set on a 1080×1920
// card in the Chromium this app already ships and posted as an image. Full
// typographic control, no new dependency, and the same card is the history
// thumbnail, so what you see later is exactly what went out.
//
// The same hidden browser answers "how long is this video" — a <video> tag
// reads the metadata, which spares us shipping ffmpeg for one number.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const wa = require('../whatsapp');

const STATUS_DIR = path.join(cfg.DATA_DIR, 'status');

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Long text shrinks rather than overflows: the font size is a clamp on the
// text length, tuned so a five-word punch fills the frame and a paragraph
// still fits with air around it.
const sizeFor = (text) => {
  const n = String(text || '').length;
  if (n <= 40) return 110;
  if (n <= 90) return 88;
  if (n <= 180) return 68;
  if (n <= 320) return 54;
  return 44;
};

const BASE = (inner, bg, fg) => `<!doctype html><meta charset="utf-8"><style>
  * { margin:0; box-sizing:border-box; }
  html,body { width:1080px; height:1920px; }
  body { display:flex; align-items:center; justify-content:center; padding:110px 90px;
    font-family:"Segoe UI", -apple-system, Roboto, sans-serif; background:${bg}; color:${fg};
    text-align:center; overflow:hidden; }
  .txt { font-weight:700; line-height:1.22; letter-spacing:-.01em; white-space:pre-wrap; word-wrap:break-word; max-width:100%; }
  .foot { position:fixed; left:0; right:0; bottom:70px; font-size:30px; font-weight:600; opacity:.65; letter-spacing:.12em; text-transform:uppercase; }
</style><body>${inner}</body>`;

const TEMPLATES = {
  // The default: deep green-to-teal, white text — at home next to WhatsApp
  // without pretending to be it.
  gradient: (text, foot) => BASE(
    `<div class="txt" style="font-size:${sizeFor(text)}px; text-shadow:0 4px 30px rgba(0,0,0,.25)">${esc(text)}</div>${foot ? `<div class="foot">${esc(foot)}</div>` : ''}`,
    'linear-gradient(160deg,#075e54 0%,#128c7e 55%,#1fa855 100%)', '#ffffff'),

  night: (text, foot) => BASE(
    `<div class="txt" style="font-size:${sizeFor(text)}px">${esc(text)}</div>${foot ? `<div class="foot" style="color:#25d366">${esc(foot)}</div>` : ''}`,
    'radial-gradient(120% 120% at 30% 20%, #1b242e 0%, #0b0f14 70%)', '#e7edf3'),

  paper: (text, foot) => BASE(
    `<div class="txt" style="font-size:${sizeFor(text)}px; font-family:Georgia, 'Times New Roman', serif; font-weight:600">${esc(text)}</div>${foot ? `<div class="foot" style="color:#8a6f5e">${esc(foot)}</div>` : ''}`,
    'linear-gradient(180deg,#f7f3e9 0%, #efe7d6 100%)', '#2b2418'),

  bold: (text, foot) => BASE(
    `<div class="txt" style="font-size:${Math.round(sizeFor(text) * 1.05)}px; text-transform:uppercase; letter-spacing:.02em">${esc(text)}</div>${foot ? `<div class="foot" style="color:#ffd9cf">${esc(foot)}</div>` : ''}`,
    'linear-gradient(150deg,#c8452a 0%, #8f2f1c 100%)', '#fff6f3'),
};
const TEMPLATE_NAMES = Object.keys(TEMPLATES);

async function withPage(fn) {
  const browser = wa.getBrowser();
  if (!browser) throw new Error('The WhatsApp browser is not running yet.');
  const page = await browser.newPage();
  try { return await fn(page); }
  finally { try { await page.close(); } catch (_) {} }
}

// Renders one card and returns its file path (kept under data/status — these
// double as the history thumbnails).
async function renderCard(text, template, foot) {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  const tpl = TEMPLATES[template] || TEMPLATES.gradient;
  const file = path.join(STATUS_DIR, `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
  await withPage(async (page) => {
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    await page.setContent(tpl(text, foot), { waitUntil: 'load' });
    await page.screenshot({ type: 'jpeg', quality: 90, path: file });
  });
  return file;
}

// Duration and dimensions, read the way a browser reads them.
async function probeVideo(filePath) {
  return withPage(async (page) => {
    const url = 'file:///' + filePath.replace(/\\/g, '/');
    await page.setContent('<video id="v" preload="metadata"></video>');
    return page.evaluate((src) => new Promise((resolve) => {
      const v = document.getElementById('v');
      const done = (ok) => resolve(ok
        ? { ok: true, duration: v.duration, width: v.videoWidth, height: v.videoHeight }
        : { ok: false });
      v.onloadedmetadata = () => done(true);
      v.onerror = () => done(false);
      setTimeout(() => done(false), 15000);
      v.src = src;
    }), url);
  });
}

// A copy for the history thumbnail, so the log survives the original being
// consumed from a folder or deleted. Big videos are referenced, not copied.
function keepForHistory(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > 30 * 1024 * 1024) return null;
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const name = `hist-${Date.now()}-${path.basename(filePath).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    fs.copyFileSync(filePath, path.join(STATUS_DIR, name));
    return name;
  } catch (_) { return null; }
}

module.exports = { renderCard, probeVideo, keepForHistory, TEMPLATE_NAMES, STATUS_DIR };
