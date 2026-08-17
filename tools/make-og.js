'use strict';
// Renders the social sharing card. Every messaging app, search engine and chat
// preview shows this image and none of them render SVG, so it has to be a real
// PNG. It carries the same argument the site opens with: a contact sheet with
// frames already missing. Run: npm run og
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'assets', 'og.png');

const WASH = ['#5c6b52', '#7d6a54', '#455566', '#8a6f5e', null, '#6b5f7a', '#4f6660', '#7a5a4c'];

const frames = WASH.map((c, i) => {
  const n = String(41 + i).padStart(3, '0');
  return c
    ? `<div class="fr" style="background:${c}"><span class="n">${n}</span></div>`
    : `<div class="fr gone"><span class="x">no longer<br>available</span><span class="n">${n}</span></div>`;
}).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body { margin:0; padding:0; width:1200px; height:630px; }
  body {
    background:#f4f1e8; color:#16140e; overflow:hidden;
    font:400 26px/1.5 Georgia, "Iowan Old Style", "Palatino Linotype", serif;
    -webkit-font-smoothing:antialiased;
  }
  /* Everything is sized to land inside 630px with room to spare — a social card
     that overflows is cropped by the platform, not scrolled. */
  .pad { padding:56px 62px; height:630px; box-sizing:border-box; display:grid;
         grid-template-columns:1fr 430px; gap:48px; align-items:center }
  .label { font-family:ui-monospace,Consolas,monospace; font-size:14px; letter-spacing:.15em;
           white-space:nowrap; text-transform:uppercase; color:#6d6551; margin:0 0 24px }
  .label b { color:#a83518; font-weight:400 }
  h1 { font-size:60px; line-height:1.04; letter-spacing:-.028em; font-weight:400; margin:0 0 22px }
  h1 i { font-style:normal; color:#a83518 }
  p { font-size:23px; line-height:1.45; color:#4b4536; margin:0; max-width:28ch }
  .rule { height:1px; background:#d3cbb6; margin:24px 0 20px }
  /* max-width is inherited from the paragraph rule above; this line must not wrap. */
  .set { font-family:ui-monospace,Consolas,monospace; font-size:13.5px; letter-spacing:.11em;
         text-transform:uppercase; color:#6d6551; max-width:none; white-space:nowrap }
  .sheet { border:1px solid #b9ae94; background:#ebe6d9; padding:14px }
  .bar { display:flex; justify-content:space-between; font-family:ui-monospace,Consolas,monospace;
         font-size:13px; letter-spacing:.15em; text-transform:uppercase; color:#6d6551; padding-bottom:12px }
  .frames { display:grid; grid-template-columns:repeat(4,1fr); gap:8px }
  .fr { position:relative; aspect-ratio:1; border:1px solid #b9ae94 }
  .fr .n { position:absolute; left:0; bottom:0; font-family:ui-monospace,Consolas,monospace;
           font-size:11px; background:rgba(10,9,6,.62); color:#f2eee2; padding:2px 5px }
  .fr.gone { background:#e2dcca; border-style:dashed; display:grid; place-items:center }
  .fr.gone .x { font-family:ui-monospace,Consolas,monospace; font-size:10px; letter-spacing:.1em;
                text-transform:uppercase; color:#a83518; text-align:center; line-height:1.5 }
  .fr.gone .n { background:none; color:#6d6551 }
</style>
<div class="pad">
  <div>
    <p class="label">WhatsBackUp <b>·</b> Free &amp; open source <b>·</b> Windows 10 &amp; 11</p>
    <h1>Your WhatsApp photos are <i>quietly</i> being deleted.</h1>
    <p>Keep a copy of every one, on your own disk, automatically.</p>
    <div class="rule"></div>
    <p class="set">No account · Nothing uploaded · Ordinary files</p>
  </div>
  <figure class="sheet" style="margin:0">
    <div class="bar"><span>Contact sheet</span><span>Aug 2024</span></div>
    <div class="frames">${frames}</div>
  </figure>
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
