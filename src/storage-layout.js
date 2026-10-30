'use strict';
const path = require('node:path');
const SOURCES = { whatsapp:'WhatsApp', chatgpt:'ChatGPT', gemini:'Gemini', googlephotos:'Google Photos', gmail:'Gmail', local:'Imported files' };
function category(rec) {
  if (['image','sticker'].includes(rec.kind)) return 'Images';
  if (rec.kind === 'video') return 'Videos';
  if (['voice','audio'].includes(rec.kind)) return 'Audio';
  return /\.(pdf|docx?|xlsx?|pptx?|od[tsfp]|txt|csv|tsv|rtf|md)$/i.test(rec.docName || rec.filename || '') ? 'Documents' : 'Other files';
}
function cloudRelative(rec, layout = 'source-date') {
  if (!rec.filename || path.basename(rec.filename) !== rec.filename || /[\\/\0]/.test(rec.filename)) throw new Error('Invalid archive filename.');
  if (layout === 'flat') return path.join(rec.kind === 'video' ? 'Videos' : ['image','sticker'].includes(rec.kind) ? 'Images' : 'Files', rec.filename);
  const date = new Date(rec.ts || rec.importedAt || 0);
  const stamp = Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1970 ? date.toISOString().slice(0,7) : 'Undated';
  return path.join(SOURCES[rec.source || 'whatsapp'] || 'Other sources', stamp, category(rec), rec.filename);
}
module.exports = { cloudRelative, category };
