'use strict';
// Labelling asks "what is in this picture", not "enlarge the third pixel". A
// phone photo arrives at 2048px or more, and every one of those pixels is paid
// for twice: once as input tokens at whichever provider is being billed, and
// again as time, because a vision model turns the image into patches before it
// can think about it.
//
// Measured on this project's own library with a small vision model, one
// 2048x1536 JPEG: 2048 wide → 4046 prompt tokens; 1024 wide → 1067. And 512,
// 768 and 1024 all cost the same 1067, because the model normalises to a fixed
// patch budget until the image is big enough to cross into another band. So
// 1024 is the free end of that band: the smallest token bill with the most
// detail left for reading a price list or an article code.
//
// The resize itself needs an image decoder, which the engine does not have;
// see src/imaging.js for where it comes from.
const imaging = require('../imaging');

const MAX_EDGE = 1024;

// Returns the smaller JPEG, or the original buffer if nothing can help.
// Never throws: a labelling run must not die because a resize did.
async function shrink(bytes, max = MAX_EDGE) {
  try {
    const out = await imaging.resize(bytes, max);
    // Only take the resized copy when it actually saved something; a tiny
    // image re-encoded can come back bigger than it went in.
    if (out && out.length && out.length < bytes.length) return out;
  } catch (_) {}
  return bytes;
}

module.exports = { shrink, MAX_EDGE, accept: require('../shell').accept, isWired: imaging.hasShell };
