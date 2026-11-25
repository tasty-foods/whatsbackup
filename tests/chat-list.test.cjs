// The chat list, the chats-with-text set and the message counts sit behind
// polls the dashboard makes every few seconds. They are answered from the
// (chat_id, ts) index instead of a pass over every message; these tests hold
// them to the plain definitions they replaced, on data built to be awkward:
// several messages in one second, chats of nothing but pictures, chats with
// no name, a chat with a single message.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshMessages() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-chats-'));
  process.env.WB_HOME = root;
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/](messages|config|settings|paths)\.js$/.test(k)) delete require.cache[k];
  const messages = require('../src/messages');
  messages.init();
  return { messages, done: () => { messages.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

// What the chat list means: per chat its newest message (the greatest id
// among those sharing the newest second) and how many messages it has.
const REFERENCE_CHATS = `
  SELECT chat_id AS chatId, chat_name AS chatName, ts AS lastTs, body AS lastBody,
         type AS lastType, from_me AS lastFromMe, cnt
  FROM (
    SELECT *, COUNT(*) OVER (PARTITION BY chat_id) AS cnt,
           ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY ts DESC, id DESC) AS rn
    FROM messages
  ) WHERE rn = 1
  ORDER BY lastTs DESC`;
const REFERENCE_WITH_TEXT = `SELECT DISTINCT chat_id FROM messages WHERE COALESCE(body,'') != ''`;

function awkwardArchive() {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rows = [];
  let n = 0;
  const add = (chatId, chatName, ts, body, extra = {}) => rows.push({ id: `${extra.fromMe ? 'true' : 'false'}_${chatId}_${String(n++).padStart(6, '0')}`, chatId, chatName, ts, fromMe: !!extra.fromMe, type: extra.type || 'chat', body, author: extra.author || null });
  for (let c = 0; c < 40; c++) {
    const chatId = c % 7 === 0 ? `1203630000${c}@g.us` : `3247000${String(c).padStart(4, '0')}@c.us`;
    const name = c % 11 === 0 ? null : `Chat ${c}`;
    const count = c === 3 ? 1 : 5 + Math.floor(rnd() * 80);
    for (let i = 0; i < count; i++) {
      // Whole seconds, few distinct values: bursts share a timestamp.
      const ts = 1700000000000 + Math.floor(rnd() * 400) * 1000;
      const picturesOnly = c % 9 === 4;
      add(chatId, name, ts, picturesOnly ? '' : `message ${i} of chat ${c}`, { fromMe: rnd() < 0.4, type: picturesOnly ? 'image' : 'chat' });
    }
    // The newest second of some chats holds several messages; the list must
    // show the one with the greatest id.
    if (c % 4 === 1) for (let k = 0; k < 3; k++) add(chatId, name, 1700000000000 + 500 * 1000, `burst ${k} of chat ${c}`);
  }
  return rows;
}

test('the chat list is each chat\'s newest message and its count, newest chat first', () => {
  const { messages, done } = freshMessages();
  const readable = require('../src/content/message-text');
  messages.addMany(awkwardArchive());
  const db = messages.handle();
  const expected = db.prepare(REFERENCE_CHATS).all().map((r) => ({ ...r, lastBody: readable(r.lastBody) }));
  const actual = messages.listChats();
  assert.equal(actual.length, 40);
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.chatId, { ...r }]));
  assert.deepEqual(byId(actual), byId(expected));
  assert.deepEqual(actual.map((r) => r.lastTs), expected.map((r) => r.lastTs));
  for (let i = 1; i < actual.length; i++) assert.ok(actual[i - 1].lastTs >= actual[i].lastTs);
  // A burst in the newest second: the greatest id wins, as it does in a thread.
  const burst = actual.find((r) => /^burst/.test(r.lastBody));
  assert.match(burst.lastBody, /^burst 2 /);
  done();
});

test('a new message shows in the chat list and the counts at once', () => {
  const { messages, done } = freshMessages();
  messages.addMany(awkwardArchive());
  const before = messages.counts();
  const listed = messages.listChats();
  assert.equal(before.chats, 40);
  assert.equal(before.messages, listed.reduce((n, c) => n + c.cnt, 0));
  // Asked again with nothing written: the same answer.
  assert.deepEqual(messages.counts(), before);

  const target = listed[listed.length - 1];
  assert.ok(messages.addMessage({ id: 'false_new_1', chatId: target.chatId, chatName: 'Renamed', ts: 1800000000000, fromMe: false, body: 'the newest line anywhere' }));
  const after = messages.listChats();
  assert.equal(after[0].chatId, target.chatId);
  assert.equal(after[0].lastBody, 'the newest line anywhere');
  assert.equal(after[0].cnt, target.cnt + 1);
  assert.deepEqual(messages.counts(), { messages: before.messages + 1, chats: 40 });

  assert.equal(messages.addMany([{ id: 'false_new_2', chatId: 'brand-new@c.us', chatName: 'New chat', ts: 1800000001000, fromMe: false, body: 'hello' }]), 1);
  assert.deepEqual(messages.counts(), { messages: before.messages + 2, chats: 41 });
  assert.equal(messages.listChats()[0].chatId, 'brand-new@c.us');
  done();
});

test('chats with text leave out the ones that are only pictures', () => {
  const { messages, done } = freshMessages();
  messages.addMany(awkwardArchive());
  const db = messages.handle();
  const expected = db.prepare(REFERENCE_WITH_TEXT).all().map((r) => r.chat_id).sort();
  const actual = [...messages.chatsWithText()].sort();
  assert.deepEqual(actual, expected);
  assert.ok(actual.length < 40 && actual.length > 30);
  // A picture-only chat gains its first words.
  const silent = messages.listChats().map((c) => c.chatId).find((id) => !actual.includes(id));
  messages.addMessage({ id: 'false_words_1', chatId: silent, chatName: 'Pictures', ts: 1800000002000, fromMe: false, body: 'a caption at last' });
  assert.ok(messages.chatsWithText().has(silent));
  done();
});

test('an empty archive has an empty chat list and zero counts', () => {
  const { messages, done } = freshMessages();
  assert.deepEqual(messages.listChats(), []);
  assert.deepEqual(messages.counts(), { messages: 0, chats: 0 });
  assert.equal(messages.chatsWithText().size, 0);
  done();
});
