const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('the desktop preload reaches the main-process check, status and restart handlers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-desktop-ipc-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('whatsbackup-desktop-ipc-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const handlers = new Map();
  const updater = new EventEmitter();
  let available = false;
  let checks = 0;
  const installs = [];
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit(available ? 'update-available' : 'update-not-available', { version: available ? '1.5.2' : '1.5.1' });
    return { isUpdateAvailable: available };
  };
  updater.quitAndInstall = (...args) => installs.push(args);
  const electron = {
    app: { isPackaged: true, getVersion: () => '1.5.1', setPath() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, exit() {} },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    Notification: { isSupported: () => false },
    dialog: { showMessageBox: () => { throw Error('Quiet checks must not open a dialog'); } },
  };
  const shellContext = {
    module: { exports: {} }, __dirname: path.resolve(__dirname, '../electron'),
    console, process: { env: { LOCALAPPDATA: root }, resourcesPath: root, argv: [] },
    setTimeout, clearTimeout, setInterval, setImmediate, Buffer,
    require: name => name === 'electron' ? electron
      : name === 'electron-updater' ? { autoUpdater: updater }
      : name === './updates' ? require('../electron/updates')
      : name === './migrate' ? { findOldInstall: () => null }
      : name.endsWith('src' + path.sep + 'settings.js') ? { read: () => ({}) }
      : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8') + '\nregisterIpc();', shellContext);
  let desktop;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'desktop'); desktop = value; } },
      ipcRenderer: { invoke: (name, ...args) => handlers.get(name)({}, ...args) },
    }),
  });
  assert.equal(await desktop.checkUpdates(true), true);
  await new Promise(setImmediate);
  let result = await desktop.updateStatus();
  assert.equal(result.status, 'current');
  assert.equal(result.current, '1.5.1');
  assert.equal(result.packaged, true);
  assert.equal(checks, 1);
  assert.equal(await desktop.installUpdate(), false);
  available = true;
  await desktop.checkUpdates(true);
  await new Promise(setImmediate);
  updater.emit('update-downloaded', { version: '1.5.2' });
  assert.equal((await desktop.updateStatus()).status, 'ready');
  assert.equal(await desktop.installUpdate(), true);
  assert.deepEqual(installs, [[true, true]]);
  assert.equal((await desktop.updateStatus()).status, 'installing');
});
