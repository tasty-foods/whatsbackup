'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const cleanHeader = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 4000);
function decodeHeader(value) {
  return cleanHeader(String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (all, charset, type, encoded) => {
    try {
      const bytes = type.toLowerCase() === 'b' ? Buffer.from(encoded, 'base64') : Buffer.from(encoded.replace(/_/g, ' ').replace(/=([a-f0-9]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary');
      return new TextDecoder(charset).decode(bytes);
    } catch (_) { return all; }
  }));
}
const header = (part, name) => decodeHeader((part?.headers || []).find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value);
function attachments(payload) {
  const out = [], stack = [{ part: payload, address: '0', depth: 0 }]; let visited = 0;
  while (stack.length) {
    const { part, address, depth } = stack.pop();
    if (!part || typeof part !== 'object') continue;
    if (++visited > 10000 || depth > 50) throw new Error('This email has too many nested MIME parts to import safely.');
    const mime = String(part.mimeType || 'application/octet-stream').toLowerCase().split(';')[0];
    const disposition = header(part, 'content-disposition');
    const named = typeof part.filename === 'string' && !!part.filename.trim();
    const inlineMedia = /^(image|video|audio)\//.test(mime);
    if ((named || /^attachment\b/i.test(disposition) || inlineMedia) && (part.body?.attachmentId || typeof part.body?.data === 'string')) {
      out.push({ partId: String(part.partId || address), attachmentId: part.body.attachmentId ? String(part.body.attachmentId) : null, filename: named ? decodeHeader(part.filename) : 'attachment-' + address + extensionFor(mime), mime, size: Number(part.body.size) || 0, data: part.body.data });
    }
    if (Array.isArray(part.parts)) for (let i = part.parts.length - 1; i >= 0; i--) stack.push({ part: part.parts[i], address: address + '.' + i, depth: depth + 1 });
  }
  return out;
}
function extensionFor(mime) {
  return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif', 'image/avif': '.avif', 'image/tiff': '.tif', 'image/bmp': '.bmp', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf', 'text/plain': '.txt', 'application/zip': '.zip' })[mime] || '.bin';
}
function safeName(value, mime) {
  let name = path.posix.basename(String(value || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[ .]+$/g, '').trim();
  if (!name || /^\.+$/.test(name)) name = 'attachment' + extensionFor(mime);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  const ext = path.extname(name).slice(0, 16); name = path.basename(name, path.extname(name)).slice(0, 90) + ext;
  // Store executable attachments as inert downloads. Never launch/import code.
  if (/\.(exe|com|bat|cmd|ps1|vbs|js|msi|scr|lnk|url|hta)$/i.test(name)) name += '.download';
  return name;
}
function mediaKind(mime, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (/^image\//.test(mime) && !['image/svg+xml', 'image/svg'].includes(mime) || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff', '.bmp'].includes(ext)) return 'image';
  if (/^video\//.test(mime) || ['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.3gp'].includes(ext)) return 'video';
  if (/^audio\//.test(mime) || ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)) return 'audio';
  return 'document';
}
const recordId = (account, messageId, partId) => 'gmail_' + crypto.createHash('sha256').update([account.toLowerCase(), messageId, partId].join('\0')).digest('hex');
function provenance(message, account, part, now = Date.now()) {
  const raw = Number(message.internalDate), dated = Date.parse(header(message.payload, 'date'));
  const ts = Number.isFinite(raw) && raw > 0 && raw < 8640000000000000 ? raw : Number.isFinite(dated) ? dated : now;
  return { gmailAccount: account, gmailMessageId: String(message.id || ''), gmailThreadId: String(message.threadId || ''), gmailPartId: part.partId, gmailAttachmentId: part.attachmentId, sender: header(message.payload, 'from'), subject: header(message.payload, 'subject'), originalTimestamp: ts, originalFilename: part.filename, mimetype: part.mime };
}
module.exports = { header, decodeHeader, attachments, safeName, mediaKind, recordId, provenance };
