'use strict';
// Resolves a message author id / number to a human contact name, so group
// chats show names instead of raw phone-number ids. Populated from the linked
// account's address book once the client is ready.
let byId = new Map();   // serialized id  -> name
let byNum = new Map();  // digits only    -> name

function load(list) {
  const id = new Map();
  const num = new Map();
  for (const c of list || []) {
    const name = c.name || c.pushname || c.shortName || null;
    if (!name) continue;
    const sid = c.id && c.id._serialized;
    if (sid) id.set(sid, name);
    const digits = String(c.number || (c.id && c.id.user) || '').replace(/\D/g, '');
    if (digits) num.set(digits, name);
  }
  byId = id; byNum = num;
  return byId.size;
}

function resolve(author) {
  if (!author || author === 'me') return author;
  if (byId.has(author)) return byId.get(author);
  const digits = String(author).replace(/@.*$/, '').replace(/\D/g, '');
  if (digits && byNum.has(digits)) return byNum.get(digits);
  return null;
}

function size() { return byId.size; }

module.exports = { load, resolve, size };
