const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { photoLink, photoTime, walkLibrary } = require('../src/google-photos/library');
const { createDownloader, mediaType } = require('../src/google-photos/download');
const takeout = require('../src/google-photos/takeout');
const auth = require('../src/google-photos/auth');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-googlephotos-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('whatsbackup-googlephotos-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('timeline reads retain photos from recycled viewports, ignore outside links, and wait for the bottom', async () => {
  const snapshots = [
    { items: [{ href: '/photo/first' }], top: 0, height: 300, viewport: 100 },
    { items: [{ href: '/photo/first' }, { href: '/u/0/photo/second' }], top: 70, height: 300, viewport: 100 },
    { items: [{ href: '/photo/third' }, { href: 'https://elsewhere.test/photo/fake' }], top: 140, height: 300, viewport: 100 },
    { items: [{ href: '/photo/fourth' }], top: 200, height: 300, viewport: 100 },
  ];
  let index = 0;
  const page = { evaluate: async fn => fn.name === 'readViewport' ? snapshots[Math.min(index, snapshots.length - 1)] : index++ };
  const found = [];
  const result = await walkLibrary(page, async item => found.push(item.mediaId), { settleRounds: 2, wait: async () => {} });
  assert.deepEqual(found, ['first', 'second', 'third', 'fourth']);
  assert.equal(result.complete, true);
  assert.ok(index >= snapshots.length);
  assert.equal(photoLink('https://photos.google.com.evil.test/photo/id'), null);
  assert.equal(photoLink('/photo/id/other'), null);
});

