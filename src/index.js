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
  }

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
