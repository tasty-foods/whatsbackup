// Conversations and the index, copied to the cloud folder: a copy that can be
// opened, a previous one kept, nothing copied unless asked for, and a full
// copy never replaced by a nearly empty archive.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function freshHome({ on = true, cloud = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-archive-'));
  const cloudRoot = path.join(root, 'cloud');
  if (cloud) fs.mkdirSync(cloudRoot);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ cloudRoot: cloud ? cloudRoot : '', backupConversations: on }));
  fs.writeFileSync(path.join(root, 'data', 'index.ndjson'), JSON.stringify({ id: 'a', ts: 1, kind: 'image', filename: 'a.jpg' }) + '\n');
  process.env.WB_HOME = root;
  delete process.env.WA_CLOUD_DIR;
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/]/.test(k)) delete require.cache[k];
  const quiet = console.log; console.log = () => {};
  const messages = require('../src/messages');
  messages.init();
  const backup = require('../src/archive-backup');
  const dir = path.join(cloudRoot, 'Archive data');
  const count = (file) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT COUNT(*) c FROM messages').get().c; } finally { db.close(); } };
  return { root, dir, messages, backup, count, done: () => { console.log = quiet; messages.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const msg = (i) => ({ id: 'm' + i, chatId: 'c1@c.us', chatName: 'Supplier', ts: 1000 + i, fromMe: false, body: 'message number ' + i + ' ' + 'x'.repeat(200) });

test('the cloud copy holds every message and the index, and yesterday\'s copy is kept', async () => {
  const h = freshHome();
  h.messages.addMany([msg(1), msg(2), msg(3)]);
  const first = await h.backup.run();
  assert.equal(first.ok, true);
  assert.equal(h.count(path.join(h.dir, 'conversations.db')), 3);
  assert.match(fs.readFileSync(path.join(h.dir, 'index.ndjson'), 'utf8'), /"id":"a"/);
  assert.ok(fs.existsSync(path.join(h.dir, 'READ ME.txt')));
  assert.equal(fs.existsSync(path.join(h.dir, 'conversations.previous.db')), false);

  h.messages.addMany([msg(4), msg(5)]);
  assert.equal((await h.backup.run()).ok, true);
  assert.equal(h.count(path.join(h.dir, 'conversations.db')), 5);
  assert.equal(h.count(path.join(h.dir, 'conversations.previous.db')), 3);
  assert.equal(fs.readdirSync(h.dir).some((f) => /whatsbackup-part|snapshot/.test(f)), false);
  assert.equal(fs.existsSync(path.join(h.root, 'data', 'archive-backup-snapshot.db')), false);
  assert.ok(h.backup.status().lastAt > 0);
  assert.equal(JSON.stringify(fs.readdirSync(h.dir)).includes('settings'), false);
  h.done();
});

test('nothing is copied on the schedule unless the switch is on, and a day has passed', async () => {
  const off = freshHome({ on: false });
  off.messages.addMany([msg(1)]);
  await off.backup.check();
  assert.equal(fs.existsSync(off.dir), false);
  off.done();

  const on = freshHome({ on: true });
  on.messages.addMany([msg(1)]);
  await on.backup.check();
  assert.equal(on.count(path.join(on.dir, 'conversations.db')), 1);
  on.messages.addMany([msg(2)]);
  await on.backup.check();                              // same day: not again
  assert.equal(on.count(path.join(on.dir, 'conversations.db')), 1);
  on.done();
});

test('a nearly empty archive does not replace a full copy unless told to', async () => {
  const h = freshHome();
  // The copy left by the old PC: a few megabytes of history.
  fs.mkdirSync(h.dir, { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'conversations.db'), Buffer.alloc(3 * 1024 * 1024, 7));
  h.messages.addMany([msg(1)]);
  const r = await h.backup.run();
  assert.equal(r.ok, false);
  assert.match(r.error, /much larger/);
  assert.equal(fs.statSync(path.join(h.dir, 'conversations.db')).size, 3 * 1024 * 1024);
  assert.equal(h.backup.status().lastError, r.error);

  assert.equal((await h.backup.run({ force: true })).ok, true);
  assert.equal(h.count(path.join(h.dir, 'conversations.db')), 1);
  assert.equal(fs.statSync(path.join(h.dir, 'conversations.previous.db')).size, 3 * 1024 * 1024);
  h.done();
});

test('without a cloud folder, or with it away, the answer says so', async () => {
  const none = freshHome({ cloud: false });
  assert.match((await none.backup.run()).error, /Choose a cloud folder/);
  none.done();

  const away = freshHome();
  fs.rmSync(path.join(away.root, 'cloud'), { recursive: true });
  assert.match((await away.backup.run()).error, /not reachable/);
  away.done();
});
