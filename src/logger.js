'use strict';
// Everything printed to the console also goes to a rotating file. Installed,
// there is no terminal to watch, and the old setup appended to one unbounded
// file forever — on a machine left running for months that is a slow disk leak.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const FILE = path.join(paths.LOGS_DIR, 'whatsbackup.log');
const PREV = FILE + '.1';

let stream = null;
let written = 0;
let maxBytes = 5 * 1024 * 1024;

function open() {
  fs.mkdirSync(paths.LOGS_DIR, { recursive: true });
  try { written = fs.statSync(FILE).size; } catch (_) { written = 0; }
  stream = fs.createWriteStream(FILE, { flags: 'a' });
}

function rotate() {
  try { if (stream) stream.end(); } catch (_) {}
  try { if (fs.existsSync(PREV)) fs.unlinkSync(PREV); } catch (_) {}
  try { fs.renameSync(FILE, PREV); } catch (_) {}
  open();
}

function render(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}

function init({ maxMB } = {}) {
  if (maxMB) maxBytes = Math.max(1, maxMB) * 1024 * 1024;
  if (!stream) open();
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const text = `${new Date().toISOString()} ${level === 'log' ? 'info ' : level} ${args.map(render).join(' ')}\n`;
      try {
        stream.write(text);
        written += Buffer.byteLength(text);
        if (written >= maxBytes) rotate();
      } catch (_) {}
    };
  }
  return FILE;
}

module.exports = { init, FILE, PREV };
