'use strict';
// Renders the social sharing card for the website. Every messaging app, search
// engine and chat preview shows this image, and none of them render SVG — so it
// has to be a real PNG. Run: npm run og
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'assets', 'og.png');

const html = `<!doctype html><meta charset="utf-8"><style>
  @page { margin: 0 }
  html,body { margin:0; padding:0; width:1200px; height:630px; }
  body {
    background: #070b11;
    color: #e9eff6;
    font: 400 24px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    position: relative; overflow: hidden;
  }
  .glow {
    position:absolute; width:900px; height:900px; left:-220px; top:-380px; border-radius:50%;
    background: radial-gradient(closest-side, rgba(46,230,168,.20), rgba(46,230,168,0));
  }
  .glow2 {
    position:absolute; width:760px; height:760px; right:-240px; bottom:-360px; border-radius:50%;
    background: radial-gradient(closest-side, rgba(22,184,212,.18), rgba(22,184,212,0));
  }
  .pad { position:relative; padding: 74px 78px; height:630px; box-sizing:border-box; display:flex; flex-direction:column; }
  /* No flex gap: "Whats" and <b>BackUp</b> are two flex items and a gap would
     split the wordmark down the middle. */
  .brand { display:flex; align-items:center; font-size:30px; font-weight:800; letter-spacing:-.02em; }
  .brand svg { width:56px; height:56px; margin-right:16px; }
  .brand b { color:#2ee6a8 }
  h1 {
    font-size: 76px; line-height:1.04; letter-spacing:-.035em; font-weight:800;
    margin: 46px 0 24px; max-width: 17ch;
  }
  p { font-size:29px; color:#93a5b8; margin:0; max-width:34ch; line-height:1.45 }
  .pills { margin-top:auto; display:flex; gap:12px; flex-wrap:wrap }
  .pill {
    border:1px solid #2a3b4f; background:#0e1621; color:#93a5b8;
    padding:11px 20px; border-radius:999px; font-size:22px; font-weight:600;
  }
  .pill.on { border-color:transparent; background:linear-gradient(135deg,#2ee6a8,#16b8d4); color:#04140f; font-weight:800 }
</style>
<div class="glow"></div><div class="glow2"></div>
<div class="pad">
  <div class="brand">
    <svg viewBox="0 0 100 100">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2ee6a8"/><stop offset="1" stop-color="#16b8d4"/>
      </linearGradient></defs>
      <rect width="100" height="100" rx="24" fill="url(#g)"/>
      <path fill="#04140f" d="M50 18c-17.1 0-31 11.9-31 26.6 0 6.9 3.1 13.3 8.3 18-.9 5.5-3.1 9.8-6.4 13.2-.9.9-.2 2.4 1.1 2.2 7.7-1 13.4-4 17.4-7 3.4.9 6.9 1.4 10.6 1.4 17.1 0 31-11.9 31-26.6S67.1 18 50 18z"/>
      <path fill="none" stroke="#2ee6a8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M50 30v18m0 0l-8-8m8 8l8-8M36 56h28"/>
    </svg>
    Whats<b>BackUp</b>
  </div>
  <h1>Never lose another WhatsApp photo.</h1>
  <p>Every photo, video and message saved automatically to your own PC — then sorted into albums that make sense.</p>
  <div class="pills">
    <span class="pill on">Free &amp; open source</span>
    <span class="pill">Windows 10 &amp; 11</span>
    <span class="pill">No account</span>
    <span class="pill">Nothing uploaded</span>
  </div>
</div>`;

(async () => {
  const launch = { headless: true, args: ['--no-sandbox', '--font-render-hinting=none'] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  const browser = await puppeteer.launch(launch);
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, type: 'png' });
  await browser.close();
  console.log('wrote', path.relative(process.cwd(), OUT), fs.statSync(OUT).size, 'bytes');
})();
