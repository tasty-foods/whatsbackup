'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('../src/google-photos/picker-auth');
const { createConnector, mediaUrl, recordId } = require('../src/google-photos/picker');
const CLIENT = '123-picker.apps.googleusercontent.com';
const PHOTO = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const item = (id, type = 'PHOTO') => ({ id, type, createTime: '2021-06-14T12:00:00Z', mediaFile: { filename: type === 'VIDEO' ? 'original.mov' : 'photo #1.png', mimeType: type === 'VIDEO' ? 'video/quicktime' : 'image/png', baseUrl: 'https://lh3.googleusercontent.com/' + id, ...(type === 'VIDEO' ? { mediaFileMetadata: { videoMetadata: { processingStatus: 'READY' } } } : {}) } });
function fixture(t, { picked = [item('one'), item('duplicate'), item('clip', 'VIDEO')], fetchOverride, onSaved = () => {}, failIndex = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-google-picker-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('wb-google-picker-')); fs.rmSync(root, { recursive: true, force: true }); });
  const cfg = { IMAGES_DIR: path.join(root, 'images'), LOCAL_VIDEO_DIR: path.join(root, 'videos'), DOWNLOAD_TIMEOUT_MS: 1000 };
  const records = [], summaries = [], calls = [];
  let credentials = { clientId: CLIENT, accessToken: 'photos-access', refreshToken: 'photos-refresh', scope: auth.SCOPE, expiresAt: Date.now() + 3600000 };
  let failed = failIndex;
  const fetchImpl = async (url, options = {}) => {
    url = String(url); calls.push({ url, ...options });
    if (fetchOverride) { const result = await fetchOverride(url, options); if (result) return result; }
    if (url === auth.TOKEN_URL) return json({ access_token: 'renewed', token_type: 'Bearer', scope: auth.SCOPE, expires_in: 3600 });
    if (url.endsWith('/sessions') && options.method === 'POST') return json({ id: 'session-one', pickerUri: 'https://photos.google.com/picker/session-one', expireTime: new Date(Date.now() + 600000).toISOString(), mediaItemsSet: true });
    if (url.includes('/sessions/') && options.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.includes('/mediaItems?')) return json({ mediaItems: picked });
    if (url.startsWith('https://lh3.googleusercontent.com/')) {
      assert.ok(['Bearer photos-access', 'Bearer renewed'].includes(options.headers.Authorization));
      const video = url.includes('clip'); const bytes = video ? Buffer.from('high quality Google video bytes') : PHOTO;
      return new Response(bytes, { headers: { 'Content-Type': video ? 'video/mp4' : 'image/png', 'Content-Length': String(bytes.length) } });
    }
    throw new Error('Unexpected test URL: ' + url);
  };
  const api = createConnector({ settings: { read: () => ({ gmailClientId: CLIENT }) }, cfg, paths: { DATA_DIR: path.join(root, 'data') }, store: { listRecords: () => records, hiddenIds: () => new Set(), addRecord: record => { if (failed) { failed = false; throw Error('Disk full'); } records.push(record); return true; } }, history: { read: () => summaries.at(-1) || null, write: (_source, run) => summaries.push({ ...run }) }, fetchImpl, noteNewMedia: record => onSaved(record, api) });
  api.setVault({ load: async () => credentials, save: async value => { credentials = value; }, clear: async () => { credentials = null; } });
  return { root, cfg, records, summaries, calls, api, getCredentials: () => credentials, setCredentials: value => { credentials = value; api.setVault({ load: async () => credentials, save: async data => { credentials = data; }, clear: async () => { credentials = null; } }); } };
}

test('official Picker imports selected image/video downloads locally, preserves dates, verifies hashes and skips byte duplicates', async t => {
  const f = fixture(t); await f.api.init();
  assert.equal(f.api.getState().linked, true);
  assert.equal((await f.api.createSession()).ok, true);
  const result = await f.api.importSelected();
  assert.equal(result.complete, true); assert.equal(result.saved, 2); assert.equal(result.duplicates, 1);
  const image = f.records.find(r => r.kind === 'image'), video = f.records.find(r => r.kind === 'video');
  assert.deepEqual(fs.readFileSync(path.join(f.cfg.IMAGES_DIR, image.filename)), PHOTO);
  assert.equal(image.hash, crypto.createHash('sha256').update(PHOTO).digest('hex'));
  assert.equal(image.ts, 1623672000000); assert.equal(image.source, 'googlephotos'); assert.equal(image.importMethod, 'picker');
  assert.ok(video.filename.endsWith('.mp4')); assert.equal(video.mimetype, 'video/mp4');
  assert.equal(video.googlePhotosDownload, 'high-quality-transcoded-video');
  assert.ok(f.calls.some(c => c.url.endsWith('/one=d'))); assert.ok(f.calls.some(c => c.url.endsWith('/clip=dv')));
  assert.ok(f.calls.some(c => c.method === 'DELETE')); assert.equal(f.api.getState().session, null);
  assert.ok(!JSON.stringify(f.api.getState()).includes('photos-access'));
  await f.api.createSession(); const repeat = await f.api.importSelected(); assert.equal(repeat.saved, 0); assert.equal(repeat.skipped, 3);
  assert.equal(f.calls.filter(c => c.url.startsWith('https://lh3.')).length, 3);
  for (const directory of [f.cfg.IMAGES_DIR, f.cfg.LOCAL_VIDEO_DIR]) assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.part')), false);
});

