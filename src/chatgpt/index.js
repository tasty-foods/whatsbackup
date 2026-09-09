'use strict';
// A second source, linked the way the first one is.
//
// OpenAI offers no API for a person's own ChatGPT history — the API is for
// building products, not reading chatgpt.com. What the web app itself uses is
// a small JSON backend behind the login cookie, so the only way to keep a copy
// of your images is the way WhatsApp is kept here: a browser profile of its
// own, signed in once by the user, and read from on a schedule. Verified on
// 2026-09-09 against a live account: /api/auth/session hands over a bearer
// token, /backend-api/conversations pages the list, /backend-api/conversation
// /{id} carries a `mapping` whose image parts point at `sediment://file-…`, and
// /backend-api/files/{id}/download answers with a signed download_url.
//
// The profile is separate from WhatsApp's so a problem here cannot unlink the
// phone. The browser is opened for the job and closed after it, not kept
// alive; a logged-in profile on disk is what survives between runs.
const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const cfg = require('../config');
const settings = require('../settings');
const store = require('../store');

const PROFILE_DIR = paths.CHATGPT_DIR;
const ORIGIN = 'https://chatgpt.com';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;    // a person typing a password, maybe a 2FA code
const PAGE_TIMEOUT_MS = 60 * 1000;
const NAV_RETRIES = 2;

const state = {
  status: 'off',            // off | unlinked | linked | connecting | scanning | error
  linked: false,
  busy: false,
  lastScanAt: null,
  lastError: null,
  lastRun: null,            // { conversations, images, saved, skipped, failed, at, reason }
  nextScanAt: null,
};
let timer = null;
let browser = null;

const log = (...a) => console.log('[chatgpt]', ...a);
const hasProfile = () => { try { return fs.existsSync(path.join(PROFILE_DIR, 'Default')); } catch (_) { return false; } };

async function launch({ headed = false } = {}) {
  const puppeteer = require('puppeteer');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = ['--disable-gpu', '--no-first-run', '--no-default-browser-check'];
  if (process.env.WB_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  const opts = { headless: !headed, args, userDataDir: PROFILE_DIR, defaultViewport: headed ? null : { width: 1280, height: 900 } };
  if (cfg.CHROME_PATH) opts.executablePath = cfg.CHROME_PATH;
  browser = await puppeteer.launch(opts);
  return browser;
}

async function closeBrowser() {
  const b = browser; browser = null;
  if (b) { try { await b.close(); } catch (_) {} }
}

async function openPage(b) {
  const page = await b.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  for (let i = 0; i <= NAV_RETRIES; i++) {
    try { await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' }); return page; }
    catch (e) { if (i === NAV_RETRIES) throw e; }
  }
  return page;
}

// Runs inside the page, where the login cookie is. Returns a bearer token or
// null. Never logged, never sent anywhere but chatgpt.com's own endpoints.
async function sessionToken(page) {
  try {
    return await page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (!r.ok) return null;
        const j = await r.json();
        return j && j.accessToken ? j.accessToken : null;
      } catch (e) { return null; }
    });
  } catch (_) { return null; }
}

/* ---------------- linking ---------------- */

// Opens a real window on chatgpt.com and waits for the person to sign in.
// Nothing is typed by us: the credentials are theirs to enter.
async function connect() {
  if (state.busy) return { ok: false, error: 'already busy' };
  state.busy = true; state.status = 'connecting'; state.lastError = null;
  try {
    const b = await launch({ headed: true });
    const page = await openPage(b);
    const until = Date.now() + LOGIN_TIMEOUT_MS;
    let token = null;
    while (Date.now() < until && !token) {
      if (page.isClosed()) break;
      token = await sessionToken(page);
      if (!token) await new Promise((r) => setTimeout(r, 2500));
    }
    if (!token) throw new Error(page.isClosed() ? 'the window was closed before signing in' : 'no sign-in within ten minutes');
    state.linked = true; state.status = 'linked';
    log('linked');
    return { ok: true };
  } catch (e) {
    state.linked = hasProfile() && state.linked;
    state.status = state.linked ? 'linked' : 'unlinked';
    state.lastError = e.message;
    return { ok: false, error: e.message };
  } finally {
    await closeBrowser();
    state.busy = false;
    schedule();
  }
}

