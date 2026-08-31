'use strict';
// Labelling asks "what is in this picture", not "enlarge the third pixel". A
// phone photo arrives at 2048px or more, and every one of those pixels is paid
// for twice: once as input tokens at whichever provider is being billed, and
// again as time, because a vision model turns the image into patches before it
// can think about it.
//
// Measured on this project's own library with qwen2.5vl:3b, one 2048x1536 JPEG:
//
//   2048 wide -> 4046 prompt tokens, 143s
//   1024 wide -> 1067 prompt tokens,  24s
//
// and 512, 768 and 1024 all cost the same 1067, because the model normalises to
// a fixed patch budget until the image is big enough to cross into another band.
// So 1024 is the free end of that band: the smallest token bill with the most
// detail left for reading a price list or an article code, which is most of what
// this archive actually contains.
//
// The resize itself needs Chromium's image decoder. The engine runs as a
// utilityProcess, where require('electron') hands back only { net,
// systemPreferences } — no nativeImage — so the work is asked of the shell over
// the channel that already exists, and anything that goes wrong falls back to
// sending the original bytes rather than failing the item.

const MAX_EDGE = 1024;
const REPLY_TIMEOUT_MS = 15000;

const pending = new Map();
let nextId = 1;
let wired = false;

// Called once from the engine's message handler so this module doesn't have to
// own process.parentPort's only 'message' listener.
function accept(msg) {
  if (!msg || msg.type !== 'shrunk') return false;
  const slot = pending.get(msg.id);
  if (!slot) return true;                 // a late reply after we gave up
  pending.delete(msg.id);
  clearTimeout(slot.timer);
  slot.resolve(msg.ok && msg.data ? Buffer.from(msg.data) : null);
  return true;
}

const canShrink = () => !!(process.parentPort && typeof process.parentPort.postMessage === 'function');

// Returns the smaller JPEG, or the original buffer if the shell can't help.
// Never throws: a labelling run must not die because a resize did.
function shrink(bytes, max = MAX_EDGE) {
  if (!canShrink()) return Promise.resolve(bytes);
  wired = true;
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, REPLY_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      process.parentPort.postMessage({ type: 'shrink', id, max, data: new Uint8Array(bytes) });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  }).then((out) => {
    // Only take the resized copy when it actually saved something; a tiny image
    // re-encoded can come back bigger than it went in.
    if (out && out.length && out.length < bytes.length) return out;
    return bytes;
  });
}

module.exports = { shrink, accept, MAX_EDGE, isWired: () => wired };
