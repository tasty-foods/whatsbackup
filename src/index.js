'use strict';
const settings = require('./settings');
const logger = require('./logger');
logger.init({ maxMB: settings.read().logMaxMB });

const cfg = require('./config');
const store = require('./store');
const createApp = require('./web');
const { startClient } = require('./whatsapp');

store.ensureDirs();

const app = createApp();
// Bind to loopback only — this dashboard exposes your private WhatsApp media,
// so it must not be reachable from other devices on the network.
const server = app.listen(cfg.PORT, '127.0.0.1', () => {
  console.log('====================================================');
  console.log('  WhatsBackUp');
  console.log('  Open:    http://localhost:' + cfg.PORT);
  console.log('  Home:    ' + cfg.APP_HOME);
  console.log('  Images:  ' + cfg.IMAGES_DIR);
  console.log('  Videos:  ' + cfg.VIDEO_DIR + (cfg.CLOUD_AVAILABLE ? '  (cloud folder)' : cfg.CLOUD_CONFIGURED ? '  (LOCAL — cloud drive not found)' : '  (local)'));
  console.log('====================================================');
  startClient();

  // Tell the Electron shell we're up, so it can show the window on the right port.
  if (process.parentPort) {
    try { process.parentPort.postMessage({ type: 'listening', port: cfg.PORT, home: cfg.APP_HOME }); } catch (_) {}
    // The shell holds the AI key: it decrypts it and hands it over in memory,
    // so the plaintext never lands in settings.json, a log, or this repo.
    process.parentPort.on('message', (e) => {
      const msg = e && e.data;
      if (msg && msg.type === 'ai-keys') {
        const keys = msg.keys || {};
        require('./ai').setKeys(keys);
        const n = Object.keys(keys).length;
        console.log('[ai] ' + (n ? n + ' provider key(s) received: ' + Object.keys(keys).join(', ') : 'keys cleared'));
      }
      if (msg && msg.type === 'ai-key') {          // older shell, single key
        require('./ai').setKey(msg.key || '');
        console.log('[ai] key ' + (msg.key ? 'received' : 'cleared'));
      }
    });
  }

  // New captures trickle through the labeller when the user asked for that.
  setInterval(() => { try { require('./ai').kick(); } catch (_) {} }, 60000);

  // The status scheduler: armed always, inert until enabled + consented.
  try { require('./status/scheduler').init(); } catch (e) { console.error('[status] failed to start:', e.message); }

  // Run the history import on a schedule when one is set. Checked every ten
  // minutes rather than timed exactly: the machine sleeps, and a missed hour
  // should mean "run it now", not "wait for the next tick a day later".
  setInterval(() => {
    try {
      const wa = require('./whatsapp');
      const s = require('./settings').read();
      const every = (s.autoImportHours || 0) * 3600000;
      if (!every) return;
      const st = wa.getState();
      if (st.status !== 'ready' || st.backfill.running) return;
      const last = s.lastImportAt || 0;
      if (Date.now() - last < every) return;
      console.log('[history] scheduled import (every ' + s.autoImportHours + 'h)');
      Promise.resolve(wa.runBackfill(s.backfillLimit || 400))
        .catch((e) => console.error('[history] scheduled import failed:', e.message));
    } catch (_) {}
  }, 600000);

  // Reflect cloud-drive drops/reappearance in the UI health status.
  setInterval(() => {
    if (cfg.recheckCloud && cfg.recheckCloud()) {
      console.log('[cloud] availability changed → ' + (cfg.CLOUD_AVAILABLE ? 'available' : 'UNAVAILABLE'));
    }
  }, 15000);
});

// Single-instance guard: if the dashboard is already running, don't start a
// second copy (which would fight over the WhatsApp session and the port).
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[startup] Port ' + cfg.PORT + ' is already in use — this copy will exit.');
    if (process.parentPort) {
      try { process.parentPort.postMessage({ type: 'port-in-use', port: cfg.PORT }); } catch (_) {}
    }
    process.exit(0);
  }
  console.error('[startup] server error:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message ? e.message : e));
