'use strict';
// Resolves a message author id / number to a human contact name, so group
// chats show names instead of raw phone-number ids.
//
// The address book is read from the linked account once the client is ready
// and written to the database, so after a restart the names are there from
// the first second — before WhatsApp has come back up, and even if it never
// does. WhatsApp's newer @lid ids carry no number at all; the lid → phone
// mapping the client can be asked for is kept too, so those resolve as well.
const messages = require('./messages');

let byId = new Map();   // serialized id (or lid) -> name
let byNum = new Map();  // digits only            -> name
let loadedFromDb = false;

const pickName = (c) => c.name || c.pushname || c.shortName || c.short_name || null;

function index(list) {
  const id = new Map();
  const num = new Map();
  for (const c of list || []) {
    const name = pickName(c);
    if (!name) continue;
    const sid = typeof c.id === 'string' ? c.id : (c.id && c.id._serialized);
    if (sid) id.set(sid, name);
    if (c.lid) id.set(c.lid, name);
    const digits = String(c.number || (c.id && c.id.user) || '').replace(/\D/g, '');
    if (digits) num.set(digits, name);
  }
  byId = id; byNum = num;
  return byId.size;
}

// From the live client. The list is written to the database as well, so the
// next start does not have to wait for WhatsApp to answer.
function load(list) {
  const flat = [];
  for (const c of list || []) {
    const sid = c && c.id && (typeof c.id === 'string' ? c.id : c.id._serialized);
    if (!sid) continue;
    flat.push({
      id: sid,
      number: String(c.number || (c.id && c.id.user) || '').replace(/\D/g, ''),
      name: c.name || '', pushname: c.pushname || '', shortName: c.shortName || '',
      lid: typeof c.lid === 'string' ? c.lid : (c.lid && c.lid._serialized) || '',
      isGroup: !!c.isGroup, isMe: !!c.isMe, isBusiness: !!c.isBusiness, isMyContact: !!c.isMyContact,
    });
  }
  try { messages.upsertContacts(flat); } catch (e) { console.warn('[contacts] could not persist:', e.message); }
  // Re-read everything so names learned earlier (a lid mapping, a contact the
  // live list no longer carries) are not thrown away by one fresh listing.
  return loadFromDb();
}

function loadFromDb() {
  let rows = [];
  try { rows = messages.allContacts(); } catch (_) { rows = []; }
  loadedFromDb = true;
  return index(rows.map((r) => ({ id: r.id, number: r.number, name: r.name, pushname: r.pushname, shortName: r.short_name, lid: r.lid })));
}

// Learned lid → phone pairs; the name follows from the phone's contact.
function addLidMappings(pairs) {
  const rows = [];
  for (const p of pairs || []) {
    if (!p || !p.lid || !p.pn) continue;
    const digits = String(p.pn).replace(/@.*$/, '').replace(/\D/g, '');
    const name = byNum.get(digits) || '';
    rows.push({ id: p.pn, number: digits, name, lid: p.lid });
  }
  if (rows.length) { try { messages.upsertContacts(rows); } catch (_) {} loadFromDb(); }
  return rows.length;
}

function resolve(author) {
  if (!author || author === 'me') return author;
  if (!loadedFromDb) { try { loadFromDb(); } catch (_) {} }
  if (byId.has(author)) return byId.get(author);
  const digits = String(author).replace(/@.*$/, '').replace(/\D/g, '');
  if (digits && byNum.has(digits)) return byNum.get(digits);
  return null;
}

function size() { return byId.size; }

module.exports = { load, loadFromDb, addLidMappings, resolve, size };