test('Picker pagination and polling follow Google recommendations and never list before selection is ready', async t => {
  let now = Date.now(), gets = 0;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { picked: [], fetchOverride: (url, options) => {
    if (url.endsWith('/sessions') && options.method === 'POST') return json({ id: 'waiting', pickerUri: 'https://photos.google.com/picker/waiting', expireTime: new Date(now + 600000).toISOString(), mediaItemsSet: false, pollingConfig: { pollInterval: '1s', timeoutIn: '60s' } });
    if (url.endsWith('/sessions/waiting') && options.method !== 'DELETE') { gets++; return json({ id: 'waiting', mediaItemsSet: true }); }
    if (url.includes('/mediaItems?')) return json(new URL(url).searchParams.has('pageToken') ? { mediaItems: [item('two')] } : { mediaItems: [item('one')], nextPageToken: 'page-two' });
  } });
  await f.api.init(); await f.api.createSession();
  assert.equal((await f.api.importSelected()).ok, false);
  await f.api.checkSession(); assert.equal(gets, 0);
  now += 1500; await f.api.checkSession(); assert.equal(gets, 1); assert.equal(f.api.getState().session.ready, true);
  assert.equal((await f.api.importSelected()).complete, true);
  assert.equal(f.calls.filter(c => c.url.includes('/mediaItems?')).length, 2);
});

test('Picker never sends a bearer token to unapproved hosts, HTTP, credential-bearing or redirected external URLs', async t => {
  for (const url of ['http://lh3.googleusercontent.com/p', 'https://lh3.googleusercontent.com.evil.test/p', 'https://user:secret@lh3.googleusercontent.com/p', 'https://example.test/p', 'https://lh3.googleusercontent.com:8443/p']) assert.throws(() => mediaUrl(url), /unexpected/);
  const bad = item('external'); bad.mediaFile.baseUrl = 'https://evil.test/image';
  const f = fixture(t, { picked: [bad] }); await f.api.init(); await f.api.createSession();
  assert.equal((await f.api.importSelected()).failed, 1);
  assert.equal(f.calls.some(c => c.url.includes('evil.test')), false);
  const redirected = fixture(t, { picked: [item('redirect')], fetchOverride: url => url.includes('/redirect=d') ? new Response(null, { status: 302, headers: { location: 'https://evil.test/receive' } }) : null });
  await redirected.api.init(); await redirected.api.createSession(); assert.equal((await redirected.api.importSelected()).failed, 1);
  assert.equal(redirected.calls.some(c => c.url.includes('evil.test')), false);
});

test('Picker rejects HTML, incomplete or oversized downloads and videos still processing without indexing them', async t => {
  const pendingVideo = item('clip', 'VIDEO'); pendingVideo.mediaFile.mediaFileMetadata.videoMetadata.processingStatus = 'PROCESSING';
  const f = fixture(t, { picked: [item('page'), item('oversized'), pendingVideo], fetchOverride: url => url.includes('/page=d') ? new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'image/png' } }) : url.includes('/oversized=d') ? new Response('small', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(3 * 1024 ** 3) } }) : null });
  await f.api.init(); await f.api.createSession(); const result = await f.api.importSelected();
  assert.equal(result.failed, 3); assert.equal(result.complete, false); assert.equal(f.records.length, 0);
  assert.equal(f.calls.some(c => c.url.endsWith('/clip=dv')), false);
  assert.equal(fs.readdirSync(f.cfg.IMAGES_DIR).some(name => name.endsWith('.part')), false);
});

