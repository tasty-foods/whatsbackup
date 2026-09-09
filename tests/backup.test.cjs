const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('whatsbackup-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cfg = { CLOUD_ROOT: path.join(root, 'cloud'), IMAGES_DIR: path.join(root, 'local'), LOCAL_VIDEO_DIR: path.join(root, 'local'), FILES_DIR: path.join(root, 'local') };
  cfg.VIDEO_DIR = path.join(cfg.CLOUD_ROOT, 'Videos');
  fs.mkdirSync(path.join(cfg.CLOUD_ROOT, 'Images'), { recursive: true });
  fs.mkdirSync(cfg.IMAGES_DIR);
  const records = [];
  let now = Date.now();
  const sandbox = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval, setImmediate, Date: class extends Date { static now() { return now; } }, require: name => name === './config' ? cfg : name === './store' ? { hiddenIds: () => new Set(), listRecords: () => records } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/backup.js'), 'utf8'), sandbox);
  function add(id, contents = 'complete image') {
    const rec = { id, kind: 'image', filename: id + '.jpg', size: Buffer.byteLength(contents) };
    records.push(rec); fs.writeFileSync(path.join(cfg.IMAGES_DIR, rec.filename), contents);
    return rec;
  }
  return { api: sandbox.module.exports, cfg, records, add, advance: ms => { now += ms; }, cloud: rec => path.join(cfg.CLOUD_ROOT, 'Images', rec.filename) };
}

test('rejects a partial cloud copy and repairs it on demand', async t => {
  const f = fixture(t), rec = f.add('one');
  fs.writeFileSync(f.cloud(rec), 'part');
  assert.equal(f.api.onCloud(rec), false);
  const result = await f.api.sweep();
  assert.equal(result.copied, 1);
  assert.equal(result.failed, 0);
  assert.equal(fs.readFileSync(f.cloud(rec), 'utf8'), 'complete image');
  assert.equal(fs.existsSync(f.cloud(rec) + '.whatsbackup-part'), false);
});

test('positive checks expire and a manual sweep rechecks immediately', async t => {
  const f = fixture(t), rec = f.add('one');
  await f.api.sweep();
  fs.unlinkSync(f.cloud(rec));
  assert.equal(f.api.onCloud(rec), true);
  f.advance(121000);
  assert.equal(f.api.onCloud(rec), false);
  await f.api.sweep();
  fs.unlinkSync(f.cloud(rec));
  assert.equal((await f.api.sweep()).copied, 1);
});

test('reports a missing original rather than silently succeeding', async t => {
  const f = fixture(t), rec = f.add('missing');
  fs.unlinkSync(path.join(f.cfg.IMAGES_DIR, rec.filename));
  const result = await f.api.sweep();
  assert.equal(result.failed, 1);
  assert.equal(f.api.status().onlyHere, 1);
});

test('cloud membership includes every missing item beyond 2000 records', t => {
  const f = fixture(t);
  for (let i = 0; i < 2005; i++) f.records.push({ id: String(i), filename: i + '.jpg', kind: 'image', size: 20 });
  const result = f.api.status();
  assert.equal(result.onlyHere, 2005);
  assert.equal(result.onlyHereIds.length, 2005);
});

test('an unavailable cloud folder is not created by a status read', t => {
  const f = fixture(t);
  f.cfg.CLOUD_ROOT = path.join(f.cfg.CLOUD_ROOT, 'unmounted');
  assert.equal(f.api.available(), false);
  assert.equal(fs.existsSync(f.cfg.CLOUD_ROOT), false);
});
