'use strict';
// Optional: pull RECENT media already sitting in your chats (best-effort).
// WhatsApp only lets a linked device see a limited history, so this grabs
// what it can from your most active chats. Run: npm run backfill
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

// Run by hand with plain node, this script has no WB_HOME, so paths.js would
// fall back to the project folder — a session that was never linked and an
// index the installed app never reads. It would appear to work and fill a
// folder nobody looks at. Point it at the installed home when there is one,
// before config is loaded, and say out loud which it chose.
if (!process.env.WB_HOME) {
  const installed = path.join(process.env.LOCALAPPDATA || '', 'WhatsBackUp');
  if (installed && fs.existsSync(path.join(installed, 'data', 'settings.json'))) {
    process.env.WB_HOME = installed;
  }
}

const cfg = require('./config');
const store = require('./store');

console.log('[backfill] Using ' + cfg.APP_HOME + (process.env.WB_HOME ? '' : '  (project folder — no installed copy found)'));
console.log('[backfill] Set WB_HOME to override.');

const PER_CHAT = parseInt(process.env.WA_BACKFILL_LIMIT || '80', 10);

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov' };
const extFor = (m) => EXT[m] || (m && m.split('/')[1]) || 'bin';
const sanitize = (s) => (s || 'unknown').replace(/[^\p{L}\p{N}\-_. ]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown';
const stamp = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

store.ensureDirs();
store.loadAll();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: cfg.AUTH_DIR }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] },
});

client.on('qr', () => console.log('Not linked yet — start the app first (npm start) and scan the QR, then run backfill.'));

client.on('ready', async () => {
  console.log('[backfill] Linked. Scanning chats for recent images & videos…');
  let saved = 0;
  const chats = await client.getChats();
  for (const chat of chats) {
    let msgs = [];
    try { msgs = await chat.fetchMessages({ limit: PER_CHAT }); } catch (_) { continue; }
    for (const msg of msgs) {
      try {
        if (!msg.hasMedia) continue;
        if (msg.from === 'status@broadcast') continue;
        const kind = msg.type === 'image' ? 'image' : msg.type === 'video' ? 'video' : null;
        if (!kind) continue;
        const id = msg.id && msg.id._serialized ? msg.id._serialized : String(msg.id);
        if (store.has(id)) continue;
        const media = await msg.downloadMedia();
        if (!media || !media.data) continue;
        const ts = msg.timestamp ? msg.timestamp * 1000 : Date.now();
        const dir = msg.fromMe ? 'out' : 'in';
        const chatName = chat.name || (chat.id && chat.id.user) || 'unknown';
        const ext = extFor(media.mimetype);
        const filename = `${stamp(ts)}__${dir}__${sanitize(chatName)}__${id.replace(/[^A-Za-z0-9]/g, '').slice(-10)}.${ext}`;
        const buf = Buffer.from(media.data, 'base64');
        let serve;
        if (kind === 'image') { fs.writeFileSync(path.join(cfg.IMAGES_DIR, filename), buf); serve = '/media/images/' + encodeURIComponent(filename); }
        else { fs.writeFileSync(path.join(cfg.VIDEO_DIR, filename), buf); serve = '/media/videos/' + encodeURIComponent(filename); }
        store.addRecord({ id, ts, dir, kind, chat: chatName, number: (chat.id && chat.id.user) || '', mimetype: media.mimetype, filename, serve, size: buf.length, caption: msg.body || '', cloud: kind === 'video' ? cfg.CLOUD_AVAILABLE : false });
        saved++;
        if (saved % 10 === 0) console.log(`[backfill] saved ${saved}…`);
      } catch (_) {}
    }
  }
  console.log(`[backfill] Done. Saved ${saved} new items. You can close this (Ctrl+C).`);
  process.exit(0);
});

client.initialize().catch((e) => { console.error('[backfill] failed:', e.message); process.exit(1); });
