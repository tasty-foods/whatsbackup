'use strict';
// Gemini as a source, linked the way ChatGPT is.
//
// Google offers no API for a person's own Gemini pictures either. The web app
// keeps them under /library, drawn from an obfuscated RPC (batchexecute,
// rpcid jGArJ on 2026-09-09) that is built to change without notice — so this
// does not speak it. It reads what a person sees: the library page, scrolled
// until it stops growing, and the picture URLs on it. Those are stable
// lh3.googleusercontent.com/gg/<token> addresses, the token being the same
// across every size, so it is the id. Bytes are pulled by opening the
// full-size URL in the signed-in browser — a page-context fetch is refused by
// CORS, a navigation is not.
//
// The library page carries no titles or dates. Every picture lands under one
// chat called Gemini, dated the day it was first seen, so it sorts and
// searches like everything else; the labeller writes the caption.
const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const cfg = require('../config');
const settings = require('../settings');
const store = require('../store');
const history = require('../source-history');

const PROFILE_DIR = paths.GEMINI_DIR;
const ORIGIN = 'https://gemini.google.com';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PAGE_TIMEOUT_MS = 60 * 1000;
const NAV_RETRIES = 2;
const SCROLL_SETTLE_ROUNDS = 3;        // this many scrolls with nothing new means the end
const MAX_SCROLLS = 80;

const state = {
  status: 'off',            // off | unlinked | linked | connecting | scanning | error
  linked: false,
  busy: false,
  lastScanAt: null,
  lastError: null,
  lastRun: null,
  nextScanAt: null,
  progress: null,
};
let timer = null;
let browser = null;

const log = (...a) => console.log('[gemini]', ...a);
const MARKER = () => path.join(PROFILE_DIR, 'linked.json');
// A profile folder exists the moment the window opens, signed in or not.
// Only a session check that came back positive writes the marker, and a
// session check that comes back negative removes it — so linked means what
// the card says it means.
const hasProfile = () => { try { return fs.existsSync(MARKER()); } catch (_) { return false; } };
const markLinked = (on) => { try { if (on) { fs.mkdirSync(PROFILE_DIR, { recursive: true }); fs.writeFileSync(MARKER(), JSON.stringify({ at: Date.now() })); } else fs.rmSync(MARKER(), { force: true }); } catch (_) {} };