// Forgetting the account is deleting the profile it lives in.
async function disconnect() {
  await closeBrowser();
  clearTimeout(timer); timer = null;
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
  state.linked = false; state.status = 'unlinked'; state.nextScanAt = null;
  return { ok: true };
}

// A cheap look at whether the saved profile still signs in.
async function checkLink() {
  if (!hasProfile()) { state.linked = false; state.status = 'unlinked'; return false; }
  if (state.busy) return state.linked;
  state.busy = true;
  try {
    const b = await launch();
    const page = await openPage(b);
    const token = await sessionToken(page);
    state.linked = !!token;
    state.status = token ? 'linked' : 'unlinked';
    if (!token) state.lastError = 'signed out — connect again';
    return state.linked;
  } catch (e) {
    state.lastError = e.message; state.status = 'error';
    return false;
  } finally { await closeBrowser(); state.busy = false; }
}

/* ---------------- the scan ---------------- */

// Everything that touches the backend runs in the page, so the cookie and the
// signed URLs are used where they are valid. What comes back to Node is a
// list of image parts with their conversation, and, one at a time, bytes.
async function listImages(page, token) {
  return page.evaluate(async (tok) => {
    const h = { Authorization: 'Bearer ' + tok };
    const out = { conversations: 0, parts: [] };
    const seenFiles = new Set();
    let offset = 0, total = Infinity;
    while (offset < total) {
      const r = await fetch('/backend-api/conversations?offset=' + offset + '&limit=50&order=updated', { headers: h, credentials: 'include' });
      if (!r.ok) throw new Error('conversations ' + r.status);
      const j = await r.json();
      total = j.total || 0;
      const items = j.items || [];
      if (!items.length) break;
      for (const it of items) {
        out.conversations++;
        let d;
        try {
          const rr = await fetch('/backend-api/conversation/' + it.id, { headers: h, credentials: 'include' });
          if (!rr.ok) continue;
          d = await rr.json();
        } catch (e) { continue; }
        const nodes = Object.values(d.mapping || {});
        // The prompt that produced a picture is the last user text before it.
        const byTime = nodes.filter((n) => n && n.message).sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
        let lastUserText = '';
        for (const n of byTime) {
          const m = n.message;
          const parts = m.content && m.content.parts;
          if (!Array.isArray(parts)) continue;
          const texts = parts.filter((p) => typeof p === 'string' && p.trim());
          const role = (m.author && m.author.role) || '';
          if (role === 'user' && texts.length) lastUserText = texts.join(' ').slice(0, 300);
          for (const p of parts) {
            if (!(p && typeof p === 'object' && p.asset_pointer)) continue;
            const fid = String(p.asset_pointer).split('://')[1];
            if (!fid || seenFiles.has(fid)) continue;
            seenFiles.add(fid);
            out.parts.push({
              fileId: fid,
              conversationId: it.id,
              title: it.title || '',
              role,
              createTime: m.create_time || it.create_time || 0,
              width: p.width || 0, height: p.height || 0, size: p.size_bytes || 0,
              mime: p.mime_type || '',
              generated: !!(m.metadata && m.metadata.dalle) || role === 'tool',
              prompt: role === 'user' ? '' : lastUserText,
            });
          }
        }
      }
      offset += items.length;
    }
    return out;
  }, token);
}

async function fetchImage(page, token, fileId) {
  return page.evaluate(async (tok, fid) => {
    const h = { Authorization: 'Bearer ' + tok };
    const r = await fetch('/backend-api/files/' + fid + '/download', { headers: h, credentials: 'include' });
    if (!r.ok) return { error: 'download ' + r.status };
    const j = await r.json();
    if (!j.download_url) return { error: 'no url' };
    const f = await fetch(j.download_url, { credentials: 'include' });
    if (!f.ok) return { error: 'bytes ' + f.status };
    const buf = await f.arrayBuffer();
    let s = ''; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return { b64: btoa(s), name: j.file_name || '', mime: j.mime_type || '', created: j.creation_time || null };
  }, token, fileId);
}

