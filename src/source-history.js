'use strict';
// Keep import summaries across engine restarts; never store account tokens here.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const file = (source) => path.join(DATA_DIR, source + '-import.json');
function read(source) {
  try { return JSON.parse(fs.readFileSync(file(source), 'utf8')); } catch (_) { return null; }
}
function write(source, run) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const target = file(source);
    fs.writeFileSync(target + '.tmp', JSON.stringify(run));
    fs.renameSync(target + '.tmp', target);
  } catch (e) { console.warn('[' + source + '] Could not save import summary:', e.message); }
}
module.exports = { read, write };