async function launch({ headed = false } = {}) {
  const puppeteer = require('puppeteer');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // Google's sign-in refuses a browser that announces itself as automated.
  // These are the two flags that announcement rides on.
  const args = ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'];
  if (process.env.WB_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  const opts = {
    headless: !headed, args, userDataDir: PROFILE_DIR,
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: headed ? null : { width: 1280, height: 900 },
    protocolTimeout: 15 * 60 * 1000,
  };
  if (cfg.CHROME_PATH) opts.executablePath = cfg.CHROME_PATH;
  browser = await puppeteer.launch(opts);
  return browser;
}

async function closeBrowser() {
  const b = browser; browser = null;
  if (b) { try { await b.close(); } catch (_) {} }
}

async function openPage(b, pathname) {
  const page = await b.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try { const ua = await b.userAgent(); if (/HeadlessChrome/.test(ua)) await page.setUserAgent(ua.replace('HeadlessChrome', 'Chrome')); } catch (_) {}
  for (let i = 0; i <= NAV_RETRIES; i++) {
    try { await page.goto(ORIGIN + pathname, { waitUntil: 'domcontentloaded' }); return page; }
    catch (e) { if (i === NAV_RETRIES) throw e; }
  }
  return page;
}

// Signed in looks like the account button being there and the address not
// being Google's sign-in. Checked in the page, where a navigation in progress
// can throw — that is "not yet", not "no".
async function signedIn(page) {
  try {
    if (/accounts\.google\.com/.test(page.url())) return false;
    return await page.evaluate(() => !!document.querySelector('a[aria-label^="Google Account"], img[alt^="Google Account"]'));
  } catch (_) { return false; }
}

/* ---------------- linking ---------------- */

async function connect() {
  if (state.busy) return { ok: false, error: 'already busy' };
  state.busy = true; state.status = 'connecting'; state.lastError = null;
  try {
    const b = await launch({ headed: true });
    const page = await openPage(b, '/app');
    const until = Date.now() + LOGIN_TIMEOUT_MS;
    let ok = false;
    while (Date.now() < until && !ok) {
      if (page.isClosed()) break;
      ok = await signedIn(page);
      if (!ok) await new Promise((r) => setTimeout(r, 2500));
    }
    if (!ok) throw new Error(page.isClosed() ? 'the window was closed before signing in' : 'no sign-in within ten minutes');
    markLinked(true);
    state.linked = true; state.status = 'linked';
    log('linked');
    return { ok: true };
  } catch (e) {
    markLinked(false);
    state.linked = false;
    state.status = state.linked ? 'linked' : 'unlinked';
    state.lastError = e.message;
    return { ok: false, error: e.message };
  } finally {
    await closeBrowser();
    state.busy = false;
    schedule();
  }
}

async function disconnect() {
  await closeBrowser();
  clearTimeout(timer); timer = null;
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
  state.linked = false; state.status = 'unlinked'; state.nextScanAt = null;
  return { ok: true };
}

async function checkLink() {
  if (!hasProfile()) { state.linked = false; state.status = 'unlinked'; return false; }
  if (state.busy) return state.linked;
  state.busy = true;
  try {
    const b = await launch();
    const page = await openPage(b, '/app');
    await new Promise((r) => setTimeout(r, 3000));
    const ok = await signedIn(page);
    state.linked = ok; markLinked(ok); state.status = ok ? 'linked' : 'unlinked';
    if (!ok) state.lastError = 'signed out — connect again';
    return ok;
  } catch (e) {
    state.lastError = e.message; state.status = 'error';
    return false;
  } finally { await closeBrowser(); state.busy = false; }
}

/* ---------------- the scan ---------------- */

// Scroll the library until it stops growing, then hand back every generated
// picture's base address. The size suffix is dropped so one picture has one
// address whatever size the page happened to draw it at.
async function listLibrary(page) {
  let last = -1, settled = 0;
  for (let i = 0; i < MAX_SCROLLS && settled < SCROLL_SETTLE_ROUNDS; i++) {
    const n = await page.evaluate(() => {
      const els = document.querySelectorAll('img[src*="lh3.googleusercontent.com/gg/"]');
      const sc = document.scrollingElement || document.body;
      sc.scrollTop = sc.scrollHeight;
      for (const m of document.querySelectorAll('main, [role="main"]')) { try { m.scrollTop = m.scrollHeight; } catch (_) {} }
      if (els.length) { try { els[els.length - 1].scrollIntoView({ block: 'end' }); } catch (_) {} }
      return els.length;
    });
    settled = n === last ? settled + 1 : 0;
    last = n;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const img of document.querySelectorAll('img[src*="lh3.googleusercontent.com/gg/"]')) {
      const src = img.currentSrc || img.src;
      const base = src.replace(/=[^=]*$/, '');
      const token = base.split('/gg/')[1];
      if (!token || seen.has(token)) continue;
      seen.add(token);
      out.push({ token, base });
    }
    return out;
  });
}

// Open the full-size address in its own tab and take the bytes. Tried at
// original size first; if a size is refused, the next is a reasonable
// picture rather than nothing.
async function fetchImage(b, base) {
  const page = await b.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try { const ua = await b.userAgent(); if (/HeadlessChrome/.test(ua)) await page.setUserAgent(ua.replace('HeadlessChrome', 'Chrome')); } catch (_) {}
  try {
    for (const suffix of ['=s0', '=d', '=w2048-h2048', '']) {
      let res;
      try { res = await page.goto(base + suffix, { waitUntil: 'load' }); } catch (_) { continue; }
      if (!res || !res.ok()) continue;
      const type = String(res.headers()['content-type'] || '');
      if (!type.startsWith('image/')) continue;
      const buf = await res.buffer();
      if (!buf || !buf.length) continue;
      const lm = res.headers()['last-modified'];
      return { bytes: buf, mime: type.split(';')[0], modified: lm ? Date.parse(lm) : null };
    }
    return null;
  } finally { try { await page.close(); } catch (_) {} }
}