test('an unreadable grid fails visibly, an empty library succeeds, and a scroll limit stays incomplete', async () => {
  const view = { items: [], top: 0, height: 100, viewport: 100, empty: false };
  const page = { evaluate: async fn => fn.name === 'readViewport' ? view : undefined };
  const options = { settleRounds: 1, wait: async () => {} };
  await assert.rejects(walkLibrary(page, async () => {}, options), /photo links could not be read/);
  view.empty = true;
  assert.equal((await walkLibrary(page, async () => {}, options)).complete, true);
  view.empty = false; view.items = [{ href: '/photo/one' }];
  assert.equal((await walkLibrary(page, async () => {}, { ...options, maxScrolls: 1 })).complete, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(walkLibrary(page, async () => {}, { signal: controller.signal }), { name: 'AbortError' });
});

test('photo dates are used only when readable, and downloads accept media rather than web pages or archives', () => {
  assert.equal(photoTime({ label: 'Photo - October 12, 2020, 10:20 AM' }, 123).dateSource, 'googlephotos');
  assert.deepEqual(photoTime({ label: 'IMG_2024.jpg' }, 123), { ts: 123, dateSource: 'import' });
  assert.equal(photoTime({ datetime: '2021-06-14T12:00:00Z' }, 123).ts, 1623672000000);
  assert.equal(mediaType('photo.HEIC').kind, 'image');
  assert.equal(mediaType('clip.MOV').kind, 'video');
  assert.throws(() => mediaType('photos.zip'), /unsupported/);
  assert.throws(() => mediaType('signin.html'), /unsupported/);
});

function downloadBrowser() {
  const session = new EventEmitter();
  const calls = [];
  session.send = async (name, args) => { calls.push({ name, args }); };
  session.detach = async () => {};
  return { session, calls, target: () => ({ createCDPSession: async () => session }) };
}

test('original downloads wait for completion, use a safe GUID path, and release their listeners', async t => {
  const root = temporary(t), browser = downloadBrowser();
  const downloader = await createDownloader(browser, root, 2000);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const page = {
    waitForSelector: async () => ({ click: async () => {} }), waitForFunction: async () => {},
    evaluate: async () => {
      browser.session.emit('Browser.downloadWillBegin', { guid: 'safe-guid', suggestedFilename: '../../original.png' });
      fs.writeFileSync(path.join(root, 'safe-guid'), bytes);
      browser.session.emit('Browser.downloadProgress', { guid: 'unrelated', state: 'completed' });
      browser.session.emit('Browser.downloadProgress', { guid: 'safe-guid', state: 'completed' });
    },
  };
  const result = await downloader.download(page);
  assert.equal(result.file, path.join(root, 'safe-guid'));
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(fs.readFileSync(result.file), bytes);
  assert.equal(browser.session.listenerCount('Browser.downloadProgress'), 0);
  assert.equal(browser.session.listenerCount('Browser.downloadWillBegin'), 0);
  await downloader.close();
});

test('stopping a pending original download cancels Chrome and releases the download lane', async t => {
  const root = temporary(t), browser = downloadBrowser();
  const downloader = await createDownloader(browser, root, 2000);
  const controller = new AbortController();
  const page = {
    waitForSelector: async () => ({ click: async () => {} }), waitForFunction: async () => {},
    evaluate: async () => {
      browser.session.emit('Browser.downloadWillBegin', { guid: 'stopped-guid', suggestedFilename: 'photo.jpg' });
      controller.abort(new Error('Stopped by user'));
    },
  };
  await assert.rejects(downloader.download(page, controller.signal), /Stopped by user/);
  assert.ok(browser.calls.some(call => call.name === 'Browser.cancelDownload' && call.args.guid === 'stopped-guid'));
  assert.equal(browser.session.listenerCount('Browser.downloadProgress'), 0);
  await downloader.close();
});

test('a download timeout cancels the original and clears listeners for a later retry', async t => {
  const browser = downloadBrowser();
  const downloader = await createDownloader(browser, temporary(t), 20);
  const page = {
    waitForSelector: async () => ({ click: async () => {} }), waitForFunction: async () => {},
    evaluate: async () => browser.session.emit('Browser.downloadWillBegin', { guid: 'timeout-guid', suggestedFilename: 'photo.jpg' }),
  };
  await assert.rejects(downloader.download(page), /timed out/);
  assert.ok(browser.calls.some(call => call.name === 'Browser.cancelDownload' && call.args.guid === 'timeout-guid'));
  assert.equal(browser.session.listenerCount('Browser.downloadProgress'), 0);
  await downloader.close();
});

function connector(t, { fail = [], cancelAfter = 0, localCancelAfter = 0, failIndexOnce = false } = {}) {
  const root = temporary(t), data = path.join(root, 'data'), profile = path.join(root, 'google-photos-session');
  fs.mkdirSync(data); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'linked.json'), '{}');
  const records = [], summaries = [], downloads = [], timers = [], nudges = [];
  let indexFailures = failIndexOnce ? 1 : 0;
  let prefs = { googlePhotosEnabled: false, googlePhotosScanHours: 6 };
  let items = [{ mediaId: 'first', label: 'Photo - June 14, 2021', url: 'https://photos.google.com/photo/first' }, { mediaId: 'duplicate', url: 'https://photos.google.com/photo/duplicate' }, { mediaId: 'clip', url: 'https://photos.google.com/photo/clip' }];
  const cfg = { IMAGES_DIR: path.join(root, 'images'), LOCAL_VIDEO_DIR: path.join(root, 'videos'), DOWNLOAD_TIMEOUT_MS: 1000 };
  let detailUrl = '';
  const overrides = {
    '../paths': { DATA_DIR: data, APP_HOME: root, GOOGLE_PHOTOS_DIR: profile },
    '../config': cfg,
    '../settings': { read: () => prefs },
    '../store': { has: id => records.some(rec => rec.id === id), listRecords: () => records, addRecord: rec => { if (indexFailures) { indexFailures--; throw new Error('Disk full'); } records.push(rec); return true; } },
    '../source-history': { read: () => summaries.at(-1) || null, write: (_source, run) => summaries.push({ ...run }) },
    '../ai': { noteNewMedia() { if (localCancelAfter && records.length >= localCancelAfter) context.module.exports.cancel(); } }, '../backup': { nudge: () => nudges.push(true) },
    './auth': auth, './takeout': takeout, './lock': require('../src/google-photos/lock'),
    './library': {
      ...require('../src/google-photos/library'),
      walkLibrary: async (_page, visit, { signal }) => {
        for (const item of items) {
          signal.throwIfAborted(); await visit(item);
          if (cancelAfter && records.length >= cancelAfter) context.module.exports.cancel();
        }
        signal.throwIfAborted();
        return { complete: true, found: items.length };
      },
    },
    './download': {
      ...require('../src/google-photos/download'),
      createDownloader: async (_browser, staging) => ({
        download: async () => {
          const name = detailUrl.split('/').pop().split('?')[0]; downloads.push(name);
          if (fail.includes(name)) throw new Error('Download failed for ' + name);
          const video = name === 'clip', file = path.join(staging, name);
          fs.writeFileSync(file, video ? 'original-video' : 'original-photo');
          return { file, filename: video ? 'clip.mov' : 'original.jpg', ext: video ? 'mov' : 'jpg', kind: video ? 'video' : 'image', mime: video ? 'video/quicktime' : 'image/jpeg' };
        }, close: async () => {},
      }),
    },
  };
  const context = vm.createContext({
    module: { exports: {} }, console: { log() {} }, process, Buffer, URL, AbortController,
    setTimeout: (fn, ms) => { const value = { fn, ms, unref() {} }; timers.push(value); return value; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    require: name => name in overrides ? overrides[name] : require(name),
    fixtureBrowser: { newPage: async () => ({ setDefaultTimeout() {}, setExtraHTTPHeaders: async () => {}, goto: async url => { detailUrl = url; }, url: () => detailUrl }) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/google-photos/index.js'), 'utf8'), context);
  vm.runInContext('launch = async () => fixtureBrowser; openPage = async () => ({}); requireSignIn = async () => { state.linked = true; }; closeBrowser = async () => {};', context);
  return { api: context.module.exports, root, data, cfg, records, summaries, downloads, timers, nudges, setPrefs: value => { prefs = value; }, setItems: value => { items = value; }, setLastRun: run => summaries.push(run) };
}

test('a scan preserves original bytes, imports video locally, skips byte duplicates, and resumes without downloading saved items', async t => {
  const fixture = connector(t);
  const first = await fixture.api.scan();
  assert.equal(first.complete, true);
  assert.equal(first.saved, 2);
  assert.equal(first.skipped, 1);
  assert.equal(first.failed, 0);
  assert.equal(fixture.records[0].source, 'googlephotos');
  assert.equal(fs.readFileSync(path.join(fixture.cfg.IMAGES_DIR, fixture.records[0].filename), 'utf8'), 'original-photo');
  assert.equal(fixture.records[0].dateSource, 'googlephotos');
  assert.equal(fs.readFileSync(path.join(fixture.cfg.LOCAL_VIDEO_DIR, fixture.records[1].filename), 'utf8'), 'original-video');
  assert.equal(fixture.records[1].kind, 'video');
  assert.match(fixture.records[1].serve, /^\/media\/videos\//);
  const second = await fixture.api.scan();
  assert.equal(second.saved, 0);
  assert.equal(second.skipped, 3);
  assert.equal(fixture.downloads.length, 3);
  assert.equal(fixture.api.getState().busy, false);
  assert.ok(fixture.nudges.length);
  assert.equal(fixture.summaries.length, 2);
  assert.ok(fixture.summaries[1].finishedAt);
  assert.deepEqual(fs.readdirSync(fixture.data).filter(name => name.startsWith('googlephotos-download-')), []);
});

test('a stopped import keeps completed photos and persists an incomplete summary for retry', async t => {
  const fixture = connector(t, { cancelAfter: 1 });
  const result = await fixture.api.scan();
  assert.equal(result.cancelled, true);
  assert.equal(result.saved, 1);
  assert.equal(result.failed, 0);
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.summaries[0].complete, false);
  assert.equal(fixture.summaries[0].cancelled, true);
  assert.equal(fixture.api.getState().busy, false);
  assert.equal(fixture.api.getState().stopping, false);
});

test('failures retain successful downloads and stop a broken connector after three failed downloads', async t => {
  const fixture = connector(t, { fail: ['bad1', 'bad2', 'bad3', 'bad4'] });
  fixture.setItems(['good', 'bad1', 'bad2', 'bad3', 'bad4'].map(mediaId => ({ mediaId, url: 'https://photos.google.com/photo/' + mediaId })));
  const result = await fixture.api.scan();
  assert.equal(result.ok, false);
  assert.equal(result.saved, 1);
  assert.equal(result.failed, 3);
  assert.equal(result.complete, false);
  assert.deepEqual(fixture.downloads, ['good', 'bad1', 'bad2', 'bad3']);
  assert.equal(fixture.summaries[0].firstError, 'Download failed for bad1');
  assert.equal(fixture.api.getState().busy, false);
});

test('automatic imports default off, rearm when enabled, and discard startup scans when disabled', t => {
  const fixture = connector(t);
  fixture.api.init();
  assert.equal(fixture.timers.length, 0);
  fixture.setPrefs({ googlePhotosEnabled: true, googlePhotosScanHours: 3 });
  fixture.api.init();
  assert.equal(fixture.timers[0].ms, 3 * 3600000);
  assert.equal(fixture.timers[1].ms, 180000);
  fixture.setPrefs({ googlePhotosEnabled: false, googlePhotosScanHours: 3 });
  fixture.api.schedule();
  assert.equal(fixture.timers[0].cleared, true);
  assert.equal(fixture.timers[1].cleared, true);
  assert.equal(fixture.api.getState().nextScanAt, null);
  fixture.timers[1].fn();
  assert.equal(fixture.downloads.length, 0);
});

test('forgetting Google Photos removes only its sign-in profile and retains the imported archive', async t => {
  const fixture = connector(t);
  await fixture.api.scan();
  const saved = path.join(fixture.cfg.IMAGES_DIR, fixture.records[0].filename);
  const forgetting = fixture.api.disconnect();
  assert.equal((await fixture.api.scan()).ok, false);
  assert.equal((await forgetting).ok, true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'google-photos-session')), false);
  assert.equal(fs.readFileSync(saved, 'utf8'), 'original-photo');
  assert.ok(fs.existsSync(path.join(fixture.data, 'googlephotos-seen.json')));
  assert.equal(fixture.api.getState().linked, false);
  assert.equal(fixture.api.getState().busy, false);
});

function takeoutFolder(fixture) {
  const root = path.join(fixture.root, 'Takeout', 'Google Photos');
  fs.mkdirSync(path.join(root, 'Photos from 2021'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Zzz album'), { recursive: true });
  const photo = path.join(root, 'Photos from 2021', 'image #1.png');
  const video = path.join(root, 'Photos from 2021', 'video.mov');
  fs.writeFileSync(photo, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
  fs.writeFileSync(video, 'exported original video');
  fs.copyFileSync(photo, path.join(root, 'Zzz album', 'same-image.png'));
  fs.writeFileSync(photo + '.supplemental-metadata.json', JSON.stringify({ title: 'image #1.png', description: 'Original export description', photoTakenTime: { timestamp: '1623672000' }, geoData: { latitude: 1 } }));
  fs.writeFileSync(video + '.json', JSON.stringify({ photoTakenTime: { timestamp: '1623758400' } }));
  fs.writeFileSync(path.join(root, 'not-a-photo.mbox'), 'irrelevant export');
  fs.writeFileSync(path.join(root, 'archive.zip'), 'not extracted');
  return { root, photo, video };
}

test('Takeout folder import preserves originals and sidecar dates, deduplicates albums and resumes without browser sign-in', async t => {
  const f = connector(t), exported = takeoutFolder(f);
  const pending = f.api.importFolder({ folder: exported.root });
  assert.equal(f.api.getState().busy, true);
  assert.equal(f.api.getState().progress.phase, 'takeout');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.method, 'takeout');
  assert.equal(result.complete, true);
  assert.equal(result.saved, 2);
  assert.equal(result.skipped, 1);
  assert.ok(result.ignored >= 4);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.api.getState().linked, false);
  const image = f.records.find(r => r.kind === 'image'), video = f.records.find(r => r.kind === 'video');
  assert.equal(image.ts, 1623672000000);
  assert.equal(image.caption, 'Original export description');
  assert.equal(video.ts, 1623758400000);
  assert.equal(image.importMethod, 'takeout');
  assert.deepEqual(fs.readFileSync(path.join(f.cfg.IMAGES_DIR, image.filename)), fs.readFileSync(exported.photo));
  assert.deepEqual(fs.readFileSync(path.join(f.cfg.LOCAL_VIDEO_DIR, video.filename)), fs.readFileSync(exported.video));
  const again = await f.api.importFolder({ folder: exported.root });
  assert.equal(again.saved, 0);
  assert.equal(again.skipped, 3);
  assert.equal(f.records.length, 2);
  assert.ok(fs.existsSync(exported.photo));
  assert.ok(fs.existsSync(exported.video));
  assert.equal(f.api.getState().takeoutSupported, true);
});

test('Takeout refuses invalid and archive-overlapping folders and excludes symlinks and unrelated files', async t => {
  const f = connector(t), exported = takeoutFolder(f), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.png'), 'outside');
  fs.symlinkSync(outside, path.join(exported.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.api.importFolder({ folder: exported.root });
  assert.equal(result.saved, 2);
  assert.equal(f.records.some(r => r.docName === 'private.png'), false);
  for (const folder of ['', 'relative', path.parse(f.root).root, f.cfg.IMAGES_DIR, f.root, exported.photo]) {
    const bad = await f.api.importFolder({ folder });
    assert.equal(bad.ok, false, folder);
    assert.equal(bad.complete, false);
  }
  const zipOnly = path.join(f.root, 'zip-only'); fs.mkdirSync(zipOnly); fs.writeFileSync(path.join(zipOnly, 'takeout.zip'), 'compressed');
  assert.match((await f.api.importFolder({ folder: zipOnly })).error, /Extract every Google Photos Takeout ZIP/);
  assert.equal(f.records.length, 2);
});

test('Takeout cancellation retains completed files, keeps the export untouched and supports retry', async t => {
  const f = connector(t, { localCancelAfter: 1 }), exported = takeoutFolder(f);
  const result = await f.api.importFolder({ folder: exported.root });
  assert.equal(result.cancelled, true);
  assert.equal(result.complete, false);
  assert.equal(result.saved, 1);
  assert.equal(f.api.getState().busy, false);
  assert.ok(fs.existsSync(exported.photo));
  assert.ok(fs.existsSync(exported.video));
  const retried = await f.api.importFolder({ folder: exported.root });
  assert.equal(retried.saved, 1);
  assert.equal(f.records.length, 2);
});

test('Takeout index failure stays incomplete and a later retry recovers the verified copied file', async t => {
  const f = connector(t, { failIndexOnce: true }), exported = takeoutFolder(f);
  const result = await f.api.importFolder({ folder: exported.root });
  assert.equal(result.complete, false);
  assert.equal(result.failed, 1);
  assert.equal(f.summaries[0].firstError, 'Disk full');
  const retried = await f.api.importFolder({ folder: exported.root });
  assert.equal(retried.complete, true);
  assert.equal(f.records.length, 2);
  for (const directory of [f.cfg.IMAGES_DIR, f.cfg.LOCAL_VIDEO_DIR]) assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.part')), false);
});

test('Takeout metadata handles duplicate suffixes, truncated sidecar filenames and historical dates without importing arbitrary fields', async t => {
  const root = temporary(t), file = path.join(root, 'summer(1).jpg');
  fs.writeFileSync(file, 'photo');
  fs.writeFileSync(path.join(root, 'summer.jpg(1).json'), JSON.stringify({ title: 'summer(1).jpg', photoTakenTime: { timestamp: '-100' }, geoData: { latitude: 12 } }));
  const metadataFor = takeout.metadataReader(), item = { name: 'summer(1).jpg', directory: root, sidecars: ['summer.jpg(1).json'] };
  const metadata = await metadataFor(item);
  assert.equal(takeout.takenTime(metadata, 123).ts, -100000);
  assert.equal(metadata.geoData, undefined);
  const other = 'a-very-long-original-file-title.jpg';
  fs.writeFileSync(path.join(root, 'shortened.supplemental-metadata.json'), JSON.stringify({ title: other, creationTime: { timestamp: '0' } }));
  assert.equal(takeout.takenTime(await metadataFor({ name: other, directory: root, sidecars: ['summer.jpg(1).json', 'shortened.supplemental-metadata.json'] }), 123).ts, 0);
  assert.equal(takeout.takenTime({ photoTakenTime: { timestamp: '' } }, 123).ts, 123);
});

test('failed Google Photos account checks survive restart and a cached marker is never a verified connection', t => {
  const f = connector(t);
  f.setPrefs({ googlePhotosEnabled: true, googlePhotosScanHours: 6 });
  f.setLastRun({ failed: 1, complete: false, firstError: 'Could not read the Google Photos account.', finishedAt: 123 });
  f.api.init();
  const state = f.api.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.linked, false);
  assert.equal(state.connectionVerified, false);
  assert.equal(state.hasSavedSession, true);
  assert.match(state.lastError, /Could not read/);
  assert.equal(state.lastScanAt, 123);
  assert.equal(f.timers.length, 0);
});

test('Google auth detects rejected login and accepts localized account controls or photo grids only at the Photos origin', async () => {
  const page = (url, signals) => ({ url: () => url, isClosed: () => false, evaluate: async () => signals });
  assert.equal((await auth.inspect(page('https://accounts.google.com/signin/rejected', {}))).blocked, true);
  assert.equal((await auth.inspect(page('https://accounts.google.com/signin', { blocked: true }))).ready, false);
  assert.equal((await auth.inspect(page('https://photos.google.com/', { account: true }))).ready, true);
  assert.equal((await auth.inspect(page('https://photos.google.com/', { account: true, blocked: true }))).blocked, false);
  assert.equal((await auth.inspect(page('https://photos.google.com/', { photos: true }))).ready, true);
  assert.equal((await auth.inspect(page('https://photos.google.com.evil.test/', { photos: true }))).ready, false);
  assert.match(auth.blockedMessage(), /Takeout/);
  const flags = vm.runInNewContext('(' + auth.readAuthSignals.toString() + ')()', { document: { body: { innerText: 'This browser or app may not be secure' }, querySelector: () => null, querySelectorAll: () => [] } });
  assert.equal(flags.blocked, true);
});

test('localized empty photo libraries are distinct from unreadable loading pages', () => {
  const { readViewport } = require('../src/google-photos/library');
  for (const text of ["Geen foto's", 'Aucune photo', 'Keine Fotos', 'אין תמונות']) {
    const body = { innerText: text, scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
    const view = vm.runInNewContext('(' + readViewport.toString() + ')()', { document: { body, scrollingElement: body, querySelectorAll: () => [] } });
    assert.equal(view.empty, true, text);
  }
});

test('an index write failure leaves a photo available for retry instead of claiming it was saved', () => {
  let fail = true;
  const disk = [];
  const context = {
    module: { exports: {} }, require: name => name === 'fs' ? {
      appendFileSync: (_file, data) => { if (fail) throw new Error('Disk full'); disk.push(data); },
    } : name === './config' ? { INDEX_FILE: 'index' } : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/store.js'), 'utf8'), context);
  const store = context.module.exports;
  assert.throws(() => store.addRecord({ id: 'photo', ts: 1 }), /Disk full/);
  assert.equal(store.has('photo'), false);
  assert.equal(store.get('photo'), null);
  fail = false;
  assert.equal(store.addRecord({ id: 'photo', ts: 1 }), true);
  assert.equal(store.has('photo'), true);
  assert.equal(disk.length, 1);
});

test('Google Photos API rejects unlinked or busy scans, validates schedules, and counts its media separately', async t => {
  const root = temporary(t), calls = [];
  const state = { linked: false, busy: false };
  const googlePhotos = {
    getState: () => state,
    connect: async () => { calls.push('connect'); state.busy = true; },
    scan: async () => { calls.push('scan'); },
    cancel: () => ({ ok: true }), disconnect: async () => ({ ok: true }),
    checkLink: async () => true, schedule: () => calls.push('schedule'),
  };
  const load = (file, overrides) => {
    const context = { module: { exports: {} }, console, process, Buffer, URL,
      require: name => name in overrides ? overrides[name] : name.startsWith('./') ? {} : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
    return context.module.exports;
  };
  const settings = load('settings.js', { './paths': { DATA_DIR: root } });
  const createApp = load('web.js', {
    './config': { PUBLIC_DIR: path.resolve(__dirname, '../public'), DATA_DIR: root, IMAGES_DIR: root, VIDEO_DIR: root, LOCAL_VIDEO_DIR: root, FILES_DIR: root, CLOUD_ROOT: '', APP_HOME: root },
    './paths': { DATA_DIR: root, GOOGLE_PHOTOS_DIR: path.join(root, 'google-photos-session') }, './settings': settings,
    './logger': { FILE: path.join(root, 'log') }, './cleanup': { QUARANTINE_DIR: root },
    './media-export': require('../src/media-export'),
    './store': { get: () => null, hiddenIds: () => new Set(['hidden']), listRecords: () => [
      { id: 'legacy', size: 10 }, { id: 'google-photo', source: 'googlephotos', size: 20 },
      { id: 'google-video', source: 'googlephotos', kind: 'video', size: 30 },
      { id: 'hidden', source: 'googlephotos', size: 999 }, { id: 'sample', source: 'googlephotos', sample: true, size: 999 },
    ] }, './google-photos': googlePhotos, './google-photos/picker': { getState: () => ({ busy: false }) },
  });
  const server = await new Promise(resolve => { const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body = {}, origin = base) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post('/api/google-photos/scan')).status, 409);
  assert.equal((await post('/api/google-photos/connect', {}, 'https://other.test')).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await post('/api/google-photos/connect')).status, 200);
  assert.deepEqual(calls, ['connect']);
  assert.equal((await post('/api/google-photos/scan')).status, 409);
  state.busy = false; state.linked = true;
  assert.equal((await post('/api/google-photos/scan')).status, 200);
  assert.deepEqual(calls, ['connect', 'scan']);
  const updated = await (await post('/api/settings', { googlePhotosEnabled: true, googlePhotosScanHours: 12 })).json();
  assert.equal(updated.restartRequired, false);
  assert.equal(settings.read().googlePhotosScanHours, 12);
  assert.equal(calls.at(-1), 'schedule');
  const rejected = await (await post('/api/settings', { googlePhotosScanHours: 'bad', googlePhotosEnabled: 'true' })).json();
  assert.deepEqual(rejected.rejected, ['googlePhotosScanHours', 'googlePhotosEnabled']);
  const summary = await (await fetch(base + '/api/sources/summary')).json();
  assert.deepEqual(summary.googlephotos, { count: 2, bytes: 50 });
  assert.deepEqual(summary.whatsapp, { count: 1, bytes: 10 });
});
