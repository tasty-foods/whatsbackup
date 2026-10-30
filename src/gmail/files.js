'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const nextTurn = () => new Promise(setImmediate);
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
async function saveAttachment({ data, directory, filename, limitBytes, declaredSize, signal }) {
  if (typeof data !== 'string' || !data) throw new Error('The attachment contains no readable file data.');
  if (data.length > Math.ceil(limitBytes / 3) * 4 + 4) throw new Error('Attachment exceeds the configured size limit.');
  if (data.length % 4 === 1) throw new Error('The attachment has invalid base64url data.');
  if (path.basename(filename) !== filename) throw new Error('Invalid attachment filename.');
  await fsp.mkdir(directory, { recursive: true });
  const target = path.join(directory, filename), temporary = target + '.' + crypto.randomBytes(6).toString('hex') + '.gmail-part';
  let handle, bytes = 0; const hash = crypto.createHash('sha256');
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    for (let offset = 0; offset < data.length; offset += 65536) {
      signal?.throwIfAborted();
      const encoded = data.slice(offset, offset + 65536);
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) || (encoded.includes('=') && offset + encoded.length !== data.length)) throw new Error('The attachment has invalid base64url data.');
      const chunk = Buffer.from(encoded, 'base64url'); bytes += chunk.length;
      if (bytes > limitBytes) throw new Error('Attachment exceeds the configured size limit.');
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) { const result = await handle.write(chunk, written, chunk.length - written); if (!result.bytesWritten) throw new Error('The attachment could not be written completely.'); written += result.bytesWritten; }
      await nextTurn();
    }
    if (Number.isFinite(declaredSize) && declaredSize >= 0 && bytes !== declaredSize) throw new Error('Attachment size did not match Gmail metadata. Retry this file.');
    await handle.close(); handle = null;
    signal?.throwIfAborted();
    return { temporary, target, hash: hash.digest('hex'), size: bytes };
  } catch (error) { try { await handle?.close(); } catch (_) {} await fsp.unlink(temporary).catch(() => {}); throw error; }
}
async function commitAttachment(prepared, signal) {
  signal?.throwIfAborted();
  try { await fsp.copyFile(prepared.temporary, prepared.target, fs.constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await hashFile(prepared.target, signal) !== prepared.hash) throw new Error('A different file already occupies the attachment path. Your existing file was preserved.');
  }
  if (await hashFile(prepared.target, signal) !== prepared.hash) throw new Error('The saved attachment failed its content check. Retry this file.');
  return prepared.target;
}
module.exports = { hashFile, saveAttachment, commitAttachment };
