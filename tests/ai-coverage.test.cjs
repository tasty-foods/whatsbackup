// What is read, what is left to read, and what still lacks a vector: the
// counts behind the Library's "files have a content index" line, the cost
// estimate and the embedding queue. The dashboard asks for them every few
// seconds, so they are answered from memory and from bulk reads; these tests
// hold them to the item-by-item definitions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KB = 1024;
// The marks a label carries when it was made by the current reader. They are
// stored in people's archives: changing them makes every label stale.
const CURRENT = {
  image: { index_version: 2, index_profile: 'image:1280:facts:1' },
  video: { index_version: 2, index_profile: 'frames:6' },
  document: { index_version: 2, index_profile: 'text:2:pages:30:ocr:4:facts:1' },
  audio: { index_version: 2, index_profile: 'audio:1' },
};

function freshArchive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-coverage-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ aiVideoFrames: 6, aiDocumentPages: 30, aiOcrPages: 4 }));
  const rec = (id, kind, size, extra = {}) => ({ id, ts: 1700000000000 + Object.keys(records).length * 1000, dir: 'in', kind, chat: 'Supplier', filename: id + '.bin', serve: '/media/files/' + id + '.bin', size, caption: '', ...extra });
  const records = {};
  for (const r of [
    rec('img1', 'image', 5 * KB, { caption: 'Delivered this morning' }), rec('img2', 'image', 5 * KB), rec('img3', 'image', 5 * KB), rec('img4', 'image', 500),
    rec('st1', 'sticker', 5 * KB),
    rec('vid1', 'video', 900 * KB), rec('vid2', 'video', 900 * KB),
    rec('doc1', 'document', 40 * KB, { docName: 'Invoice 4021.pdf' }), rec('doc2', 'document', 40 * KB),
    rec('aud1', 'voice', 30 * KB), rec('aud2', 'audio', 26 * KB * KB),
    rec('demo', 'image', 5 * KB, { sample: true }),
    rec('gone', 'image', 5 * KB),
  ]) records[r.id] = r;
  fs.writeFileSync(path.join(root, 'data', 'index.ndjson'), Object.values(records).map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.env.WB_HOME = root;
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/]/.test(k)) delete require.cache[k];
  const store = require('../src/store');
  const messages = require('../src/messages');
  store.ensureDirs(); store.loadAll(); messages.init();
  store.hide(['gone']);                               // set aside in Clean up: not part of the library
  messages.addMany([
    { id: 'm1', chatId: 'c1@c.us', chatName: 'Supplier', ts: 1000, fromMe: false, body: 'Here is the quote' },
    { id: 'm2', chatId: 'c1@c.us', chatName: 'Supplier', ts: 2000, fromMe: true, body: 'Looks good' },
    { id: 'm3', chatId: 'c2@c.us', chatName: 'Mum', ts: 3000, fromMe: false, body: 'See you Sunday' },
    { id: 'm4', chatId: 'c3@c.us', chatName: 'Pictures only', ts: 4000, fromMe: false, type: 'image', body: '' },
  ]);
  const ai = require('../src/ai/store');
  const label = require('../src/ai/label');
  const embed = require('../src/ai/embed');
  const settings = require('../src/settings');
  const put = (kind, refId, body) => ai.putLabel({ kind, refId, contentHash: 'h-' + refId, label: body, model: 'test', provider: 'test' });
  return { root, store, messages, ai, label, embed, settings, put, done: () => { messages.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const ALL = { analyseImages: true, analyseVideos: true, analyseDocuments: true, analyseChats: true, transcribeAudio: true };

test('coverage counts what is read, what is left and what is skipped, per kind', () => {
  const a = freshArchive();
  a.put('image', 'img1', { caption: 'A pallet of boxes', ...CURRENT.image });
  a.put('image', 'img2', { caption: 'Made by an older reader', index_version: 1, index_profile: 'image:1280:facts:1' });
  a.put('video', 'vid1', { caption: 'A tour', ...CURRENT.video });
  a.put('video', 'vid2', { caption: 'Sampled with fewer frames', index_version: 2, index_profile: 'frames:4' });
  a.put('document', 'doc1', { title: 'Invoice 4021', ...CURRENT.document });
  a.put('audio', 'aud1', { summary: 'A voice note', ...CURRENT.audio });
  a.put('chat', 'c1@c.us', { summary: 'About a quote' });

  assert.deepEqual(a.label.census(ALL), {
    images: { count: 5, bytes: 3 * 5 * KB + 500 + 5 * KB, labelled: 1, todo: 2, skipped: { 'thumbnail-sized': 1, sticker: 1 } },
    videos: { count: 2, labelled: 1, todo: 1 },
    documents: { count: 2, labelled: 1, todo: 1 },
    audio: { count: 2, bytes: 30 * KB + 26 * KB * KB, labelled: 1, todo: 0, skipped: { 'too large to transcribe': 1 } },
    chats: { count: 3, labelled: 1, todo: 1, noText: 1 },
  });

  // A kind that is switched off is counted but has nothing left to do.
  const off = a.label.census({ ...ALL, analyseImages: false, transcribeAudio: false, analyseChats: false });
  assert.deepEqual(off.images, { count: 5, bytes: 3 * 5 * KB + 500 + 5 * KB, labelled: 1, todo: 0, skipped: { 'thumbnail-sized': 1, sticker: 1 } });
  assert.deepEqual(off.chats, { count: 0, labelled: 0, todo: 0 });
  a.done();
});

test('coverage follows every label as it is written, re-read, changed in settings and wiped', () => {
  const a = freshArchive();
  a.put('image', 'img1', { caption: 'A pallet of boxes', ...CURRENT.image });
  a.put('video', 'vid1', { caption: 'A tour', ...CURRENT.video });
  assert.equal(a.label.census(ALL).images.labelled, 1);

  a.put('image', 'img3', { caption: 'Read just now', ...CURRENT.image });
  assert.deepEqual([a.label.census(ALL).images.labelled, a.label.census(ALL).images.todo], [2, 1]);

  // The same item read again by an outdated reader is work to do once more.
  a.put('image', 'img3', { caption: 'Overwritten by an old build', index_version: 1 });
  assert.deepEqual([a.label.census(ALL).images.labelled, a.label.census(ALL).images.todo], [1, 2]);

  a.put('chat', 'c2@c.us', { summary: 'Family' });
  assert.deepEqual(a.label.census(ALL).chats, { count: 3, labelled: 1, todo: 1, noText: 1 });

  // More frames per video asked for: the video read with six is stale.
  a.settings.write({ aiVideoFrames: 8 });
  assert.deepEqual(a.label.census(ALL).videos, { count: 2, labelled: 0, todo: 2 });
  a.settings.write({ aiVideoFrames: 6 });
  assert.deepEqual(a.label.census(ALL).videos, { count: 2, labelled: 1, todo: 1 });

  // Something set aside in Clean up leaves the count; brought back, it returns.
  a.store.hide(['img1']);
  assert.deepEqual([a.label.census(ALL).images.count, a.label.census(ALL).images.labelled], [4, 0]);
  a.store.unhide(['img1']);
  assert.deepEqual([a.label.census(ALL).images.count, a.label.census(ALL).images.labelled], [5, 1]);

  a.ai.wipe();
  const wiped = a.label.census(ALL);
  assert.deepEqual([wiped.images.labelled, wiped.videos.labelled, wiped.chats.labelled], [0, 0, 0]);
  assert.deepEqual([wiped.images.todo, wiped.videos.todo, wiped.chats.todo], [3, 2, 2]);
  a.done();
});

test('what still lacks a vector is exactly what the item-by-item check says', () => {
  const a = freshArchive();
  const model = 'embed-test';
  a.put('image', 'img1', { caption: 'A pallet of boxes', tags: ['delivery'], ...CURRENT.image });
  a.put('image', 'img2', { caption: 'A birthday cake', ...CURRENT.image });
  a.put('video', 'vid1', { caption: 'A tour of the shop', ...CURRENT.video });
  a.put('document', 'doc1', { title: 'Invoice 4021', summary: 'An invoice for boxes', ...CURRENT.document });
  a.put('audio', 'aud1', { summary: 'A voice note about Thursday', transcript: 'See you Thursday', ...CURRENT.audio });
  a.put('chat', 'c1@c.us', { summary: 'About a quote', topics: ['quote'] });
  a.put('image', 'deleted-record', { caption: 'Its record is no longer in the library', ...CURRENT.image });
  a.put('image', 'img3', null);                        // a label with nothing in it has nothing to embed
  const [topicId] = a.ai.putTopics('c1@c.us', [{ title: 'Cake boxes', summary: 'Ordering 500 boxes', keywords: ['boxes'], decisions: ['Deliver Thursday'], fromTs: 1000, toTs: 2000, msgCount: 2 }]);

  // The definition: one item at a time, its text hashed and looked up.
  const reference = () => {
    const out = [];
    for (const kind of ['image', 'video', 'document', 'audio', 'chat']) {
      for (const row of a.ai.labelsOfKinds([kind])) {
        const text = a.embed.textFor(kind, row.refId);
        if (text && !a.ai.hasEmbedding(kind, row.refId, a.ai.sha1(model + '\n' + text))) out.push({ kind, refId: row.refId });
      }
    }
    for (const t of a.ai.allTopics()) {
      const text = a.embed.textFor('topic', t.id);
      if (text && !a.ai.hasEmbedding('topic', t.id, a.ai.sha1(model + '\n' + text))) out.push({ kind: 'topic', refId: t.id });
    }
    return out;
  };
  const ids = (rows) => rows.map((r) => r.kind + ':' + r.refId);

  assert.deepEqual(ids(a.embed.pending(model)), ['image:img1', 'image:img2', 'video:vid1', 'document:doc1', 'audio:aud1', 'chat:c1@c.us', 'topic:' + topicId]);
  assert.deepEqual(a.embed.pending(model), reference());

  // Vectors arrive: a current one settles its item, a stale one (the label
  // changed since) and one made by another model do not.
  const vec = new Float32Array([0.6, 0.8]);
  const hashOf = (kind, refId, m = model) => a.ai.sha1(m + '\n' + a.embed.textFor(kind, refId));
  a.ai.putEmbedding({ kind: 'image', refId: 'img1', model, contentHash: hashOf('image', 'img1'), vec });
  a.ai.putEmbedding({ kind: 'topic', refId: topicId, model, contentHash: hashOf('topic', topicId), vec });
  a.ai.putEmbedding({ kind: 'video', refId: 'vid1', model, contentHash: 'made-before-the-label-changed', vec });
  a.ai.putEmbedding({ kind: 'document', refId: 'doc1', model: 'another-model', contentHash: hashOf('document', 'doc1', 'another-model'), vec });
  assert.deepEqual(ids(a.embed.pending(model)), ['image:img2', 'video:vid1', 'document:doc1', 'audio:aud1', 'chat:c1@c.us']);
  assert.deepEqual(a.embed.pending(model), reference());

  // A label rewritten after its vector was made needs a new vector.
  a.put('image', 'img1', { caption: 'A pallet of boxes, seen again', ...CURRENT.image });
  assert.ok(ids(a.embed.pending(model)).includes('image:img1'));
  assert.deepEqual(a.embed.pending(model), reference());
  a.done();
});

test('a search by meaning sees vectors written since the last search', async () => {
  const a = freshArchive();
  a.put('image', 'img1', { caption: 'A pallet of boxes', ...CURRENT.image });
  a.put('image', 'img2', { caption: 'A birthday cake', ...CURRENT.image });
  const cfg = { provider: 'demo', embedModel: 'demo' };
  const demo = require('../src/ai/demo');
  const vectorFor = async (text) => (await demo.embed(cfg, [text])).vectors[0];
  a.ai.putEmbedding({ kind: 'image', refId: 'img1', model: 'demo', contentHash: 'x', vec: await vectorFor('pallet boxes delivery') });

  const first = await a.embed.search(cfg, 'pallet boxes', { minScore: 0.2 });
  assert.deepEqual(first.map((r) => r.refId), ['img1']);

  a.ai.putEmbedding({ kind: 'image', refId: 'img2', model: 'demo', contentHash: 'y', vec: await vectorFor('birthday cake candles') });
  const second = await a.embed.search(cfg, 'birthday cake', { minScore: 0.2 });
  assert.deepEqual(second.map((r) => r.refId), ['img2']);
  assert.deepEqual((await a.embed.search(cfg, 'pallet boxes', { minScore: 0.2 })).map((r) => r.refId), ['img1']);

  a.ai.wipe();
  assert.deepEqual(await a.embed.search(cfg, 'pallet boxes', { minScore: 0.2 }), []);
  a.done();
});
