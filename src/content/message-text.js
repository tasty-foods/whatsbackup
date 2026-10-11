'use strict';
// Some WhatsApp image messages put thumbnail bytes in body instead of a caption.
// Keep readable captions; never send those bytes to text search, transcripts or AI.
module.exports = value => {
  const text = typeof value === 'string' ? value : '';
  return text.length > 128 && /^(?:data:image\/[^;]+;base64,|\/9j\/|iVBORw0KGgo|R0lGOD)/.test(text.trimStart()) ? '' : text;
};
