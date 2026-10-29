'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { createFileActions, writeFileDropList, FILE_CLIPBOARD_SCRIPT } = require('../electron/file-actions');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-file-actions-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('wb-file-actions-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const media = path.join(root, 'media'), cloud = path.join(root, 'cloud'), sibling = path.join(root, 'media-other');
  for (const directory of [media, cloud, sibling]) fs.mkdirSync(directory);
  const first = path.join(media, "offer [1] # résumé's.png"), second = path.join(cloud, 'video.mp4'), outside = path.join(sibling, 'private.txt');
  for (const file of [first, second, outside]) fs.writeFileSync(file, 'fixture');
  const writes = [], fileWrites = [];
  const actions = createFileActions({ getRoots: () => [media, cloud, path.join(root, 'disconnected')], writeText: text => writes.push(text), writeFiles: files => fileWrites.push(files), platform: 'win32' });
  return { root, media, cloud, first, second, outside, writes, fileWrites, actions };
}

test('desktop clipboard copies unique paths, encoded file links, and file references without reading their contents', async t => {
  const f = fixture(t), realFirst = fs.realpathSync(f.first), realSecond = fs.realpathSync(f.second);
  assert.deepEqual(await f.actions.copyPaths([f.first, f.second, f.first]), { ok: true, count: 2 });
  assert.equal(f.writes.pop(), [realFirst, realSecond].join('\r\n'));
  assert.deepEqual(await f.actions.copyFileLinks(f.first), { ok: true, count: 1 });
  assert.equal(f.writes.pop(), pathToFileURL(realFirst).href);
  assert.ok(pathToFileURL(realFirst).href.includes('%23'));
  assert.deepEqual(await f.actions.copyFiles([f.first, f.second]), { ok: true, count: 2 });
  assert.deepEqual(f.fileWrites, [[realFirst, realSecond]]);
});

test('clipboard validation rejects the entire selection before writing if any file is invalid or outside the archive', async t => {
  const f = fixture(t);
  for (const targets of [[], [null], ['relative.png'], [f.first + '\0bad'], [f.media], [f.first, f.outside], [f.first, path.join(f.cloud, 'missing.png')], Array(1001).fill(f.first)]) {
    const result = await f.actions.copyPaths(targets);
    assert.equal(result.ok, false, JSON.stringify(targets));
    assert.equal(result.count, 0);
  }
  assert.deepEqual(f.writes, []);
});

test('clipboard validation follows links and rejects a directory junction escaping the archive', async t => {
  const f = fixture(t), junction = path.join(f.media, 'escape');
  fs.symlinkSync(path.dirname(f.outside), junction, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.actions.copyFiles([path.join(junction, path.basename(f.outside))]);
  assert.equal(result.ok, false);
  assert.deepEqual(f.fileWrites, []);
});

test('unsupported file-paste platforms and OS clipboard failures return actionable errors instead of success', async t => {
  const f = fixture(t);
  const unix = createFileActions({ getRoots: () => [f.media], writeText() {}, platform: 'linux' });
  assert.match((await unix.copyFiles(f.first)).error, /Windows desktop/);
  const failed = createFileActions({ getRoots: () => [f.media], writeText: () => { throw Error('Clipboard busy'); } });
  assert.deepEqual(await failed.copyPaths(f.first), { ok: false, count: 0, error: 'Clipboard busy' });
});

test('Windows file attachment command is hidden and keeps Unicode, wildcard and shell-like names out of executable code', async () => {
  const files = ["C:\\media\\[one] résumé's $(whoami).png", 'P:\\archive\\תמונה.png'];
  let invocation, payload;
  await writeFileDropList(files, {
    systemRoot: 'C:\\Windows',
    execFile: (executable, args, options, callback) => {
      invocation = { executable, args, options };
      const stdin = new EventEmitter();
      stdin.end = value => { payload = value; queueMicrotask(() => callback(null, 'ok')); };
      return { stdin };
    },
  });
  assert.equal(invocation.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.args.at(-1), FILE_CLIPBOARD_SCRIPT);
  assert.ok(invocation.args.includes('-STA'));
  assert.ok(FILE_CLIPBOARD_SCRIPT.includes('Set-Clipboard -LiteralPath $files'));
  assert.ok(!FILE_CLIPBOARD_SCRIPT.includes('whoami'));
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), files);
  await assert.rejects(writeFileDropList(files, { execFile: (_exe, _args, _opts, callback) => { const stdin = new EventEmitter(); stdin.end = () => queueMicrotask(() => callback(Error('busy'), '')); return { stdin }; } }), /could not copy/);
});

test('preload clipboard APIs reach main-process handlers while rejecting out-of-scope paths', async t => {
  const f = fixture(t), handlers = new Map();
  const clipboard = { writeText: text => f.writes.push(text) };
  const electron = {
    app: { isPackaged: true, getVersion: () => '2.1.1', setPath() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => false, exit() {}, quit() {} },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, clipboard,
    Notification: { isSupported: () => false },
  };
  const mainDirectory = path.resolve(__dirname, '../electron');
  vm.runInNewContext(fs.readFileSync(path.join(mainDirectory, 'main.js'), 'utf8') + '\nregisterIpc();', {
    __dirname: mainDirectory, console, process: { env: { LOCALAPPDATA: f.root }, resourcesPath: f.root },
    setTimeout, clearTimeout, setInterval, setImmediate, Buffer,
    require: name => name === 'electron' ? electron
      : name === './updates' ? require('../electron/updates')
      : name === './migrate' ? { findOldInstall: () => null }
      : name.endsWith('src' + path.sep + 'settings.js') ? { read: () => ({ mediaRoot: f.media, cloudRoot: f.cloud }) }
      : require(name),
  });
  let desktop;
  vm.runInNewContext(fs.readFileSync(path.join(mainDirectory, 'preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { desktop = value; } }, ipcRenderer: { invoke: (name, ...args) => handlers.get(name)({}, ...args) } }),
  });
  assert.deepEqual(await desktop.copyPaths([f.first]), { ok: true, count: 1 });
  assert.deepEqual(await desktop.copyFileLinks([f.second]), { ok: true, count: 1 });
  assert.equal((await desktop.copyFiles([f.outside])).ok, false);
  assert.equal(f.writes.length, 2);
});
