'use strict';
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
  console.log('  WhatsApp Media Dashboard');
  console.log('  Open:    http://localhost:' + cfg.PORT);
  console.log('  Images:  ' + cfg.IMAGES_DIR);
  console.log('  Videos:  ' + cfg.VIDEO_DIR + (cfg.CLOUD_AVAILABLE ? '  (pCloud → cloud)' : '  (LOCAL — cloud drive not found)'));
  console.log('====================================================');
  startClient();

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
    console.log('[startup] Dashboard already running on port ' + cfg.PORT + ' — this copy will exit.');
    process.exit(0);
  }
  console.error('[startup] server error:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message ? e.message : e));