const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'untitled';
const stamp = (ms) => {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const extFor = (mime, name) => {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  const n = String(name || '').toLowerCase().match(/\.(png|webp|gif|jpe?g)$/);
  return n ? (n[1] === 'jpeg' ? 'jpg' : n[1]) : 'png';
};

async function scan({ reason = 'manual' } = {}) {
  if (state.busy) return { ok: false, error: 'already busy' };
  if (!hasProfile()) { state.status = 'unlinked'; return { ok: false, error: 'not connected' }; }
  state.busy = true; state.status = 'scanning'; state.lastError = null;
  const run = { conversations: 0, images: 0, saved: 0, skipped: 0, failed: 0, at: Date.now(), reason };
  try {
    const b = await launch();
    const page = await openPage(b);
    const token = await sessionToken(page);
    if (!token) { state.linked = false; throw new Error('signed out — connect again'); }
    state.linked = true;

    const listed = await listImages(page, token);
    run.conversations = listed.conversations;
    run.images = listed.parts.length;

    fs.mkdirSync(cfg.IMAGES_DIR, { recursive: true });
    for (const part of listed.parts) {
      const id = 'chatgpt_' + part.fileId;
      if (store.has(id)) { run.skipped++; continue; }
      let got;
      try { got = await fetchImage(page, token, part.fileId); }
      catch (e) { got = { error: e.message }; }
      if (!got || got.error) { run.failed++; continue; }
      const ts = part.createTime ? Math.round(part.createTime * 1000) : Date.now();
      const ext = extFor(got.mime || part.mime, got.name);
      const filename = `${stamp(ts)}__chatgpt__${safe(part.title)}__${part.fileId.slice(-10)}.${ext}`;
      const bytes = Buffer.from(got.b64, 'base64');
      try { fs.writeFileSync(path.join(cfg.IMAGES_DIR, filename), bytes); }
      catch (e) { run.failed++; continue; }
      const rec = {
        id, ts,
        // What you sent in is "out", what came back is "in" — the same reading
        // the gallery already gives the two directions of a chat.
        dir: part.role === 'user' ? 'out' : 'in',
        kind: 'image',
        source: 'chatgpt',
        chat: part.title || 'ChatGPT',
        number: '',
        mimetype: got.mime || part.mime || ('image/' + (ext === 'jpg' ? 'jpeg' : ext)),
        filename,
        serve: '/media/images/' + encodeURIComponent(filename),
        size: bytes.length,
        caption: part.prompt || '',
        generated: !!part.generated,
        cloud: false,
      };
      if (store.addRecord(rec)) {
        run.saved++;
        try { require('../ai').noteNewMedia(rec); } catch (_) {}
      }
    }
    state.lastScanAt = Date.now();
    state.lastRun = run;
    state.status = 'linked';
    log(`scan (${reason}): ${run.conversations} conversations, ${run.images} images, ${run.saved} new, ${run.skipped} already had, ${run.failed} failed`);
    return { ok: true, ...run };
  } catch (e) {
    state.lastError = e.message;
    state.status = state.linked ? 'error' : 'unlinked';
    log('scan failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    await closeBrowser();
    state.busy = false;
    schedule();
  }
}

/* ---------------- schedule ---------------- */

function schedule() {
  clearTimeout(timer); timer = null;
  const s = settings.read();
  if (!s.chatgptEnabled || !hasProfile()) { state.nextScanAt = null; return; }
  const hours = Math.max(1, Math.min(168, parseInt(s.chatgptScanHours, 10) || 6));
  const delay = hours * 3600 * 1000;
  state.nextScanAt = Date.now() + delay;
  timer = setTimeout(() => { scan({ reason: 'scheduled' }); }, delay);
  if (timer.unref) timer.unref();
}

function init() {
  const s = settings.read();
  state.linked = hasProfile();
  state.status = state.linked ? 'linked' : (s.chatgptEnabled ? 'unlinked' : 'off');
  if (!s.chatgptEnabled) return;
  // First scan a little after startup, so the phone link and the window come
  // up first; the schedule takes over from there.
  if (state.linked) {
    const t = setTimeout(() => { scan({ reason: 'startup' }); }, 90 * 1000);
    if (t.unref) t.unref();
  }
  schedule();
}

const getState = () => ({ ...state, enabled: !!settings.read().chatgptEnabled, scanHours: settings.read().chatgptScanHours || 6 });

module.exports = { init, connect, disconnect, checkLink, scan, schedule, getState };
