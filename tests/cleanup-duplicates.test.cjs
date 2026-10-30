'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-cleanup-'));
  const cfg = { DATA_DIR: path.join(root, 'data'), CLOUD_ROOT: path.join(root, 'cloud'), IMAGES_DIR: path.join(root, 'media/images'), LOCAL_VIDEO_DIR: path.join(root, 'media/videos'), FILES_DIR: path.join(root, 'media/files') };
  cfg.VIDEO_DIR = path.join(cfg.CLOUD_ROOT, 'Videos');
  for (const directory of Object.values(cfg)) fs.mkdirSync(directory, { recursive: true });
  const records = [], hidden = new Set();
  const store = { listRecords: () => records.filter(rec => !hidden.has(rec.id)), get: id => records.find(rec => rec.id === id), hiddenIds: () => new Set(hidden), hide: ids => ids.forEach(id => hidden.add(id)), unhide: ids => ids.forEach(id => hidden.delete(id)) };
  const local = rec => path.join(rec.kind === 'video' ? cfg.LOCAL_VIDEO_DIR : ['image', 'sticker'].includes(rec.kind) ? cfg.IMAGES_DIR : cfg.FILES_DIR, rec.filename);
  const cloud = rec => path.join(cfg.CLOUD_ROOT, rec.kind === 'video' ? 'Videos' : ['image', 'sticker'].includes(rec.kind) ? 'Images' : 'Files', rec.filename);
  function load() {
    const filename = path.resolve(__dirname, '../src/cleanup/index.js');
    const sandbox = { module: { exports: {} }, __filename: filename, __dirname: path.dirname(filename), process, console, Buffer, AbortController, setTimeout, clearTimeout, setImmediate,
      require: name => name === '../config' ? cfg : name === '../paths' ? { APP_HOME: root, DATA_DIR: cfg.DATA_DIR } : name === '../store' ? store : name === '../ai/store' ? { getLabel: () => null } : name === '../backup' ? { pathsFor: rec => [local(rec), cloud(rec)] } : require(name) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox);
    return sandbox.module.exports;
  }
  let api = load();
  t.after(async () => {
    api.stopExact();
    for (let i = 0; api.exactStatus().running && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('whatsbackup-cleanup-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function add(id, kind = 'image', data = Buffer.alloc(20000, 1), filename = id + '.bin') {
    const rec = { id, kind, filename, size: data.length, ts: records.length + 1, serve: '/media/' + filename, chat: id }; records.push(rec);
    if (!fs.existsSync(local(rec))) fs.writeFileSync(local(rec), data);
    return rec;
  }
  function mirror(rec, data = fs.readFileSync(local(rec))) { fs.mkdirSync(path.dirname(cloud(rec)), { recursive: true }); fs.writeFileSync(cloud(rec), data); }
  async function scan(options) {
    assert.equal(api.scanExact(options).ok, true);
    const until = Date.now() + 10000;
    while (api.exactStatus().running && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    const result = api.exactStatus(); assert.equal(result.running, false); assert.equal(result.phase, 'complete'); return result;
  }
  return { root, cfg, records, hidden, local, cloud, add, mirror, scan, get api() { return api; }, reload: () => { api = load(); return api; } };
}

test('full-file hashes distinguish matching headers and find exact copies across photos, videos and documents', async t => {
  const f = fixture(t), bytes = Buffer.alloc(25000, 1), different = Buffer.from(bytes); different[different.length - 1] = 2;
  f.add('photo', 'image', bytes); f.add('document', 'document', bytes); f.add('video', 'video', bytes); f.add('same-header', 'image', different);
  const missing = f.add('missing', 'document', bytes); fs.unlinkSync(f.local(missing));
  let yielded = false; setImmediate(() => { yielded = true; });
  const result = await f.scan();
  assert.equal(yielded, true); assert.equal(result.groups.length, 1); assert.equal(result.groups[0].copies, 3);
  assert.deepEqual(Array.from(result.groups[0].items, rec => rec.id).sort(), ['document', 'video']);
  assert.equal(result.groups[0].keeper.id, 'photo'); assert.equal(result.missing, 1);
  const suggested = await f.api.suggest(); assert.equal(suggested.groups.find(group => group.reason === 'duplicate').sure, 'exact');
  const cached = await f.scan(); assert.ok(cached.cached >= 4); assert.equal(cached.bytesRead, 0);
  fs.writeFileSync(f.local(f.records[1]), different);
  const changed = await f.scan(); assert.equal(changed.groups[0].copies, 2); assert.ok(changed.bytesRead > 0);
});

test('shared filename records are one physical unit and cannot move each other’s file', async t => {
  const f = fixture(t), one = f.add('one', 'document', Buffer.alloc(20000, 9), 'shared.pdf');
  f.add('alias', 'document', Buffer.alloc(20000, 9), 'shared.pdf');
  const copy = f.add('copy', 'document', Buffer.alloc(20000, 9));
  const result = await f.scan();
  assert.equal(result.sharedRecords, 1); assert.equal(result.groups.length, 1); assert.equal(result.groups[0].copies, 2);
  assert.deepEqual(Array.from(result.groups[0].items, rec => rec.id), ['copy']);
  const blocked = await f.api.quarantine(['one', 'alias'], 'duplicate'); assert.equal(blocked.moved, 0); assert.equal(blocked.failed.length, 2);
  assert.equal(fs.existsSync(f.local(one)), true); assert.equal(f.hidden.size, 0);
  assert.equal((await f.api.quarantine([copy.id], 'duplicate')).moved, 1);
  assert.equal(fs.existsSync(f.local(one)), true);
});

test('setting aside every duplicate preserves a keeper and restores all local/cloud copies without overwriting collisions', async t => {
  const f = fixture(t), keeper = f.add('keeper', 'document'), copy = f.add('copy', 'document'); f.mirror(copy);
  await f.scan();
  const moved = await f.api.quarantine([keeper.id, copy.id], 'duplicate');
  assert.equal(moved.moved, 1); assert.equal(moved.failed.length, 1); assert.match(moved.failed[0].error, /last verified/);
  assert.equal(fs.existsSync(f.local(keeper)), true); assert.equal(fs.existsSync(f.local(copy)), false); assert.equal(fs.existsSync(f.cloud(copy)), false);
  const entry = f.api.list().items[0]; assert.equal(entry.files.length, 2); assert.equal(entry.originalFilename, copy.filename);
  fs.writeFileSync(f.local(copy), 'different content');
  const collision = await f.api.restore([copy.id]); assert.equal(collision.restored, 0); assert.match(collision.failed[0].error, /different file/);
  assert.equal(fs.readFileSync(f.local(copy), 'utf8'), 'different content');
  fs.unlinkSync(f.local(copy));
  const restored = await f.api.restore([copy.id]); assert.equal(restored.restored, 1);
  assert.deepEqual(fs.readFileSync(f.local(copy)), fs.readFileSync(f.cloud(copy))); assert.equal(f.hidden.has(copy.id), false);
});

test('a missing keeper protects the remaining active copy and prevents purging the last recoverable duplicate', async t => {
  const f = fixture(t), keeper = f.add('keeper'), copy = f.add('copy');
  await f.scan(); fs.unlinkSync(f.local(keeper));
  assert.equal((await f.api.quarantine([copy.id], 'duplicate')).moved, 0);
  fs.writeFileSync(f.local(keeper), Buffer.alloc(20000, 1));
  assert.equal((await f.api.quarantine([copy.id], 'duplicate')).moved, 1);
  fs.unlinkSync(f.local(keeper));
  const denied = await f.api.purge([copy.id]); assert.equal(denied.removed, 0); assert.match(denied.failed[0].error, /kept copy/);
  assert.equal((await f.api.restore([copy.id])).restored, 1);
});

test('duplicate quarantine survives a module restart, and a verified active keeper permits explicit purge', async t => {
  const f = fixture(t), keeper = f.add('keeper', 'video'), copy = f.add('copy', 'video');
  await f.scan(); assert.equal((await f.api.quarantine([copy.id], 'duplicate')).moved, 1);
  f.reload();
  const removed = await f.api.purge([copy.id]); assert.equal(removed.removed, 1); assert.equal(f.api.list().count, 0);
  assert.equal(fs.existsSync(f.local(keeper)), true); assert.equal(fs.existsSync(f.local(copy)), false);
});

test('cancelled scans do not claim completion or mutate originals', async t => {
  const f = fixture(t), one = f.add('one'), two = f.add('two');
  f.api.scanExact(); f.api.stopExact();
  const until = Date.now() + 10000;
  while (f.api.exactStatus().running && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.api.exactStatus().phase, 'cancelled'); assert.equal(f.api.exactStatus().cancelled, true);
  assert.equal(fs.existsSync(f.local(one)), true); assert.equal(fs.existsSync(f.local(two)), true); assert.equal(f.hidden.size, 0);
});

test('files changed since scanning or while set aside are not deleted as exact duplicates', async t => {
  const f = fixture(t), keeper = f.add('keeper'), copy = f.add('copy');
  await f.scan();
  fs.writeFileSync(f.local(copy), Buffer.alloc(20000, 2));
  const changed = await f.api.quarantine([copy.id], 'duplicate'); assert.equal(changed.moved, 0); assert.match(changed.failed[0].error, /changed since/);
  fs.writeFileSync(f.local(copy), Buffer.alloc(20000, 1));
  assert.equal((await f.api.quarantine([copy.id], 'duplicate')).moved, 1);
  const entry = f.api.list().items[0], payload = path.join(f.api.QUARANTINE_DIR, entry.filename);
  fs.writeFileSync(payload, Buffer.alloc(20000, 3));
  const purge = await f.api.purge([copy.id]); assert.equal(purge.removed, 0); assert.match(purge.failed[0].error, /changed/);
  assert.equal(fs.existsSync(payload), true); assert.equal(fs.existsSync(f.local(keeper)), true);
});
