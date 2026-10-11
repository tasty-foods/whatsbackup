const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates, CHECK_INTERVAL, RETRY_INTERVAL } = require('../electron/updates');

function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0;
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit('update-not-available', { version: '1.5.1' });
    return { isUpdateAvailable: false, updateInfo: { version: '1.5.1' } };
  };
  const messages = [];
  const updates = createUpdates({ getUpdater: () => updater, packaged: true, current: '1.5.1',
    now: () => 1234, logger: { error: message => messages.push(message) }, ...options });
  return { updater, updates, messages, checks: () => checks };
}

test('source builds do not contact the release server or claim to be current', async () => {
  const f = fixture({ packaged: false, getUpdater: () => { throw Error('must not load'); } });
  assert.equal((await f.updates.check()).status, 'source');
  assert.equal(f.updates.status().checkedAt, 0);
  assert.equal(await f.updates.install(), false);
});

test('successful checks report the installed and published versions with a timestamp', async () => {
  const f = fixture();
  const result = await f.updates.check();
  assert.equal(result.status, 'current');
  assert.equal(result.current, '1.5.1');
  assert.equal(result.latestVersion, '1.5.1');
  assert.equal(result.checkedAt, 1234);
  assert.equal(f.updater.autoDownload, true);
  assert.equal(f.updater.autoInstallOnAppQuit, true);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.allowPrerelease, false);
});

test('a published version older than the install is retained without inventing a download', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-not-available', { version: '1.4.9' });
    return { isUpdateAvailable: false };
  };
  assert.equal((await f.updates.check()).latestVersion, '1.4.9');
  assert.equal(f.updates.status().status, 'current');
  assert.equal(f.updates.status().version, null);
});

test('setup failures, null results and promise rejections all leave Checking and can be retried', async () => {
  let broken = true;
  const f = fixture({ getUpdater: () => { if (broken) throw Error('bad configuration'); return f.updater; } });
  assert.equal((await f.updates.check()).status, 'error');
  assert.equal(f.updates.status().checkedAt, 0);
  broken = false;
  f.updater.checkForUpdates = async () => null;
  assert.match((await f.updates.check()).error, /unavailable/);
  f.updater.checkForUpdates = async () => { throw Error('network offline'); };
  assert.equal((await f.updates.check()).error, 'network offline');
  assert.equal(f.updates.status().checkedAt, 0);
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-not-available', { version: '1.5.1' });
    return { isUpdateAvailable: false };
  };
  assert.equal((await f.updates.check()).status, 'current');
  assert.equal(f.updates.status().error, null);
  assert.equal(f.updater.listenerCount('update-downloaded'), 1);
});

test('repeated clicks share one check', async () => {
  const f = fixture();
  let finish;
  let count = 0;
  f.updater.checkForUpdates = () => { count++; return new Promise(resolve => { finish = resolve; }); };
  const first = f.updates.check();
  const second = f.updates.check();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(count, 1);
  finish({ isUpdateAvailable: false });
  await first;
});

test('download progress leads to one ready notification and cannot be overwritten by a new check', async () => {
  const notices = [];
  const f = fixture({ notify: version => notices.push(version) });
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '1.5.2' });
    return { isUpdateAvailable: true, downloadPromise: Promise.resolve([]) };
  };
  assert.equal((await f.updates.check()).status, 'downloading');
  assert.equal(await f.updates.install(), false);
  f.updater.emit('download-progress', { percent: 51.6 });
  assert.equal(f.updates.status().percent, 52);
  f.updater.emit('update-downloaded', { version: '1.5.2' });
  f.updater.emit('update-downloaded', { version: '1.5.2' });
  assert.deepEqual(notices, ['1.5.2']);
  assert.equal((await f.updates.check()).status, 'ready');
  assert.equal(f.updates.status().version, '1.5.2');
});

test('download failures are caught even without an updater error event', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '1.5.2' });
    return { downloadPromise: Promise.reject(Error('checksum mismatch')) };
  };
  await f.updates.check();
  assert.equal(f.updates.status().status, 'error');
  assert.equal(f.updates.status().error, 'checksum mismatch');
  assert.equal(await f.updates.install(), false);
});

test('install waits for capture to stop, rejects duplicate installs, and forces a relaunch', async () => {
  const f = fixture();
  await f.updates.check();
  f.updater.emit('update-downloaded', { version: '1.5.2' });
  let stopped;
  const calls = [];
  f.updater.quitAndInstall = (...args) => calls.push(args);
  const installing = f.updates.install(() => new Promise(resolve => { stopped = resolve; }));
  assert.equal(f.updates.status().status, 'installing');
  assert.equal(await f.updates.install(), false);
  assert.equal((await f.updates.check()).status, 'installing');
  assert.equal(calls.length, 0);
  stopped();
  assert.equal(await installing, true);
  assert.deepEqual(calls, [[true, true]]);
});

test('synchronous and asynchronous installer failures resume capture through the recovery callback', async () => {
  let resumed = 0;
  const f = fixture({ onInstallError: () => resumed++ });
  await f.updates.check();
  f.updater.emit('update-downloaded', { version: '1.5.2' });
  f.updater.quitAndInstall = () => f.updater.emit('error', Error('installer unavailable'));
  assert.equal(await f.updates.install(), false);
  assert.equal(resumed, 1);
  f.updater.emit('update-downloaded', { version: '1.5.2' });
  f.updater.quitAndInstall = () => {};
  assert.equal(await f.updates.install(), true);
  f.updater.emit('error', Error('spawn failed'));
  assert.equal(resumed, 2);
  assert.equal(f.updates.status().status, 'error');
});

test('background checks recur, retry failures sooner, and respect the current preference', async () => {
  const f = fixture();
  const scheduled = [];
  let enabled = true;
  const schedule = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  f.updates.startAutomatic(() => enabled, schedule, () => {});
  assert.equal(scheduled[0].ms, 20000);
  await scheduled[0].fn();
  assert.equal(f.checks(), 1);
  assert.equal(scheduled[1].ms, CHECK_INTERVAL);
  enabled = false;
  await scheduled[1].fn();
  assert.equal(f.checks(), 1);
  enabled = true;
  f.updater.checkForUpdates = async () => { throw Error('offline'); };
  await scheduled[2].fn();
  assert.equal(scheduled[3].ms, RETRY_INTERVAL);
  f.updates.stopAutomatic();
  const count = scheduled.length;
  await scheduled[3].fn();
  assert.equal(scheduled.length, count);
});

test('quitting during a background check does not create another timer', async () => {
  const f = fixture();
  const scheduled = [];
  let finish;
  f.updater.checkForUpdates = () => new Promise(resolve => { finish = resolve; });
  f.updates.startAutomatic(() => true, (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, () => {});
  const tick = scheduled[0].fn();
  await Promise.resolve();
  f.updates.stopAutomatic();
  finish({ isUpdateAvailable: false });
  await tick;
  assert.equal(scheduled.length, 1);
});