test('Picker cancellation preserves completed files and retry recovers index failures', async t => {
  let stopped = false;
  const f = fixture(t, { onSaved: (_record, api) => { if (!stopped) { stopped = true; queueMicrotask(() => api.cancel()); } } });
  await f.api.init(); await f.api.createSession(); const result = await f.api.importSelected();
  assert.equal(result.cancelled, true); assert.equal(f.records.length, 1); assert.equal(result.saved, 1);
  await f.api.shutdown();
  const failure = fixture(t, { picked: [item('one')], failIndex: true }); await failure.api.init(); await failure.api.createSession();
  assert.equal((await failure.api.importSelected()).complete, false);
  assert.equal(failure.records.length, 0);
  assert.equal((await failure.api.importSelected()).saved, 1); assert.equal(failure.records.length, 1);
});

test('expired tokens refresh independently from Gmail credentials and disconnect clears the Photos vault after active work', async t => {
  const f = fixture(t); f.setCredentials({ clientId: CLIENT, refreshToken: 'photos-only-refresh', accessToken: 'old', scope: auth.SCOPE, expiresAt: 1 });
  await f.api.init(); assert.equal((await f.api.createSession()).ok, true);
  const refresh = f.calls.find(c => c.url === auth.TOKEN_URL); assert.equal(new URLSearchParams(refresh.body).get('refresh_token'), 'photos-only-refresh');
  assert.equal(f.getCredentials().accessToken, 'renewed');
  assert.equal((await f.api.disconnect()).ok, true); assert.equal(f.getCredentials(), null); assert.equal(f.api.getState().linked, false);
  const wrong = fixture(t); wrong.setCredentials({ clientId: CLIENT, accessToken: 'gmail-token', scope: 'https://www.googleapis.com/auth/gmail.readonly', expiresAt: Date.now() + 3600000 });
  await wrong.api.init(); assert.equal(wrong.api.getState().linked, false); assert.equal((await wrong.api.createSession()).ok, false);
});

test('Photos OAuth uses PKCE, a narrow Photos scope and a verified loopback callback', async () => {
  let payload, saved;
  const session = await auth.startLoopback({ clientId: CLIENT, fetchImpl: async (_url, options) => { payload = new URLSearchParams(options.body); return json({ access_token: 'selected-photos-only', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer', scope: auth.SCOPE }); }, onTokens: async tokens => { saved = tokens; return { ok: true }; } });
  try {
    const url = new URL(session.authUrl), callback = new URL(url.searchParams.get('redirect_uri'));
    assert.equal(url.hostname, 'accounts.google.com'); assert.equal(url.searchParams.get('scope'), auth.SCOPE); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    callback.search = new URLSearchParams({ state: 'wrong', code: 'code' }); assert.equal((await fetch(callback)).status, 400); assert.equal(saved, undefined);
    callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }); assert.equal((await fetch(callback)).status, 200); await session.result;
    assert.equal(crypto.createHash('sha256').update(payload.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal(saved.accessToken, 'selected-photos-only'); assert.equal(payload.get('client_id'), CLIENT);
  } finally { session.cancel(); }
});

test('the shared Google Photos lease blocks concurrent operations and releases after failure', async t => {
  const lock = require('../src/google-photos/lock'), f = fixture(t); await f.api.init();
  const release = lock.acquire('takeout-test'); assert.ok(release);
  try { assert.equal((await f.api.createSession()).ok, false); assert.equal(f.api.getState().busy, false); assert.equal(f.api.getState().linked, true); }
  finally { release(); }
  assert.equal((await f.api.createSession()).ok, true);
  await f.api.disconnect(); assert.equal(lock.busy(), false);
});

test('disconnect waits for an in-flight secure token save before clearing the vault', async t => {
  const f = fixture(t); let releaseSave, saveStarted, cleared = 0;
  const started = new Promise(resolve => { saveStarted = resolve; });
  const gate = new Promise(resolve => { releaseSave = resolve; });
  f.api.setVault({ load: async () => null, save: async () => { saveStarted(); await gate; }, clear: async () => { cleared++; } });
  const begin = await f.api.beginConnect(); assert.equal(begin.ok, true);
  const url = new URL(begin.authUrl), callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'pending-code' });
  const response = fetch(callback); await started;
  const disconnecting = f.api.disconnect(); await new Promise(setImmediate);
  assert.equal(cleared, 0);
  releaseSave(); assert.equal((await disconnecting).ok, true); assert.equal((await response).status, 400);
  assert.equal(cleared, 1); assert.equal(f.api.getState().linked, false);
});

test('cancelling while the OAuth listener starts cannot leave a late pending sign-in or shared lease', async t => {
  const f = fixture(t), starting = f.api.beginConnect(), stopping = f.api.cancel();
  assert.equal((await starting).ok, false); assert.equal((await stopping).ok, true);
  assert.equal(f.api.getState().busy, false);
  assert.equal(require('../src/google-photos/lock').busy(), false);
});
