'use strict';
// The engine on an isolated data home, for working on the dashboard without
// touching the real archive or the phone link.
//
//   node tools/dev-server.js            → http://127.0.0.1:8799, data in .dev-home/
//   node tools/dev-server.js --link     → also start the WhatsApp link (QR)
//
// Seed it first with `node tools/seed-dev.js`.
const path = require('path');
const fs = require('fs');

const HOME = process.env.WB_HOME || path.join(__dirname, '..', '.dev-home');
fs.mkdirSync(HOME, { recursive: true });
process.env.WB_HOME = HOME;
process.env.PORT = process.env.PORT || '8799';
if (!process.argv.includes('--link')) process.env.WB_NO_WHATSAPP = '1';
process.env.WB_VERSION = process.env.WB_VERSION || require('../package.json').version + '-dev';

require('../src/index.js');