const stamp = (ms) => {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const extFor = (mime) => {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
};

async function scan({ reason = 'manual' } = {}) {
  if (state.busy) return { ok: false, error: 'already busy' };
  if (!hasProfile()) { state.status = 'unlinked'; return { ok: false, error: 'not connected' }; }
  state.busy = true; state.status = 'scanning'; state.lastError = null;
  const run = { conversations: 0, images: 0, saved: 0, skipped: 0, failed: 0, at: Date.now(), reason };
  try {
    const b = await launch();
    const page = await openPage(b, '/library');
    await new Promise((r) => setTimeout(r, 3500));
    if (!(await signedIn(page))) { markLinked(false); state.linked = false; throw new Error('signed out — connect again'); }
    state.linked = true;

    const items = await listLibrary(page);
    run.images = items.length;
    state.progress = { images: run.images, saved: 0 };

    fs.mkdirSync(cfg.IMAGES_DIR, { recursive: true });
    for (const it of items) {
      const id = 'gemini_' + it.token;
      if (store.has(id)) { run.skipped++; continue; }
      let got = null;
      try { got = await fetchImage(b, it.base); } catch (_) {}
      if (!got) { run.failed++; continue; }
      const ts = got.modified && Number.isFinite(got.modified) ? got.modified : Date.now();
      const ext = extFor(got.mime);
      const filename = `${stamp(ts)}__gemini__Gemini__${it.token.slice(-10)}.${ext}`;
      try { fs.writeFileSync(path.join(cfg.IMAGES_DIR, filename), got.bytes); }
      catch (e) { run.failed++; continue; }
      const rec = {
        id, ts,
        dir: 'in',                     // Gemini made it; nothing here was sent
        kind: 'image',
        source: 'gemini',
        chat: 'Gemini',
        number: '',
        mimetype: got.mime || 'image/png',
        filename,
        serve: '/media/images/' + encodeURIComponent(filename),
        size: got.bytes.length,
        caption: '',
        generated: true,
        cloud: false,
      };
      if (store.addRecord(rec)) {
        run.saved++;
        if (state.progress) state.progress.saved = run.saved;
        try { require('../ai').noteNewMedia(rec); } catch (_) {}
      }
    }
    state.lastScanAt = Date.now();
    state.lastRun = run;
    history.write('gemini', run);
    state.status = 'linked';
    if (run.saved) { try { require('../backup').nudge(); } catch (_) {} }
    log(`scan (${reason}): ${run.images} pictures in the library, ${run.saved} new, ${run.skipped} already had, ${run.failed} failed`);
    return { ok: true, ...run };
  } catch (e) {
    state.lastError = e.message;
    state.status = state.linked ? 'error' : 'unlinked';
    log('scan failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    await closeBrowser();
    state.busy = false; state.progress = null;
    schedule();
  }
}

/* ---------------- schedule ---------------- */

function schedule() {
  clearTimeout(timer); timer = null;
  const s = settings.read();
  if (!s.geminiEnabled || !hasProfile()) { state.nextScanAt = null; return; }
  const hours = Math.max(1, Math.min(168, parseInt(s.geminiScanHours, 10) || 6));
  const delay = hours * 3600 * 1000;
  state.nextScanAt = Date.now() + delay;
  timer = setTimeout(() => { scan({ reason: 'scheduled' }); }, delay);
  if (timer.unref) timer.unref();
}

function init() {
  const s = settings.read();
  state.lastRun = history.read('gemini');
  state.lastScanAt = state.lastRun ? state.lastRun.at : null;
  state.linked = hasProfile();
  state.status = state.linked ? 'linked' : (s.geminiEnabled ? 'unlinked' : 'off');
  if (!s.geminiEnabled) return;
  if (state.linked) {
    // Two minutes after start, so the phone link and ChatGPT's first look
    // are not all opening browsers at once.
    const t = setTimeout(() => { scan({ reason: 'startup' }); }, 120 * 1000);
    if (t.unref) t.unref();
  }
  schedule();
}

const getState = () => ({ ...state, enabled: !!settings.read().geminiEnabled, scanHours: settings.read().geminiScanHours || 6 });

module.exports = { init, connect, disconnect, checkLink, scan, schedule, getState };
