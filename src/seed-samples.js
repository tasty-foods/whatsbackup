'use strict';
// Generates a handful of clearly-labeled SAMPLE images so the dashboard shows
// real, scrollable, downloadable pictures immediately (before you link WhatsApp).
// Remove them any time with:  npm run reset
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');

const HOUR = 3600 * 1000;
const now = Date.now();

const SAMPLES = [
  { emoji: '🏖️', title: 'Beach day',      sub: 'sample photo',  grad: ['#f7971e', '#ffd200'], w: 900,  h: 1200, chat: 'Sample · Family group', dir: 'in',  ago: 0.4 },
  { emoji: '☕', title: 'Morning coffee',  sub: 'sample photo',  grad: ['#c79081', '#dfa579'], w: 1200, h: 900,  chat: 'Sample · Anna',         dir: 'out', ago: 1.5 },
  { emoji: '🐕', title: 'Good boy',        sub: 'sample photo',  grad: ['#43cea2', '#185a9d'], w: 1000, h: 1000, chat: 'Sample · Neighbours',   dir: 'in',  ago: 3 },
  { emoji: '🌇', title: 'Sunset walk',     sub: 'sample photo',  grad: ['#ee0979', '#ff6a00'], w: 1200, h: 800,  chat: 'Sample · Ben',          dir: 'in',  ago: 6 },
  { emoji: '🍝', title: 'Dinner tonight',  sub: 'sample photo',  grad: ['#8e2de2', '#4a00e0'], w: 900,  h: 1100, chat: 'Sample · Anna',         dir: 'out', ago: 26 },
  { emoji: '🏔️', title: 'Weekend trip',    sub: 'sample photo',  grad: ['#2193b0', '#6dd5ed'], w: 1200, h: 850,  chat: 'Sample · Family group', dir: 'in',  ago: 30 },
];

function cardHtml(s) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  .card{width:${s.w}px;height:${s.h}px;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:linear-gradient(135deg,${s.grad[0]},${s.grad[1]});color:#fff;font-family:Segoe UI,Arial,sans-serif;text-align:center}
  .emoji{font-size:${Math.round(s.w/5)}px;line-height:1}
  .title{font-size:${Math.round(s.w/14)}px;font-weight:800;margin-top:.3em;text-shadow:0 3px 18px rgba(0,0,0,.25)}
  .sub{font-size:${Math.round(s.w/34)}px;opacity:.85;margin-top:.4em;letter-spacing:.15em;text-transform:uppercase}
  </style></head><body><div class="card"><div class="emoji">${s.emoji}</div>
  <div class="title">${s.title}</div><div class="sub">${s.sub}</div></div></body></html>`;
}

function stamp(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

(async () => {
  store.ensureDirs();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let n = 0;
  for (const s of SAMPLES) {
    const page = await browser.newPage();
    await page.setViewport({ width: s.w, height: s.h });
    await page.setContent(cardHtml(s), { waitUntil: 'networkidle0' });
    const ts = now - Math.round(s.ago * HOUR);
    const id = 'sample_' + (++n);
    const filename = `${stamp(ts)}__${s.dir}__Sample__${id}.jpg`;
    const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
    fs.writeFileSync(path.join(cfg.IMAGES_DIR, filename), buf);
    await page.close();
    store.addRecord({
      id, ts, dir: s.dir, kind: 'image', chat: s.chat, number: '',
      mimetype: 'image/jpeg', filename, serve: '/media/images/' + encodeURIComponent(filename),
      size: buf.length, caption: s.title, cloud: false, sample: true,
    });
    console.log('seeded', filename, `(${(buf.length / 1024).toFixed(0)} KB)`);
  }
  await browser.close();
  console.log(`\nDone. ${n} sample images added. Open http://localhost:${cfg.PORT} — run "npm run reset" to remove them.`);
})().catch((e) => { console.error(e); process.exit(1); });
