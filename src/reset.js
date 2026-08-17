'use strict';
// Clears the gallery from the command line.
//   npm run reset            -> remove welcome samples only
//   npm run reset -- --all   -> clear everything (local images + index)
const { clearGallery } = require('./maintenance');
const all = process.argv.includes('--all');
const r = clearGallery({ all });
console.log(`Removed ${r.removed} record(s), deleted ${r.deleted} local image file(s). ${r.kept} kept.`);
