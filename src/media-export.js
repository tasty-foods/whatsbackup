'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

function failure(status, message) { return Object.assign(new Error(message), { status }); }

async function planSelection(ids, { getRecord, hiddenIds, pathsFor }) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !id || id.length > 500)) {
    throw failure(400, 'Select between 1 and 10,000 files.');
  }
  const entries = [], used = new Set(), hidden = hiddenIds();
  let unavailable = 0;
  for (const id of new Set(ids)) {
    const record = getRecord(id);
    if (!record || hidden.has(id)) { unavailable++; continue; }
    let file;
    for (const candidate of (await pathsFor(record)).filter(Boolean)) {
      try { if ((await fs.promises.stat(candidate)).isFile()) { file = candidate; break; } } catch (_) {}
    }
    if (!file) { unavailable++; continue; }
    const original = String(record.docName || record.filename || path.basename(file));
    // Flatten names from both Windows and Unix; never create folders in the ZIP.
    let base = original.split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 180) || 'file';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = '_' + base;
    const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
    let name = base, suffix = 2;
    while (used.has(name.toLowerCase())) name = stem + ' (' + suffix++ + ')' + ext;
    used.add(name.toLowerCase());
    entries.push({ file, name });
  }
  if (unavailable) throw failure(409, unavailable + ' selected file(s) are unavailable. Reconnect the storage location or change your selection.');
  return entries;
}

function register(app, { sameOrigin, getRecord, hiddenIds, pathsFor, now = Date.now }) {
  const tickets = new Map(), ttl = 2 * 60 * 1000;
  const options = { getRecord, hiddenIds, pathsFor };
  function sendError(res, error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not prepare your export. Try again.' }); }
  app.post('/api/export/prepare', sameOrigin, async (req, res) => {
    try {
      const ids = req.body && req.body.ids;
      const entries = await planSelection(ids, options);
      for (const [key, value] of tickets) if (value.until < now()) tickets.delete(key);
      // Bound retained selections even if a client never starts its download.
      while (tickets.size >= 20) tickets.delete(tickets.keys().next().value);
      const ticket = crypto.randomBytes(24).toString('hex');
      tickets.set(ticket, { ids: [...new Set(ids)], until: now() + ttl });
      res.json({ ok: true, ticket, count: entries.length });
    } catch (error) { sendError(res, error); }
  });
  app.get('/api/export/media', async (req, res) => {
    const ticket = tickets.get(req.query.ticket);
    if (!ticket || ticket.until < now()) return res.status(410).json({ error: 'This export has expired. Select Export again.' });
    tickets.delete(req.query.ticket);
    let entries;
    try { entries = await planSelection(ticket.ids, options); } catch (error) { return sendError(res, error); }
    res.attachment('WhatsBackUp-selection-' + new Date(now()).toISOString().slice(0, 10) + '.zip');
    res.setHeader('Cache-Control', 'no-store');
    const zip = archiver('zip', { zlib: { level: 1 } });
    // A storage failure after streaming starts must abort, never report a partial ZIP as complete.
    const abort = () => { zip.abort(); res.destroy(); };
    zip.on('error', abort);
    zip.on('warning', abort);
    res.on('close', () => { if (!res.writableFinished) zip.abort(); });
    zip.pipe(res);
    for (const entry of entries) zip.file(entry.file, { name: entry.name });
    zip.finalize().catch(abort);
  });
}

module.exports = { planSelection, register };
