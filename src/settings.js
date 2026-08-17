'use strict';
// Persistent, user-editable settings. Written by the Settings panel in the UI,
// read by config.js at startup. Lives at data/settings.json.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  port: 8788,
  cloudRoot: 'P:/WhatsApp Media',   // your pCloud drive folder for videos
  mirrorImages: true,               // also copy images into pCloud (complete media backup)
  captureConversations: true,       // store message text so conversations can be viewed/searched
  backfillLimit: 400,               // messages scanned per chat when importing history
};

function read() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}
  return { ...DEFAULTS, ...s };
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { read, write, FILE, DEFAULTS };
