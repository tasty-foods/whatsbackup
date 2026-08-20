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
let rotating = false;

function open() {
  fs.mkdirSync(paths.LOGS_DIR, { recursive: true });
  try { written = fs.statSync(FILE).size; } catch (_) { written = 0; }
  stream = fs.createWriteStream(FILE, { flags: 'a' });
}

// The rename has to wait for the write stream to actually close: on Windows the
// file handle is still open synchronously after stream.end(), so renaming it
// throws EPERM/EBUSY (silently, into the old catch). That left FILE in place at
// full size, open() re-read it as still-over-limit, and every subsequent line
// re-entered rotate() — the log never rotated and churned a stream per line.
// So: swap only inside end()'s completion callback, guarded against re-entry.
function rotate() {
  if (rotating || !stream) return;
  rotating = true;
  written = 0;                       // stop this and following lines re-triggering during the async swap
  const closing = stream;
  stream = null;
  const swap = () => {
    try { if (fs.existsSync(PREV)) fs.unlinkSync(PREV); } catch (_) {}
    try { fs.renameSync(FILE, PREV); } catch (_) {}
    open();                          // reopens a fresh FILE; written := 0
    rotating = false;
  };
  try { closing.end(swap); } catch (_) { swap(); }
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
