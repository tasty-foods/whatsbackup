'use strict';
// Renders the app icon and the three tray states, then wraps each as a Windows
// .ico (PNG-in-ICO). Run: npm run icons
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build', 'icons');

// A chat bubble with a download arrow: "WhatsApp, saved".
const glyph = (fill) => `
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path fill="${fill}" d="M50 12c-19.9 0-36 13.9-36 31 0 8.1 3.6 15.5 9.6 21-1 6.4-3.6 11.4-7.4 15.4-1 1.1-.2 2.8 1.3 2.6 8.9-1.2 15.6-4.6 20.2-8.1 3.9 1.1 8 1.7 12.3 1.7 19.9 0 36-13.9 36-31S69.9 12 50 12z"/>
    <path fill="none" stroke="${fill === '#fff' ? '#128c7e' : '#fff'}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"
          d="M50 26v22m0 0l-10-10m10 10l10-10M33 56h34"/>
  </svg>`;

const dot = (color) => `<circle cx="78" cy="78" r="20" fill="${color}" stroke="#0b141a" stroke-width="6"/>`;

const page = (body, size, bg) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  .wrap{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
        ${bg ? `background:${bg};border-radius:${Math.round(size * 0.22)}px;` : ''}}
  svg{width:${Math.round(size * (bg ? 0.72 : 1))}px;height:${Math.round(size * (bg ? 0.72 : 1))}px}
</style><div class="wrap">${body}</div>`;

// ICO container: ICONDIR(6) + ICONDIRENTRY(16) + PNG payload.
function toIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); entry.writeUInt8(0, 1);   // 0 => 256 (and fine for smaller sizes too)
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const ICONS = [
  { file: 'app.ico', size: 256, html: page(glyph('#fff'), 256, 'linear-gradient(135deg,#25d366,#128c7e)') },
  { file: 'tray-ok.ico', size: 64, html: page(glyph('#fff') + '', 64, null) },
  { file: 'tray-warn.ico', size: 64, html: page(glyph('#fff').replace('</svg>', dot('#f0b429') + '</svg>'), 64, null) },
  { file: 'tray-off.ico', size: 64, html: page(glyph('#8696a0').replace('</svg>', dot('#8696a0') + '</svg>'), 64, null) },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  const p = await browser.newPage();
  for (const ic of ICONS) {
    await p.setViewport({ width: ic.size, height: ic.size, deviceScaleFactor: 1 });
    await p.setContent(ic.html, { waitUntil: 'load' });
    const png = await p.screenshot({ type: 'png', omitBackground: true });
    fs.writeFileSync(path.join(OUT, ic.file), toIco(png));
    console.log('wrote', ic.file, png.length, 'bytes');
  }
  await browser.close();
  // electron-builder wants a 256px icon for the installer too.
  fs.copyFileSync(path.join(OUT, 'app.ico'), path.join(__dirname, '..', 'build', 'icon.ico'));
  console.log('wrote build/icon.ico');
})().catch((e) => { console.error(e); process.exit(1); });
