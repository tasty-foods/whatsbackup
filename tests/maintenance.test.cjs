// "Remove sample images" and the reset command work on the index of
// everything saved. They must never cost a record they were not asked to
// remove — least of all because one line of the file could not be read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHome(lines, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-maintenance-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'media', 'images'), { recursive: true });
  const index = path.join(root, 'data', 'index.ndjson');
  fs.writeFileSync(index, lines.join('\n') + '\n');
  for (const name of files) fs.writeFileSync(path.join(root, 'media', 'images', name), 'picture');
  process.env.WB_HOME = root;
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/]/.test(k)) delete require.cache[k];
  const store = require('../src/store');
  store.ensureDirs(); store.loadAll();
  const maintenance = require('../src/maintenance');
  const onDisk = () => fs.readFileSync(index, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).id).sort();
  const image = (name) => fs.existsSync(path.join(root, 'media', 'images', name));
  return { root, index, store, maintenance, onDisk, image, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const rec = (id, extra = {}) => JSON.stringify({ id, ts: 1700000000000 + id.length * 1000 + id.charCodeAt(id.length - 1), dir: 'in', kind: 'image', chat: 'Mum', filename: id + '.jpg', serve: '/media/images/' + id + '.jpg', size: 7, ...extra });

test('removing the samples keeps every other record, even with a damaged line in the index', () => {
  const h = freshHome([
    rec('a'), rec('b'),
    '{"id":"torn","ts":17000',                       // a write cut short by a power loss
    rec('sample_1', { sample: true }), rec('c', { kind: 'video', filename: 'c.mp4' }), rec('sample_2', { sample: true }),
  ], ['a.jpg', 'b.jpg', 'sample_1.jpg', 'sample_2.jpg']);
  assert.equal(h.store.listRecords({}).length, 5);

  assert.deepEqual(h.maintenance.clearGallery(), { removed: 2, deleted: 2, kept: 3 });

  assert.deepEqual(h.store.listRecords({}).map((r) => r.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(h.onDisk(), ['a', 'b', 'c']);
  assert.deepEqual([h.image('a.jpg'), h.image('b.jpg'), h.image('sample_1.jpg'), h.image('sample_2.jpg')], [true, true, false, false]);
  h.done();
});

test('with no samples to remove, the index file is not rewritten', () => {
  const h = freshHome([rec('a'), '   ', '{"id":"torn"', rec('b')], ['a.jpg', 'b.jpg']);
  const before = fs.readFileSync(h.index);
  assert.deepEqual(h.maintenance.clearGallery(), { removed: 0, deleted: 0, kept: 2 });
  assert.deepEqual(fs.readFileSync(h.index), before);
  assert.equal(h.store.listRecords({}).length, 2);
  h.done();
});

test('a sample that was set aside in Clean up is removed with the rest', () => {
  const h = freshHome([rec('a'), rec('sample_1', { sample: true })], ['a.jpg', 'sample_1.jpg']);
  h.store.hide(['sample_1']);
  assert.deepEqual(h.maintenance.clearGallery(), { removed: 1, deleted: 1, kept: 1 });
  assert.deepEqual(h.onDisk(), ['a']);
  assert.equal(h.store.hiddenIds().size, 0);
  h.done();
});

test('clearing everything removes every record and each local image, and says so', () => {
  const h = freshHome([rec('a'), rec('b'), rec('c', { kind: 'video', filename: 'c.mp4' })], ['a.jpg', 'b.jpg']);
  assert.deepEqual(h.maintenance.clearGallery({ all: true }), { removed: 3, deleted: 2, kept: 0 });
  assert.deepEqual(h.onDisk(), []);
  assert.equal(h.store.listRecords({}).length, 0);
  assert.equal(h.store.has('a'), false);
  h.done();
});
