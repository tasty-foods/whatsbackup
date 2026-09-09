const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a throttled read retries and failed chats persist alongside successful images', async () => {
  const records = [], histories = [], waits = [];
  let attempts = 0;
  const ctx = {
    module: { exports: {} }, console, Buffer,
    setTimeout: (fn, ms) => { waits.push(ms); fn(); return { unref() {} }; }, clearTimeout() {},
    require: name => {
      if (name === 'fs') return { existsSync: () => true, mkdirSync() {}, writeFileSync() {} };
      if (name === '../paths') return { CHATGPT_DIR: 'profile' };
      if (name === '../config') return { IMAGES_DIR: 'images' };
      if (name === '../settings') return { read: () => ({ chatgptEnabled: false }) };
      if (name === '../store') return { has: () => false, addRecord: rec => { records.push(rec); return true; } };
      if (name === '../source-history') return { write: (name, run) => histories.push({ ...run }) };
      if (name === '../ai') return { noteNewMedia() {} };
      if (name === '../backup') return { nudge() {} };
      return require(name);
    },
    fakeRead: async (_page, _token, chat) => {
      if (chat.id === 'bad') return { error: 'http 404', status: 404 };
      if (!attempts++) return { error: 'http 429', status: 429, retryAfter: 2 };
      return { parts: [{ fileId: 'test-file', role: 'tool', title: 'Example', createTime: 100, mime: 'image/png' }] };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/chatgpt/index.js'), 'utf8'), ctx);
  vm.runInContext("launch = async () => ({}); openPage = async () => ({}); closeBrowser = async () => {}; sessionToken = async () => 'fixture'; listConversations = async () => [{id:'good'}, {id:'bad'}]; readConversation = fakeRead; fetchImage = async () => ({b64:'aW1hZ2U=',mime:'image/png'});", ctx);
  const result = await ctx.module.exports.scan();
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(result.conversations, 2);
  assert.equal(result.saved, 1);
  assert.equal(result.failedChats, 1);
  assert.equal(result.failedImages, 0);
  assert.equal(result.firstError, 'http 404');
  assert.equal(histories[0].failed, 1);
  assert.equal(records.length, 1);
  assert.ok(waits.includes(2000));
  assert.equal(ctx.module.exports.getState().busy, false);
});
