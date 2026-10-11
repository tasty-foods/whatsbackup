const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-library-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('whatsbackup-library-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function load() {
    const context = { module: { exports: {} }, require: name => name === './paths' ? { DATA_DIR: root } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/library.js'), 'utf8'), context);
    return context.module.exports;
  }
  return { root, load };
}

test('favourites and saved filters survive reload independently', t => {
  const f = fixture(t), library = f.load();
  library.favorite(['photo-1', 'document-2', 'photo-1'], true);
  library.saveView('  Supplier documents  ', { q: 'invoice', kind: 'files', sort: 'big', favorite: true, unwanted: 'discard' });
  const reloaded = f.load().read();
  assert.deepEqual([...reloaded.favorites], ['photo-1', 'document-2']);
  assert.equal(reloaded.views[0].name, 'Supplier documents');
  assert.equal(reloaded.views[0].filters.q, 'invoice');
  assert.equal(reloaded.views[0].filters.favorite, true);
  assert.equal(reloaded.views[0].filters.unwanted, undefined);
  library.favorite(['photo-1'], false);
  assert.equal(library.read().views.length, 1);
  library.deleteView(reloaded.views[0].id);
  assert.deepEqual([...library.read().favorites], ['document-2']);
  assert.equal(library.read().views.length, 0);
});

test('invalid changes and unreadable preferences never overwrite stored choices', t => {
  const f = fixture(t), library = f.load();
  library.favorite(['one'], true);
  assert.throws(() => library.favorite(['one'], 'false'), /valid archive/);
  assert.throws(() => library.saveView(' ', {}), /name/);
  assert.deepEqual([...library.read().favorites], ['one']);
  const file = path.join(f.root, 'library.json');
  fs.writeFileSync(file, '{interrupted');
  assert.throws(() => library.favorite(['two'], true), /unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{interrupted');
});

test('saved views have a bounded capacity and can be removed to make room', t => {
  const library = fixture(t).load();
  for (let i = 0; i < 30; i++) library.saveView('View ' + i, { source: 'whatsapp' });
  assert.throws(() => library.saveView('Extra', {}), /30 saved views/);
  library.deleteView(library.read().views[0].id);
  assert.equal(library.saveView('Extra', {}).views.length, 30);
});
