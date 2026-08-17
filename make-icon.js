'use strict';
// Renders a 256x256 app icon and wraps it as a Windows .ico (PNG-in-ICO).
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'icon.ico');
const SIZE = 256;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}
.wrap{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#25d366,#128c7e)}
.badge{font-size:150px;line-height:1;filter:drop-shadow(0 6px 10px rgba(0,0,0,.25))}
</style></head><body><div class="wrap"><div class="badge">🖼️</div></div></body></html>`;

(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: SIZE, height: SIZE });
  await p.setContent(html, { waitUntil: 'networkidle0' });
  const png = await p.screenshot({ type: 'png' });
  await b.close();

  // ICO: ICONDIR(6) + ICONDIRENTRY(16) + PNG data
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(1, 4);   // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);       // width 0 => 256
  entry.writeUInt8(0, 1);       // height 0 => 256
  entry.writeUInt8(0, 2);       // colors
  entry.writeUInt8(0, 3);       // reserved
  entry.writeUInt16LE(1, 4);    // planes
  entry.writeUInt16LE(32, 6);   // bpp
  entry.writeUInt32LE(png.length, 8);   // size
  entry.writeUInt32LE(6 + 16, 12);      // offset
  fs.writeFileSync(OUT, Buffer.concat([header, entry, png]));
  console.log('wrote', OUT, png.length, 'bytes png');
})().catch((e) => { console.error(e.message); process.exit(1); });
