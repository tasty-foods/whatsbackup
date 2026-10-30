'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { mediaType, hashFile } = require('./download');
const MAX_FILES = 250000;
const MAX_DIRECTORIES = 50000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };

async function validateFolder(folder, excluded = []) {
  if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder) || folder.includes('\0')) throw new Error('Choose an extracted Google Photos Takeout folder.');
  let root;
  try { root = await fs.realpath(folder); if (!(await fs.stat(root)).isDirectory()) throw Error(); }
  catch (_) { throw new Error('This Takeout folder is unavailable. Extract the downloaded ZIP files and choose their folder.'); }
  if (path.parse(root).root === root) throw new Error('Choose the extracted Takeout folder, not an entire drive.');
  for (const entry of excluded.filter(Boolean)) {
    const other = await fs.realpath(entry).catch(() => path.resolve(entry));
    if (inside(root, other) || inside(other, root)) throw new Error('Choose a Takeout folder outside WhatsBackUp’s media and app-data folders.');
  }
  return root;
}

async function* walkMedia(root, { signal, onProgress = () => {} } = {}) {
  const pending = [root];
  let files = 0, directories = 0, ignored = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    if (++directories > MAX_DIRECTORIES) throw new Error('The folder contains too many subfolders. Import individual Takeout parts instead.');
    // Refuse junctions that changed after enumeration as well as symbolic links.
    const actual = await fs.realpath(directory);
    if (!inside(root, actual) || (await fs.lstat(directory)).isSymbolicLink()) { ignored++; continue; }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const sidecars = entries.filter(e => e.isFile() && /\.json$/i.test(e.name)).map(e => e.name);
    const children = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) { ignored++; continue; }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { children.push(file); continue; }
      if (!entry.isFile()) continue;
      let type;
      try { type = mediaType(entry.name); } catch (_) { ignored++; continue; }
      if (++files > MAX_FILES) throw new Error('The folder contains more than 250,000 media files. Import individual Takeout parts instead.');
      onProgress({ found: files, directories, ignored });
      yield { file, name: entry.name, directory, sidecars, ...type };
    }
    // Canonical year folders usually carry the original metadata. Visit them
    // before album copies so deduplication retains that original date.
    const priority = file => /^(?:(?:Photos from|Fotos von|Foto['’]s uit|Photos de) )?\d{4}$/i.test(path.basename(file)) ? 0 : 1;
    children.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    pending.push(...children.reverse());
  }
  onProgress({ found: files, directories, ignored });
}

async function readMetadata(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES) return null;
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Keep only the fields used by this importer; exports may contain account,
    // location and people metadata that is unnecessary for the archive index.
    return {
      title: typeof value.title === 'string' ? value.title.slice(0, 1000) : '',
      description: typeof value.description === 'string' ? value.description.slice(0, 3000) : '',
      photoTakenTime: { timestamp: value.photoTakenTime?.timestamp }, creationTime: { timestamp: value.creationTime?.timestamp },
    };
  } catch (_) { return null; }
}

function metadataReader() {
  let directory = '', indexed = null;
  return async item => {
    const duplicate = item.name.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
    const names = [item.name + '.json', item.name + '.supplemental-metadata.json'];
    if (duplicate) names.push(`${duplicate[1]}${duplicate[3]}(${duplicate[2]}).json`, `${duplicate[1]}${duplicate[3]}(${duplicate[2]}).supplemental-metadata.json`);
    for (const name of names) { const value = await readMetadata(path.join(item.directory, name)); if (value) return value; }
    // Some Takeout releases truncate sidecar names. Match their original title,
    // retaining only one directory's small lookup at a time.
    if (directory !== item.directory) { directory = item.directory; indexed = null; }
    if (!indexed) {
      indexed = new Map();
      for (const name of item.sidecars) {
        const value = await readMetadata(path.join(directory, name));
        if (value && typeof value.title === 'string' && !indexed.has(value.title)) indexed.set(value.title, value);
      }
    }
    return indexed.get(item.name) || null;
  };
}

function takenTime(metadata, fallback) {
  for (const entry of [metadata?.photoTakenTime, metadata?.creationTime]) {
    const raw = entry?.timestamp;
    const seconds = ((typeof raw === 'string' && raw.trim()) || typeof raw === 'number') ? Number(raw) : NaN;
    if (Number.isFinite(seconds) && Math.abs(seconds) < 8640000000000) return { ts: seconds * 1000, dateSource: 'googlephotos' };
  }
  return { ts: Number.isFinite(fallback) && fallback > 0 ? fallback : Date.now(), dateSource: 'file' };
}

async function inspectFile(item, root, signal) {
  const actual = await fs.realpath(item.file);
  if (!inside(root, actual) || (await fs.lstat(item.file)).isSymbolicLink()) throw new Error('A file points outside the selected Takeout folder.');
  const stat = await fs.stat(actual);
  if (!stat.isFile() || !stat.size) throw new Error('An exported media file is empty or unavailable.');
  const handle = await fs.open(actual, 'r');
  try {
    const bytes = Buffer.alloc(256), read = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, read.bytesRead);
    if (/^\s*(?:<!doctype|<html)/i.test(head.toString()) || head.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new Error('An exported media file contains a web page or ZIP. Extract the Takeout archive first.');
  } finally { await handle.close(); }
  return { file: actual, size: stat.size, mtimeMs: stat.mtimeMs, hash: await hashFile(actual, signal) };
}

async function copyOriginal(original, target, signal) {
  try {
    await fs.stat(target);
    if (await hashFile(target, signal) !== original.hash) throw new Error('An archive filename already contains different bytes. The existing file was kept; check the media folder.');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = target + '.takeout-' + randomUUID() + '.part';
  try {
    await fs.copyFile(original.file, temporary, constants.COPYFILE_EXCL);
    if ((await fs.stat(temporary)).size !== original.size || await hashFile(temporary, signal) !== original.hash) throw new Error('An exported file changed while copying. Retry this folder.');
    signal?.throwIfAborted();
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

module.exports = { validateFolder, walkMedia, metadataReader, takenTime, inspectFile, copyOriginal, MAX_FILES };
