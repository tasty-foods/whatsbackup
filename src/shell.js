'use strict';
// The engine runs as an Electron utilityProcess, where require('electron')
// hands back only { net, systemPreferences }: no image decoder, no video
// decoder. The shell has Chromium's, so anything that needs one is asked of
// the shell over the channel that already exists, request/reply with an id.
//
// Every request has a deadline and never throws: a missing shell (the engine
// run on its own with `npm run server`) answers null, and callers fall back.
const pending = new Map();
let nextId = 1;

const available = () => !!(process.parentPort && typeof process.parentPort.postMessage === 'function');

// Replies arrive on the engine's single 'message' listener (src/index.js),
// which hands anything with an id and a type ending in -done here.
function accept(msg) {
  if (!msg || typeof msg !== 'object' || msg.id == null) return false;
  if (msg.type !== 'shrunk' && !/-done$/.test(String(msg.type || ''))) return false;
  const slot = pending.get(msg.id);
  if (!slot) return true;                 // a late reply after we gave up
  pending.delete(msg.id);
  clearTimeout(slot.timer);
  slot.resolve(msg.ok ? msg : null);
  return true;
}

function request(type, payload, timeoutMs = 20000) {
  if (!available()) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, { resolve, timer });
    try { process.parentPort.postMessage({ type, id, ...payload }); }
    catch (_) { pending.delete(id); clearTimeout(timer); resolve(null); }
  });
}

module.exports = { request, accept, available };
