'use strict';
const thread = require('node:worker_threads');

// Full-file hashing has its own bounded workers. Large videos never turn a
// cleanup scan into CPU work on the capture engine's event loop.
if (!thread.isMainThread && thread.workerData?.cleanupHashWorker) {
  const fs = require('node:fs'), crypto = require('node:crypto');
  let active;
  thread.parentPort.on('message', async job => {
    if (job.cancel) { if (active?.id === job.id) active.stream.destroy(new Error('Scan stopped.')); return; }
    const stream = fs.createReadStream(job.file, { highWaterMark: 256 * 1024 });
    active = { id: job.id, stream };
    const hash = crypto.createHash('sha256'); let bytes = 0, announced = 0;
    try {
      for await (const chunk of stream) {
        hash.update(chunk); bytes += chunk.length;
        if (bytes - announced >= 4 * 1024 * 1024) { thread.parentPort.postMessage({ id: job.id, bytes: bytes - announced }); announced = bytes; }
      }
      thread.parentPort.postMessage({ id: job.id, bytes: bytes - announced, hash: hash.digest('hex') });
    } catch (error) { thread.parentPort.postMessage({ id: job.id, error: error.message }); }
    finally { active = null; }
  });
} else {
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const cfg = require('../config'), paths = require('../paths'), store = require('../store'), ai = require('../ai/store');
const QUARANTINE_DIR = path.join(paths.APP_HOME, 'quarantine');
const MANIFEST = path.join(QUARANTINE_DIR, 'manifest.ndjson');
const HASH_CACHE = path.join(cfg.DATA_DIR || paths.DATA_DIR, 'cleanup-hashes.json');
const TINY_BYTES = 8 * 1024, BURST_WINDOW_MS = 10 * 60 * 1000;
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const signature = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const area = rec => rec.kind === 'video' ? 'videos' : ['image', 'sticker'].includes(rec.kind) ? 'images' : 'files';
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ').trim();
let mutationBusy = false, scanController = null, scannedGroups = [], hashSequence = 0, cacheLoaded = false;
const hashes = new Map();
let scan = { running: false, phase: 'idle', processed: 0, total: 0, bytesRead: 0, cached: 0, failed: 0, missing: 0, sharedRecords: 0, cancelled: false, groups: [], issues: [] };

function hashLane() {
  const queue = []; let worker = null, active = null;
  function finish(error, hash) {
    if (!active) return;
    const job = active; active = null; clearTimeout(job.timeout); job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(hash);
    worker?.unref(); next();
  }
  function touch() {
    clearTimeout(active?.timeout);
    if (active) active.timeout = setTimeout(() => { const old = worker; worker = null; old?.terminate(); finish(new Error('A file stopped responding. Make it available offline and retry.')); }, 60000);
  }
  function next() {
    if (active || !queue.length) return;
    active = queue.shift();
    if (active.signal?.aborted) { finish(new Error('Scan stopped.')); return; }
    if (!worker) {
      worker = new thread.Worker(__filename, { workerData: { cleanupHashWorker: true } });
      const created = worker;
      worker.on('message', message => {
        if (worker !== created || !active || message.id !== active.id) return;
        if (message.bytes) active.progress?.(message.bytes);
        touch();
        if (message.error) finish(new Error(message.error)); else if (message.hash) finish(null, message.hash);
      });
      worker.on('error', error => { if (worker === created) { worker = null; finish(error); } });
      worker.on('exit', () => { if (worker === created) { worker = null; finish(new Error('The duplicate file reader stopped. Retry the scan.')); } });
    }
    worker.ref(); touch();
    active.abort = () => worker?.postMessage({ cancel: true, id: active?.id });
    active.signal?.addEventListener('abort', active.abort, { once: true });
    worker.postMessage({ file: active.file, id: active.id });
  }
  return (file, signal, progress) => new Promise((resolve, reject) => { queue.push({ file, signal, progress, resolve, reject, id: ++hashSequence }); next(); });
}
const lanes = [hashLane(), hashLane()]; let laneIndex = 0;

async function loadHashes() {
  if (cacheLoaded) return; cacheLoaded = true;
  try { for (const [file, value] of Object.entries(JSON.parse(await fsp.readFile(HASH_CACHE, 'utf8')))) if (value && /^[a-f0-9]{64}$/.test(value.hash)) hashes.set(file, value); } catch (_) {}
}
async function saveHashes() {
  try { await fsp.mkdir(path.dirname(HASH_CACHE), { recursive: true }); const temp = HASH_CACHE + '.tmp'; await fsp.writeFile(temp, JSON.stringify(Object.fromEntries(hashes))); await fsp.rename(temp, HASH_CACHE); } catch (_) {}
}
async function hashAt(entry, { signal, force = false, progress } = {}) {
  signal?.throwIfAborted(); await loadHashes();
  const before = await fsp.stat(entry.file), key = canonical(entry.file), sig = signature(before), hit = hashes.get(key);
  if (!force && hit?.sig === sig) { if (scan.running) scan.cached++; return hit.hash; }
  const hash = await lanes[laneIndex++ % lanes.length](entry.file, signal, progress);
  const after = await fsp.stat(entry.file);
  if (signature(after) !== sig) throw new Error('File changed during reading. Retry the scan.');
  hashes.set(key, { sig, hash }); return hash;
}
async function roots() {
  const values = [path.join(paths.APP_HOME, 'media'), cfg.IMAGES_DIR, cfg.VIDEO_DIR, cfg.LOCAL_VIDEO_DIR, cfg.FILES_DIR, cfg.CLOUD_ROOT].filter(Boolean);
  return (await Promise.all(values.map(value => fsp.realpath(value).catch(() => null)))).filter(Boolean);
}
function inside(root, file) { const relative = path.relative(canonical(root), canonical(file)); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
async function filePaths(rec) {
  if (!rec.filename || path.basename(rec.filename) !== rec.filename) return [];
  const backup = require('../backup');
  let candidates;
  if (backup.pathsFor) candidates = await backup.pathsFor(rec);
  else {
    const directories = area(rec) === 'videos' ? [cfg.LOCAL_VIDEO_DIR, cfg.VIDEO_DIR] : area(rec) === 'images' ? [cfg.IMAGES_DIR] : [cfg.FILES_DIR];
    candidates = [...directories.filter(Boolean).map(dir => path.join(dir, rec.filename)), backup.cloudPathFor?.(rec)].filter(Boolean);
  }
  const allowed = await roots(), seen = new Set(), result = [];
  for (const candidate of candidates) {
    try {
      const file = await fsp.realpath(candidate), stat = await fsp.stat(file), key = canonical(file);
      if (!stat.isFile() || !allowed.some(root => inside(root, file)) || seen.has(key)) continue;
      seen.add(key); result.push({ file, stat });
    } catch (_) {}
  }
  return result;
}
function visible() { const hidden = store.hiddenIds(); return store.listRecords({}).filter(rec => !hidden.has(rec.id) && !rec.sample); }
function item(rec, keep, extra = {}) {
  return { id: rec.id, ts: rec.ts, kind: rec.kind, chat: rec.chat || '', source: rec.source || 'whatsapp', serve: rec.serve, filename: rec.filename, bytes: rec.size || 0,
    keep: keep ? { id: keep.id, serve: keep.serve, filename: keep.filename } : null, ...extra };
}
function publicGroups(groups) {
  const active = new Set(visible().map(rec => rec.id));
  return groups.map(group => {
    const units = group.units.filter(unit => unit.records.some(rec => active.has(rec.id)));
    if (units.length < 2) return null;
    const keeper = units.find(unit => unit.records.length > 1) || units[0];
    const keep = keeper.records.find(rec => active.has(rec.id));
    const removable = units.filter(unit => unit !== keeper && unit.records.length === 1).map(unit => item(unit.records[0], keep, { bytes: unit.size, duplicateHash: group.hash, exact: true }));
    return removable.length ? { hash: group.hash, keeper: item(keep), items: removable, copies: units.length, count: removable.length, bytes: removable.reduce((sum, rec) => sum + rec.bytes, 0) } : null;
  }).filter(Boolean);
}
function exactStatus() { return { ...scan, groups: publicGroups(scannedGroups), issues: scan.issues.slice(-25) }; }
function scanExact({ force = false } = {}) {
  if (scan.running) return { ok: true, alreadyRunning: true };
  if (mutationBusy) return { ok: false, error: 'Wait for the current cleanup action to finish.' };
  const records = visible(); scannedGroups = []; scanController = new AbortController(); const signal = scanController.signal;
  scan = { running: true, phase: 'locating', processed: 0, total: records.length, records: records.length, bytesRead: 0, cached: 0, failed: 0, missing: 0, sharedRecords: 0, cancelled: false, startedAt: Date.now(), groups: [], issues: [] };
  (async () => {
    try {
      const units = [], pathOwners = new Map();
      for (const record of records) {
        signal.throwIfAborted(); const files = await filePaths(record); scan.processed++;
        if (!files.length) { scan.missing++; continue; }
        const keys = files.flatMap(entry => [canonical(entry.file), ...(entry.stat.nlink > 1 && entry.stat.ino ? [`inode:${entry.stat.dev}:${entry.stat.ino}`] : [])]);
        const owners = [...new Set(keys.map(key => pathOwners.get(key)).filter(Boolean))];
        let unit = owners[0];
        if (!unit) { unit = { records: [], files: [], size: files[0].stat.size, merged: false }; units.push(unit); }
        for (const other of owners.slice(1)) { if (other === unit) continue; unit.records.push(...other.records); unit.files.push(...other.files); other.merged = true; for (const [key, owner] of pathOwners) if (owner === other) pathOwners.set(key, unit); }
        unit.records.push(record);
        for (const entry of files) if (!unit.files.some(previous => canonical(previous.file) === canonical(entry.file))) unit.files.push(entry);
        for (const key of keys) pathOwners.set(key, unit);
      }
      const bySize = new Map();
      for (const unit of units.filter(value => !value.merged)) { scan.sharedRecords += Math.max(0, unit.records.length - 1); const list = bySize.get(unit.size) || []; list.push(unit); bySize.set(unit.size, list); }
      const candidates = [...bySize.values()].filter(list => list.length > 1).flat(), results = new Map();
      scan.phase = 'hashing'; scan.processed = 0; scan.total = candidates.length;
      let cursor = 0;
      await Promise.all([0, 1].map(async () => {
        while (cursor < candidates.length) {
          signal.throwIfAborted(); const unit = candidates[cursor++];
          try {
            const hash = await hashAt(unit.files[0], { signal, force, progress: bytes => { scan.bytesRead += bytes; } });
            const bucket = results.get(hash) || []; bucket.push(unit); results.set(hash, bucket);
          } catch (error) { if (signal.aborted) throw error; scan.failed++; scan.issues.push({ name: unit.records[0].filename, error: error.message }); }
          scan.processed++;
        }
      }));
      scannedGroups = [...results].filter(([, values]) => values.length > 1).map(([hash, values]) => ({ hash, units: values.sort((a, b) => (a.records[0].ts || 0) - (b.records[0].ts || 0)) }));
      scan.phase = 'complete'; await saveHashes();
    } catch (error) { scan.cancelled = signal.aborted; scan.phase = signal.aborted ? 'cancelled' : 'error'; if (!signal.aborted) { scan.failed++; scan.issues.push({ error: error.message }); } }
    finally { scan.running = false; scan.finishedAt = Date.now(); scanController = null; }
  })();
  return { ok: true, started: true };
}
function stopExact() { scanController?.abort(); return { ok: true }; }

const REASONS = {
  duplicate: { label: 'Exact duplicates', detail: 'The entire files matched in the last SHA-256 scan. Copies are rechecked before removal, and one independent copy is kept. Shared archive entries are protected.', sure: 'exact' },
  tiny: { label: 'Small images', detail: 'Under 8 KB. These may be thumbnails or small originals; review before setting aside.', sure: 'optional' },
  iterations: { label: 'Earlier tries', detail: 'Pictures ChatGPT made for the same request, before the one it ended on. The last is kept.', sure: 'likely' },
  burst: { label: 'Near-identical shots', detail: 'Described the same way by the sorting, from the same chat, minutes apart. One is kept.', sure: 'likely' },
  sticker: { label: 'Stickers', detail: 'WhatsApp stickers. Entirely your call.', sure: 'optional' },
};
async function suggest() {
  const all = visible(), claimed = new Set(), groups = {};
  const put = (reason, rec, keep, extra) => { if (!claimed.has(rec.id)) { claimed.add(rec.id); (groups[reason] ||= []).push(item(rec, keep, extra)); } };
  for (const group of publicGroups(scannedGroups)) for (const rec of group.items) {
    const original = store.get(rec.id); if (original) put('duplicate', original, store.get(group.keeper.id), { bytes: rec.bytes, duplicateHash: group.hash, exact: true });
  }
  for (const rec of all) if (['image', 'sticker'].includes(rec.kind) && rec.size > 0 && rec.size < TINY_BYTES) put('tiny', rec);
  const prompts = new Map();
  for (const rec of all) if (rec.source === 'chatgpt' && rec.generated && norm(rec.caption)) { const key = (rec.chat || '') + '\0' + norm(rec.caption); const list = prompts.get(key) || []; list.push(rec); prompts.set(key, list); }
  for (const list of prompts.values()) { list.sort((a, b) => a.ts - b.ts); for (const rec of list.slice(0, -1)) put('iterations', rec, list.at(-1)); }
  const descriptions = new Map();
  for (const rec of all) if (rec.kind === 'image') {
    const label = ai.getLabel('image', rec.id)?.label;
    if (!label?.caption) continue;
    const key = (rec.chat || '') + '\0' + norm(label.caption) + '\0' + norm((label.subjects || []).join(' '));
    const list = descriptions.get(key) || []; list.push(rec); descriptions.set(key, list);
  }
  for (const list of descriptions.values()) { list.sort((a, b) => a.ts - b.ts); let keep = list[0]; for (const rec of list.slice(1)) { if (rec.ts - keep.ts <= BURST_WINDOW_MS) put('burst', rec, keep); else keep = rec; } }
  for (const rec of all) if (rec.kind === 'sticker') put('sticker', rec);
  const out = Object.keys(REASONS).filter(reason => groups[reason]?.length).map(reason => {
    const items = groups[reason].sort((a, b) => b.ts - a.ts); return { reason, ...REASONS[reason], items, count: items.length, bytes: items.reduce((sum, rec) => sum + rec.bytes, 0) };
  });
  return { groups: out, totalBytes: out.reduce((sum, group) => sum + group.bytes, 0), totalCount: out.reduce((sum, group) => sum + group.count, 0), library: all.length, exactScan: exactStatus() };
}

function readManifest() {
  const rows = new Map();
  try { for (const line of fs.readFileSync(MANIFEST, 'utf8').split('\n')) { try { const entry = JSON.parse(line); if (entry.op === 'in') rows.set(entry.id, entry); else if (['out', 'purge'].includes(entry.op)) rows.delete(entry.id); } catch (_) {} } } catch (_) {}
  return rows;
}
async function appendManifest(entry) { await fsp.mkdir(QUARANTINE_DIR, { recursive: true }); await fsp.appendFile(MANIFEST, JSON.stringify(entry) + '\n'); }
function payloadFiles(entry) { return entry.files || [{ from: entry.from, storedName: entry.filename, bytes: entry.bytes, hash: entry.duplicateHash }]; }
function payloadPath(name) { if (typeof name !== 'string' || path.basename(name) !== name) throw new Error('Invalid quarantine filename.'); return path.join(QUARANTINE_DIR, name); }
async function destinationAllowed(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  // Resolve the deepest existing parent, so junctions cannot restore outside an archive.
  let parent = path.dirname(file), suffix = path.basename(file);
  while (true) { try { const real = await fsp.realpath(parent); const resolved = path.join(real, suffix); return (await roots()).some(root => inside(root, resolved)); } catch (_) { const next = path.dirname(parent); if (next === parent) return false; suffix = path.join(path.basename(parent), suffix); parent = next; } }
}
async function moveFile(from, to, expectedHash) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try { await fsp.link(from, to); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A different file already uses the destination name. Nothing was overwritten.');
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
  // Recheck the destination even for a same-drive link: the source may have
  // changed between the initial scan and the actual move.
  try { if (expectedHash && await hashAt({ file: to }, { force: true }) !== expectedHash) throw new Error('The copied file changed or could not be verified.'); }
  catch (failure) { await fsp.unlink(to).catch(() => {}); throw failure; }
  try { await fsp.unlink(from); }
  catch (error) { await fsp.unlink(to).catch(() => {}); throw error; }
  hashes.delete(canonical(from)); hashes.delete(canonical(to));
}
async function activeCopy(hash, excluded = new Set(), expectedSize) {
  const group = scannedGroups.find(group => group.hash === hash), hidden = store.hiddenIds();
  const size = expectedSize ?? group?.units[0]?.size;
  // After a restart, the durable per-path hash cache can verify the keeper
  // without trusting a stale in-memory group or requiring another full scan.
  const candidates = [...new Map([...(group?.units.flatMap(unit => unit.records) || []), ...visible().filter(rec => size == null || !rec.size || rec.size === size)].map(rec => [rec.id, rec])).values()];
  const checked = new Set();
  for (const rec of candidates) {
    if (hidden.has(rec.id) || excluded.has(rec.id)) continue;
    for (const entry of await filePaths(rec)) {
      if (checked.has(canonical(entry.file)) || (size != null && entry.stat.size !== size)) continue;
      checked.add(canonical(entry.file));
      try { if (await hashAt(entry) === hash) return true; } catch (_) {}
    }
  }
  return false;
}
async function quarantine(ids, reason) {
  if (mutationBusy || scan.running) return { ok: false, moved: 0, failed: [], error: 'Finish or stop the duplicate scan/current cleanup action first.' };
  mutationBusy = true;
  const selected = new Set(ids || []), done = [], failed = [], protectedIds = new Set(), records = visible();
  try {
    for (const group of scannedGroups) {
      if (!group.units.some(unit => unit.records.some(rec => selected.has(rec.id)))) continue;
      if (!await activeCopy(group.hash, selected)) {
        // Preserve one selected verified copy when the nominal keeper disappeared.
        let found = false;
        for (const unit of group.units) {
          for (const rec of unit.records) {
            if (!selected.has(rec.id)) continue;
            for (const file of await filePaths(rec)) try { if (await hashAt(file) === group.hash) { unit.records.forEach(member => protectedIds.add(member.id)); found = true; break; } } catch (_) {}
            if (found) break;
          }
          if (found) break;
        }
      }
    }
    for (const id of selected) {
      const rec = store.get(id); let manifest = null, logged = false, moved = [];
      try {
        if (!rec || store.hiddenIds().has(id)) throw new Error('This item is missing or already set aside.');
        if (protectedIds.has(id)) throw new Error('This is the last verified active copy. Keep it, or restore another copy first.');
        const key = area(rec) + '\0' + canonical(rec.filename);
        if (records.some(other => other.id !== id && area(other) + '\0' + canonical(other.filename) === key)) throw new Error('This physical file is shared by several archive entries and is protected.');
        const files = await filePaths(rec);
        if (!files.length) throw new Error('The original file is missing or its drive is offline.');
        const group = scannedGroups.find(group => group.units.some(unit => unit.records.some(record => record.id === id)));
        if (group?.units.some(unit => unit.records.length > 1 && unit.records.some(record => record.id === id))) throw new Error('This physical file is shared by several archive entries and is protected.');
        const token = crypto.createHash('sha256').update(id).digest('hex').slice(0, 16) + '-' + crypto.randomBytes(5).toString('hex');
        const planned = [];
        for (let index = 0; index < files.length; index++) {
          const hash = await hashAt(files[index]);
          if (group && hash !== group.hash) throw new Error('A copy changed since the scan. Rescan before setting it aside.');
          planned.push({ from: files[index].file, storedName: token + (index ? '-copy' + index : '') + '__' + rec.filename, bytes: files[index].stat.size, hash });
        }
        manifest = { op: 'in', id, filename: planned[0].storedName, originalFilename: rec.filename, from: planned[0].from, kind: rec.kind, bytes: rec.size || planned[0].bytes, physicalBytes: planned.reduce((sum, file) => sum + file.bytes, 0), reason: reason || '', duplicateHash: group?.hash || null, files: planned, at: Date.now() };
        // Persist recovery information before moving any copy. A crash can be
        // recovered whether a file remains at its original path or in quarantine.
        await appendManifest(manifest); logged = true; store.hide([id]);
        for (const file of planned) { await moveFile(file.from, payloadPath(file.storedName), file.hash); moved.push(file); }
        done.push(id);
      } catch (error) {
        let rollbackFailed = false;
        for (const file of moved.reverse()) try { await moveFile(payloadPath(file.storedName), file.from, file.hash); } catch (_) { rollbackFailed = true; }
        if (logged && !rollbackFailed) {
          try { await appendManifest({ op: 'out', id, at: Date.now() }); store.unhide([id]); }
          catch (_) { rollbackFailed = true; }
        }
        failed.push({ id, error: rollbackFailed ? 'Some copies remain set aside after an interrupted move. Use Restore to recover them.' : error.message });
      }
    }
    return { ok: true, moved: done.length, failed };
  } finally { mutationBusy = false; }
}
async function restore(ids) {
  if (mutationBusy) return { ok: false, restored: 0, failed: [], error: 'Wait for the current cleanup action.' };
  mutationBusy = true; const rows = readManifest(), done = [], failed = [];
  try {
    for (const id of [...new Set(ids || [])]) {
      const entry = rows.get(id), rec = store.get(id);
      try {
        if (!entry || !rec) throw new Error('This item is not set aside.');
        const plans = [];
        for (const file of payloadFiles(entry)) {
          const destination = file.from || path.join(area(rec) === 'videos' ? cfg.VIDEO_DIR : area(rec) === 'images' ? cfg.IMAGES_DIR : cfg.FILES_DIR, entry.originalFilename || rec.filename);
          if (!await destinationAllowed(destination)) throw new Error('The original storage folder is no longer configured. Reconnect it before restoring.');
          const source = payloadPath(file.storedName);
          let src = null, dst = null;
          try { src = await fsp.lstat(source); } catch (_) {}
          try { dst = await fsp.stat(destination); } catch (_) {}
          if (src && (!src.isFile() || src.isSymbolicLink())) throw new Error('The set-aside file is not an ordinary file. Nothing was moved.');
          if (!src && !dst) throw new Error('The set-aside file is missing. Reconnect its drive before restoring.');
          let same = false;
          if (dst) {
            if (!dst.isFile()) throw new Error('A folder occupies the original filename. Nothing was overwritten.');
            const expected = file.hash || (src ? await hashAt({ file: source }) : null);
            if (!expected || await hashAt({ file: destination }) !== expected) throw new Error('A different file uses the original name. Nothing was overwritten.');
            same = true;
          }
          plans.push({ ...file, source, destination, hasSource: !!src, same });
        }
        for (const plan of plans) {
          if (plan.same) { if (plan.hasSource) await fsp.unlink(plan.source); }
          else await moveFile(plan.source, plan.destination, plan.hash);
        }
        await appendManifest({ op: 'out', id, at: Date.now() }); store.unhide([id]); done.push(id);
      } catch (error) { failed.push({ id, error: error.message }); }
    }
    return { ok: true, restored: done.length, failed };
  } finally { mutationBusy = false; }
}
function list() {
  const rows = [...readManifest().values()].sort((a, b) => b.at - a.at);
  return { items: rows.map(entry => { const rec = store.get(entry.id); return { ...entry, chat: rec?.chat || '', serve: rec?.serve || null }; }), count: rows.length, bytes: rows.reduce((sum, entry) => sum + (entry.physicalBytes || entry.bytes || 0), 0) };
}
async function purge(ids) {
  if (mutationBusy || scan.running) return { ok: false, removed: 0, failed: [], error: 'Finish the current duplicate scan/cleanup action first.' };
  mutationBusy = true; const rows = readManifest(); let removed = 0; const failed = [];
  try {
    for (const id of [...new Set(ids || [])]) {
      const entry = rows.get(id);
      try {
        if (!entry) throw new Error('This item is not set aside.');
        const files = payloadFiles(entry);
        // A changed quarantined payload may now be unique. Check all copies
        // before permanently deleting any of them.
        for (const file of files) {
          const location = payloadPath(file.storedName); let info;
          try { info = await fsp.lstat(location); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('A set-aside payload is not an ordinary file. Restore/review it before deleting.');
          if (file.hash && await hashAt({ file: location }, { force: true }) !== file.hash) throw new Error('A set-aside file changed. Restore/review it instead of deleting it.');
        }
        if (entry.duplicateHash && !await activeCopy(entry.duplicateHash, new Set(), payloadFiles(entry)[0]?.bytes)) throw new Error('The kept copy is no longer available. Restore this copy instead of deleting it.');
        for (const file of files) await fsp.unlink(payloadPath(file.storedName)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await appendManifest({ op: 'purge', id, at: Date.now() }); removed++;
      } catch (error) { failed.push({ id, error: error.message }); }
    }
    return { ok: true, removed, failed };
  } finally { mutationBusy = false; }
}
module.exports = { suggest, quarantine, restore, list, purge, scanExact, exactStatus, stopExact, REASONS, QUARANTINE_DIR };
}
