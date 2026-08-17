'use strict';
// Puts a Chrome build inside build/chromium so the installer can carry it and
// the target machine needs nothing installed. Pinned on purpose: the linked
// WhatsApp session is a Chromium profile, and swapping the browser under it is
// how you end up asking everyone to scan a QR code again.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILD_ID = process.env.WB_CHROME_BUILD || '146.0.7680.31';
const DEST = path.join(__dirname, '..', 'build', 'chromium');
const CACHE = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', `win64-${BUILD_ID}`);

(async () => {
  const already = fs.existsSync(path.join(DEST, 'chrome', `win64-${BUILD_ID}`));
  if (already) { console.log('Chrome', BUILD_ID, 'already staged in build/chromium'); return; }

  fs.mkdirSync(DEST, { recursive: true });

  // Reuse the copy puppeteer already downloaded when there is one — it saves
  // pulling ~400 MB again on every build machine that has run puppeteer.
  if (fs.existsSync(CACHE)) {
    const target = path.join(DEST, 'chrome', `win64-${BUILD_ID}`);
    console.log('Copying Chrome', BUILD_ID, 'from the puppeteer cache…');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(CACHE, target, { recursive: true });
    console.log('Staged', target);
    return;
  }

  console.log('Downloading Chrome', BUILD_ID, '…');
  const { install, Browser } = require('@puppeteer/browsers');
  const installed = await install({ browser: Browser.CHROME, buildId: BUILD_ID, cacheDir: DEST });
  console.log('Staged', installed.executablePath);
})().catch((e) => { console.error('fetch-chrome failed:', e.message); process.exit(1); });
