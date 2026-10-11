'use strict';

// Keep update state in the desktop process. A failed request must never leave
// the window saying "Checking…", or be mistaken for a successful check.
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
const RETRY_INTERVAL = 15 * 60 * 1000;

function createUpdates({ getUpdater, packaged, current, notify = () => {}, onInstallError = () => {}, logger = console, now = Date.now }) {
  let updater;
  let checking;
  let timer;
  let state = { status: 'idle', version: null, latestVersion: null, percent: 0, error: null, checkedAt: 0, attemptedAt: 0 };
  const status = () => ({ ...state, current, packaged });
  const change = patch => { state = { ...state, ...patch }; };
  const fail = error => {
    const wasInstalling = state.status === 'installing';
    change({ status: 'error', error: String(error && error.message || error || 'Update check failed').slice(0, 2000) });
    logger.error('[update] ' + state.error);
    if (wasInstalling) onInstallError();
  };

  function setup() {
    if (updater) return updater;
    const candidate = getUpdater();
    candidate.logger = logger;
    candidate.autoDownload = true;
    candidate.autoInstallOnAppQuit = true;
    candidate.autoRunAppAfterInstall = true;
    candidate.allowDowngrade = false;
    candidate.allowPrerelease = false;
    candidate.disableWebInstaller = true;
    candidate.on('checking-for-update', () => change({ status: 'checking', error: null }));
    candidate.on('update-available', info => {
      change({ status: 'downloading', version: info.version, latestVersion: info.version, percent: 0, error: null });
    });
    candidate.on('update-not-available', info => {
      change({ status: 'current', version: null, latestVersion: info && info.version || current, percent: 0, error: null, checkedAt: now() });
    });
    candidate.on('download-progress', progress => {
      change({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0))) });
    });
    candidate.on('update-downloaded', info => {
      const alreadyReady = state.status === 'ready' && state.version === info.version;
      change({ status: 'ready', version: info.version, latestVersion: info.version, percent: 100, error: null, checkedAt: now() });
      if (!alreadyReady) notify(info.version);
    });
    candidate.on('error', fail);
    updater = candidate;
    return updater;
  }

  function check() {
    if (!packaged) {
      change({ status: 'source', error: null });
      return Promise.resolve(status());
    }
    if (checking) return checking;
    if (['downloading', 'ready', 'installing'].includes(state.status)) return Promise.resolve(status());
    change({ status: 'checking', error: null, version: null, percent: 0, attemptedAt: now() });
    checking = Promise.resolve().then(() => setup().checkForUpdates()).then(result => {
      if (!result) throw new Error('The desktop updater is unavailable. Reinstall the latest Windows release.');
      change({ checkedAt: now() });
      // electron-updater emits an error for most download failures, but still
      // consume the promise so a rejection cannot become unhandled.
      if (result.downloadPromise) result.downloadPromise.catch(fail);
      return status();
    }).catch(error => { fail(error); return status(); }).finally(() => { checking = null; });
    return checking;
  }

  async function install(beforeInstall = () => {}) {
    if (!updater || state.status !== 'ready') return false;
    change({ status: 'installing', error: null });
    try {
      await beforeInstall();
      updater.quitAndInstall(true, true);
      return state.status !== 'error'; // The updater may emit a synchronous install error.
    } catch (error) { fail(error); return false; }
  }

  function startAutomatic(enabled, schedule = setTimeout, cancel = clearTimeout) {
    stopAutomatic();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      // Read the preference each time, so changing it works without a restart.
      if (enabled()) await check();
      if (!stopped) timer = { id: schedule(tick, state.status === 'error' ? RETRY_INTERVAL : CHECK_INTERVAL), cancel, stop: () => { stopped = true; } };
    };
    timer = { id: schedule(tick, 20000), cancel, stop: () => { stopped = true; } };
  }

  function stopAutomatic() {
    if (timer) { timer.stop(); timer.cancel(timer.id); timer = null; }
  }

  return { check, status, install, startAutomatic, stopAutomatic };
}

module.exports = { createUpdates, CHECK_INTERVAL, RETRY_INTERVAL };
