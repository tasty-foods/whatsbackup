'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createOrganizer } = require('../src/cloud-organizer');
const { cloudRelative } = require('../src/storage-layout');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-cloud-folders-'));
  const cfg = { CLOUD_ROOT: path.join(root, 'cloud'), DATA_DIR: path.join(root, 'data'), CLOUD_LAYOUT: 'flat' };
  fs.mkdirSync(cfg.CLOUD_ROOT); fs.mkdirSync(cfg.DATA_DIR);
  const records = [], writes = [];
  const api = createOrganizer({ cfg, store: { listRecords: () => records }, backup: { statusBusy: () => false }, settings: { write: patch => writes.push(patch) } });
  const file = (rec, layout) => path.join(cfg.CLOUD_ROOT, cloudRelative(rec, layout));
  function add(id, kind = 'image', source = 'whatsapp', filename = id + '.png', contents = 'original contents') {
    const rec = { id, kind, source, filename, docName: filename, ts: Date.UTC(2026, 9, 29), size: Buffer.byteLength(contents) };
    records.push(rec);
    const old = file(rec, 'flat'); fs.mkdirSync(path.dirname(old), { recursive: true });
    if (!fs.existsSync(old)) fs.writeFileSync(old, contents);
    return rec;
  }
  async function finish() {
    const until = Date.now() + 10000;
    while (api.status().running && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(api.status().running, false); return api.status();
  }
  t.after(async () => {
    api.stop(); await finish();
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('whatsbackup-cloud-folders-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, cfg, api, records, writes, add, file, finish };
}

test('cloud organization previews source/month/type folders, moves bytes unchanged, and reverses every move', async t => {
  const f = fixture(t), image = f.add('image'), document = f.add('document', 'document', 'gmail', 'invoice.pdf'), video = f.add('video', 'video', 'googlephotos', 'clip.mp4');
  const originals = f.records.map(rec => ({ ...rec }));
  const preview = await f.api.preview(); assert.equal(preview.count, 3); assert.equal(preview.conflicts, 0);
  assert.equal(f.file(document, 'source-date'), path.join(f.cfg.CLOUD_ROOT, 'Gmail', '2026-10', 'Documents', 'invoice.pdf'));
  assert.equal(f.file(video, 'source-date'), path.join(f.cfg.CLOUD_ROOT, 'Google Photos', '2026-10', 'Videos', 'clip.mp4'));
  assert.equal(f.api.start().ok, true); const organized = await f.finish(); assert.equal(organized.done, 3); assert.equal(organized.failed, 0); assert.equal(organized.canUndo, true);
  for (const rec of [image, document, video]) { assert.equal(fs.existsSync(f.file(rec, 'flat')), false); assert.equal(fs.readFileSync(f.file(rec, 'source-date'), 'utf8'), 'original contents'); }
  assert.deepEqual(f.records, originals); assert.equal(f.cfg.CLOUD_LAYOUT, 'source-date');
  assert.equal(f.api.undo().ok, true); const undone = await f.finish(); assert.equal(undone.done, 3); assert.equal(undone.canUndo, false);
  for (const rec of f.records) { assert.equal(fs.readFileSync(f.file(rec, 'flat'), 'utf8'), 'original contents'); assert.equal(fs.existsSync(f.file(rec, 'source-date')), false); }
});

test('existing destinations and shared-file records with different target metadata are left unchanged', async t => {
  const f = fixture(t), existing = f.add('existing'), shared = f.add('shared', 'document', 'gmail', 'shared.pdf');
  f.add('shared-alias', 'document', 'whatsapp', 'shared.pdf');
  fs.mkdirSync(path.dirname(f.file(existing, 'source-date')), { recursive: true }); fs.writeFileSync(f.file(existing, 'source-date'), 'different destination');
  const preview = await f.api.preview(); assert.equal(preview.count, 0); assert.equal(preview.conflicts, 2);
  f.api.start(); const result = await f.finish(); assert.equal(result.done, 0);
  assert.equal(fs.readFileSync(f.file(existing, 'flat'), 'utf8'), 'original contents');
  assert.equal(fs.readFileSync(f.file(existing, 'source-date'), 'utf8'), 'different destination');
  assert.equal(fs.readFileSync(f.file(shared, 'flat'), 'utf8'), 'original contents');
});

test('organize and undo preserve the original file modification time for older archived media', async t => {
  const f = fixture(t), rec = f.add('old-photo');
  const original = f.file(rec, 'flat'), timestamp = new Date('2019-03-14T11:22:33.000Z');
  fs.utimesSync(original, timestamp, timestamp);
  const originalTime = fs.statSync(original).mtimeMs;
  f.api.start(); const organized = await f.finish(); assert.equal(organized.done, 1); assert.equal(organized.failed, 0);
  assert.ok(Math.abs(fs.statSync(f.file(rec, 'source-date')).mtimeMs - originalTime) <= 2);
  f.api.undo(); const undone = await f.finish(); assert.equal(undone.done, 1); assert.equal(undone.failed, 0);
  assert.ok(Math.abs(fs.statSync(original).mtimeMs - originalTime) <= 2);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original contents');
});

test('undo recovers an identical partial copy when preserving its timestamp failed', async t => {
  const f = fixture(t), rec = f.add('timestamp-failure'), originalTime = new Date('2018-01-02T03:04:05.000Z');
  fs.utimesSync(f.file(rec, 'flat'), originalTime, originalTime);
  const utimes = fs.promises.utimes;
  fs.promises.utimes = async (...args) => { if (args[0] === f.file(rec, 'source-date')) throw Object.assign(Error('timestamp unavailable'), { code: 'EACCES' }); return utimes.apply(fs.promises, args); };
  try {
    f.api.start(); const failed = await f.finish(); assert.equal(failed.done, 0); assert.equal(failed.failed, 1); assert.equal(failed.canUndo, true);
    assert.equal(fs.existsSync(f.file(rec, 'flat')), true); assert.equal(fs.existsSync(f.file(rec, 'source-date')), true);
  } finally { fs.promises.utimes = utimes; }
  f.api.undo(); const recovered = await f.finish(); assert.equal(recovered.done, 1); assert.equal(recovered.failed, 0);
  assert.equal(fs.existsSync(f.file(rec, 'source-date')), false); assert.equal(fs.readFileSync(f.file(rec, 'flat'), 'utf8'), 'original contents');
  assert.ok(Math.abs(fs.statSync(f.file(rec, 'flat')).mtimeMs - originalTime.getTime()) <= 2);
});

test('shared-file records with the same destination move one file without rewriting record metadata', async t => {
  const f = fixture(t), rec = f.add('one', 'document', 'gmail', 'shared.pdf'); f.add('two', 'document', 'gmail', 'shared.pdf');
  const preview = await f.api.preview(); assert.equal(preview.count, 1); assert.equal(preview.conflicts, 0);
  f.api.start(); assert.equal((await f.finish()).done, 1);
  assert.equal(fs.readFileSync(f.file(rec, 'source-date'), 'utf8'), 'original contents'); assert.equal(f.records.length, 2); assert.equal(f.records[1].filename, rec.filename);
});

test('a destination created while the move journal is written is never overwritten', async t => {
  const f = fixture(t), rec = f.add('race'), original = fs.promises.appendFile;
  fs.promises.appendFile = async (...args) => {
    const result = await original.apply(fs.promises, args);
    if (String(args[0]).endsWith('cloud-folder-moves.ndjson')) fs.writeFileSync(f.file(rec, 'source-date'), 'arrived during move');
    return result;
  };
  try {
    f.api.start(); const result = await f.finish();
    assert.equal(fs.readFileSync(f.file(rec, 'source-date'), 'utf8'), 'arrived during move');
    assert.equal(fs.readFileSync(f.file(rec, 'flat'), 'utf8'), 'original contents');
    assert.equal(result.done, 0); assert.equal(result.failed, 1);
  } finally { fs.promises.appendFile = original; }
});

test('organizing through a destination junction never writes directories outside the selected cloud root', async t => {
  const f = fixture(t), rec = f.add('junction'), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(f.cfg.CLOUD_ROOT, 'WhatsApp'), process.platform === 'win32' ? 'junction' : 'dir');
  f.api.start(); const result = await f.finish(); assert.equal(result.done, 0); assert.equal(result.failed, 1);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(f.file(rec, 'flat'), 'utf8'), 'original contents');
});

test('an undo with an unavailable moved file retains recovery history instead of claiming success', async t => {
  const f = fixture(t), rec = f.add('missing'); f.api.start(); assert.equal((await f.finish()).done, 1);
  const moved = f.file(rec, 'source-date'), temporarilyElsewhere = moved + '.temporarily-unavailable'; fs.renameSync(moved, temporarilyElsewhere);
  f.api.undo(); const result = await f.finish(); assert.equal(result.done, 0); assert.equal(result.failed, 1); assert.equal(result.canUndo, true);
  assert.equal(fs.existsSync(path.join(f.cfg.DATA_DIR, 'cloud-folder-moves.ndjson')), true);
  fs.renameSync(temporarilyElsewhere, moved);
  f.api.undo(); assert.equal((await f.finish()).done, 1); assert.equal(fs.readFileSync(f.file(rec, 'flat'), 'utf8'), 'original contents');
});

test('undo never removes an outside-root file through a source junction even when the original destination matches', async t => {
  const f = fixture(t), rec = f.add('undo-junction'); f.api.start(); assert.equal((await f.finish()).done, 1);
  const organized = f.file(rec, 'source-date'), outside = path.join(f.root, 'outside-undo');
  fs.renameSync(path.dirname(organized), outside);
  fs.symlinkSync(outside, path.dirname(organized), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.dirname(f.file(rec, 'flat')), { recursive: true }); fs.copyFileSync(path.join(outside, rec.filename), f.file(rec, 'flat'));
  f.api.undo(); const result = await f.finish();
  assert.equal(result.done, 0); assert.equal(result.failed, 1);
  assert.equal(fs.existsSync(path.join(outside, rec.filename)), true);
  assert.equal(fs.readFileSync(f.file(rec, 'flat'), 'utf8'), 'original contents');
});

test('a legacy cloud video is not labelled a separate PC copy when an organized cloud copy also exists', async t => {
  const { locate } = require('../src/media-locations');
  const root = path.resolve(os.tmpdir(), 'cloud-location-fixture'), legacy = path.join(root, 'Videos', 'clip.mp4'), organized = path.join(root, 'WhatsApp', '2026-10', 'Videos', 'clip.mp4');
  const result = await locate({}, { backup: { localPathFor: async () => legacy, cloudPathFor: () => organized, existingCloudPathFor: async () => organized, cloudPathsFor: () => [organized, legacy] } });
  assert.equal(result.local, null); assert.equal(result.cloud, organized); assert.equal(result.preferred, organized);
});
