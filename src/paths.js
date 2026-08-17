'use strict';
// Where the app keeps its mutable state.
//
// Installed, the program lives in a read-only folder, so the Electron shell
// passes WB_HOME (%LOCALAPPDATA%\WhatsBackUp) and everything writable goes
// there. Running from source, everything stays in the project folder so
// `npm start` still behaves exactly as it always did.
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const APP_HOME = process.env.WB_HOME || PROJECT_ROOT;
const PACKAGED = !!process.env.WB_HOME;

module.exports = {
  PROJECT_ROOT,
  APP_HOME,
  PACKAGED,
  DATA_DIR: path.join(APP_HOME, 'data'),
  LOGS_DIR: path.join(APP_HOME, 'logs'),
  // The linked device is a Chromium profile. Installed it sits in the app home;
  // from source it keeps its original name so an existing dev session survives.
  AUTH_DIR: PACKAGED ? path.join(APP_HOME, 'session') : path.join(PROJECT_ROOT, '.wwebjs_auth'),
};
