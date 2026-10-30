'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function clock() {
  let now = 0, nextId = 0; const timers = new Map();
  const setTimeout = (fn, delay) => { const handle = { id: ++nextId, unref() {} }; timers.set(handle.id, { handle, fn, at: now + delay }); return handle; };
  const clearTimeout = handle => { if (handle) timers.delete(handle.id); };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  async function advance(duration) {
    const until = now + duration;
    for (;;) {
      const due = [...timers.values()].filter(timer => timer.at <= until).sort((a, b) => a.at - b.at || a.handle.id - b.handle.id)[0];
      if (!due) break;
      now = due.at; timers.delete(due.handle.id); due.fn(); await settle();
    }
    now = until; await settle();
  }
  return { setTimeout, clearTimeout, advance, settle };
}
function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-shutdown-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('whatsbackup-shutdown-')); fs.rmSync(root, { recursive: true, force: true }); });
  const app = new EventEmitter(), timer = clock(); let quits = 0, starts = 0;
  Object.assign(app, { isPackaged: true, getVersion: () => '2.2.0', setPath() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), quit: () => { quits++; }, exit() {} });
  const directory = path.resolve(__dirname, '../electron');
  const context = vm.createContext({
    module: { exports: {} }, __dirname: directory, console, Buffer, URL,
    process: { env: { LOCALAPPDATA: root }, resourcesPath: root, argv: [] },
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout, setInterval: timer.setTimeout, setImmediate,
    countStart: () => { starts++; },
    require: name => name === 'electron' ? { app, ipcMain: { handle() {} }, Notification: { isSupported: () => false } }
      : name === './updates' ? require('../electron/updates') : name === './migrate' ? { findOldInstall: () => null }
      : name.endsWith('src' + path.sep + 'settings.js') ? { read: () => ({}) } : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(directory, 'main.js'), 'utf8') + `
    startEngine = () => countStart();
    module.exports = {
      stop: stopEngine, restart: restartEngine,
      setChild(value) { child = value; value.on('exit', () => { if (child === value) child = null; }); },
      state() { return { suspended, quitting }; }
    };
  `, context);
  const child = new EventEmitter(), sent = []; let kills = 0;
  child.postMessage = message => { sent.push(message); }; child.kill = () => { kills++; return true; };
  context.module.exports.setChild(child);
  return { ...context.module.exports, app, child, sent, timer, kills: () => kills, quits: () => quits, starts: () => starts };
}

test('desktop shutdown waits for the engine prepared-stop reply before killing, then waits for exit and profile release', async t => {
  const h = harness(t); let resolved = false;
  const pending = h.stop().then(() => { resolved = true; });
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].type, 'prepare-stop'); assert.equal(h.kills(), 0);
  h.child.emit('message', { type: 'unrelated-message' }); assert.equal(h.kills(), 0);
  h.child.emit('message', { type: 'prepared-stop' }); assert.equal(h.kills(), 1); assert.equal(resolved, false);
  h.child.emit('exit', 0); await h.timer.advance(1499); assert.equal(resolved, false);
  await h.timer.advance(1); await pending; assert.equal(resolved, true); assert.equal(h.state().suspended, true);
});

test('desktop shutdown kills a nonresponsive engine after the 7.5-second grace deadline and resolves if exit is absent', async t => {
  const h = harness(t); let resolved = false;
  const pending = h.stop().then(() => { resolved = true; });
  await h.timer.advance(7499); assert.equal(h.kills(), 0); assert.equal(resolved, false);
  await h.timer.advance(1); assert.equal(h.kills(), 1); assert.equal(resolved, false);
  await h.timer.advance(7500); await pending; assert.equal(resolved, true);
  assert.equal(h.kills(), 1);
});

test('an engine exiting while preparing shutdown cancels the stale kill timer', async t => {
  const h = harness(t); const pending = h.stop();
  h.child.emit('exit', 1); await h.timer.advance(1500); await pending;
  await h.timer.advance(15000); assert.equal(h.kills(), 0);
  assert.equal(h.child.listenerCount('message'), 0);
});

test('desktop restart deduplicates requests and launches only after engine exit plus the profile grace period', async t => {
  const h = harness(t), first = h.restart(), second = h.restart();
  assert.equal(first, second); assert.equal(h.sent.length, 1); assert.equal(h.starts(), 0);
  h.child.emit('message', { type: 'prepared-stop' }); await h.timer.advance(3000); assert.equal(h.starts(), 0);
  h.child.emit('exit', 0); await h.timer.advance(1499); assert.equal(h.starts(), 0);
  await h.timer.advance(1); await first; assert.equal(h.starts(), 1); assert.equal(h.state().suspended, false);
});

test('quitting prevents the first native quit until preparation completes and suppresses an already requested restart', async t => {
  const h = harness(t); const restart = h.restart(); let prevented = 0;
  h.app.emit('before-quit', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1); assert.equal(h.quits(), 0); assert.equal(h.state().quitting, true);
  h.child.emit('message', { type: 'prepared-stop' }); h.child.emit('exit', 0);
  await h.timer.advance(1500); await restart;
  assert.equal(h.starts(), 0); assert.equal(h.quits(), 1);
  h.app.emit('before-quit', { preventDefault: () => { prevented++; } }); assert.equal(prevented, 1);
});
