'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createConnector } = require('../src/gmail');
const { startLoopback, tokenRequest, SCOPE, TOKEN_URL } = require('../src/gmail/auth');
const { attachments, safeName, mediaKind, recordId, provenance } = require('../src/gmail/mime');
const { createApi } = require('../src/gmail/client');
const { saveAttachment } = require('../src/gmail/files');
const CLIENT = 'fixture-client.apps.googleusercontent.com';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const bytes = value => Buffer.from(value).toString('base64url');
const part = (id, name, value, mime = 'application/pdf', external = false) => ({ partId: id, filename: name, mimeType: mime, body: { size: Buffer.byteLength(value), ...(external ? { attachmentId: 'att-' + id } : { data: bytes(value) }) } });
const message = (id, parts, subject = 'Project attachment') => ({ id, threadId: 'thread-' + id, internalDate: '1700000000000', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Supplier <supplier@example.test>' }, { name: 'Subject', value: subject }], parts } });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-gmail-'));
  const data = path.join(root, 'data'), cfg = { IMAGES_DIR: path.join(root, 'images'), LOCAL_VIDEO_DIR: path.join(root, 'videos'), VIDEO_DIR: path.join(root, 'cloud-videos'), FILES_DIR: path.join(root, 'files') };
  fs.mkdirSync(data);
  const records = [], requests = [], summaries = [], secureWrites = [], hidden = new Set();
  let prefs = { gmailClientId: CLIENT, gmailEnabled: false, gmailQuery: 'has:attachment', gmailSyncMinutes: 0, gmailMaxAttachmentMB: 25, gmailMaxMessagesPerSync: 500, ...options.settings };
  let credentials = { clientId: CLIENT, account: 'owner@example.test', accessToken: 'unit-test-access-token', refreshToken: 'unit-test-refresh-token', expiresAt: Date.now() + 3600000, scope: SCOPE };
  const messages = options.messages || { m1: message('m1', [part('1', 'invoice.pdf', 'invoice')]) }, pages = options.pages || { first: { messages: Object.keys(messages).map(id => ({ id })) } }, bodies = options.bodies || {};
  const fetchImpl = async (input, init) => {
    const url = new URL(input); requests.push({ url, init });
    if (options.intercept) { const response = await options.intercept(url, init, requests); if (response) return response; }
    if (url.href === TOKEN_URL) return json({ access_token: 'unit-refreshed-access', expires_in: 3600, token_type: 'Bearer', scope: SCOPE });
    assert.equal(url.origin, 'https://gmail.googleapis.com'); assert.equal(init.method, 'GET');
    const resource = url.pathname.replace('/gmail/v1/users/me/', '');
    if (resource === 'profile') return json({ emailAddress: 'owner@example.test' });
    if (resource === 'messages') return json(pages[url.searchParams.get('pageToken') || 'first']);
    if (/^messages\/[^/]+$/.test(resource)) return json(messages[decodeURIComponent(resource.split('/')[1])]);
    const attachmentId = decodeURIComponent(resource.split('/').at(-1));
    if (attachmentId in bodies) return json(bodies[attachmentId]);
    throw new Error('Unexpected fixture request: ' + resource);
  };
  let api;
  const dependencies = { settings: { read: () => prefs }, cfg, paths: { DATA_DIR: data },
    store: { listRecords: () => records.filter(record => !hidden.has(record.id)), get: id => records.find(record => record.id === id), has: id => records.some(record => record.id === id), hiddenIds: () => hidden, addRecord: record => { if (records.some(existing => existing.id === record.id)) return false; records.push(record); return true; } },
    history: { read: () => summaries.at(-1) || null, write: (_source, run) => summaries.push(JSON.parse(JSON.stringify(run))) }, fetchImpl,
    noteNewMedia: record => options.onSave?.(record, api), nudgeBackup: () => {}, };
  api = createConnector(dependencies);
  const vault = { load: async () => credentials, save: async value => { if (options.vaultFailure) throw Error('Secure storage failed'); credentials = JSON.parse(JSON.stringify(value)); secureWrites.push(credentials); }, clear: async () => { credentials = null; } };
  api.setVault(vault);
  t.after(async () => {
    await api.shutdown();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('whatsbackup-gmail-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { api, root, data, cfg, records, requests, messages, pages, bodies, summaries, secureWrites, hidden, dependencies, vault, credentials: () => credentials, setCredentials: value => { credentials = value; }, setPrefs: patch => { prefs = { ...prefs, ...patch }; }, journal: () => fs.readFileSync(path.join(data, 'gmail-attachments.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('Gmail MIME traversal preserves nested and inline attachments while excluding message text bodies', () => {
  const found = attachments({ mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: bytes('email body'), size: 10 } },
    { mimeType: 'multipart/related', parts: [part('image', '', 'png', 'image/png'), part('document', '../../order.pdf', 'pdf')] },
  ] });
  assert.equal(found.length, 2); assert.equal(found[0].mime, 'image/png'); assert.equal(found[1].filename, '../../order.pdf');
  assert.equal(safeName('..\\..\\NUL.exe', 'application/octet-stream'), '_NUL.exe.download');
  assert.equal(safeName('a:b?.pdf', 'application/pdf'), 'a_b_.pdf');
  assert.equal(mediaKind('application/octet-stream', 'movie.MOV'), 'video');
  assert.equal(mediaKind('image/svg+xml', 'diagram.svg'), 'document');
  assert.notEqual(recordId('one@example.test', 'm', '1'), recordId('two@example.test', 'm', '1'));
  assert.equal(provenance(message('m', []), 'one@example.test', found[0]).originalTimestamp, 1700000000000);
});

test('Gmail OAuth uses a loopback callback, PKCE S256 and only read-only scope; invalid state cannot complete sign-in', async t => {
  let fields, granted;
  const connection = await startLoopback({ clientId: CLIENT, clientSecret: 'fixture-optional-secret', fetchImpl: async (url, init) => { assert.equal(url, TOKEN_URL); fields = new URLSearchParams(init.body); return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: SCOPE, expires_in: 3600 }); }, onTokens: value => { granted = value; return { account: 'owner@example.test' }; } });
  t.after(() => connection.cancel());
  const url = new URL(connection.authUrl), redirect = new URL(url.searchParams.get('redirect_uri'));
  assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), SCOPE); assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const bad = new URL(redirect); bad.search = new URLSearchParams({ state: 'é'.repeat(url.searchParams.get('state').length), code: 'not-authorized' });
  assert.equal((await fetch(bad)).status, 400); assert.equal(granted, undefined);
  const good = new URL(redirect); good.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'local-test-code' });
  const response = await fetch(good); assert.equal(response.status, 200); assert.match(await response.text(), /return to WhatsBackUp/);
  assert.deepEqual(await connection.result, { account: 'owner@example.test' });
  assert.equal(crypto.createHash('sha256').update(fields.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(fields.get('client_secret'), 'fixture-optional-secret'); assert.equal(granted.refreshToken, 'fixture-refresh');
});

test('Gmail OAuth denial, missing client setup and missing read-only scope fail visibly', async t => {
  await assert.rejects(startLoopback({ clientId: '', onTokens() {} }), /Desktop app client ID/);
  const connection = await startLoopback({ clientId: CLIENT, onTokens: () => assert.fail('Denied authorization must not produce tokens') }); t.after(() => connection.cancel());
  const auth = new URL(connection.authUrl), callback = new URL(auth.searchParams.get('redirect_uri')); callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), error: 'access_denied' });
  assert.equal((await fetch(callback)).status, 400); await assert.rejects(connection.result, /cancelled or denied/);
  await assert.rejects(tokenRequest({ client_id: CLIENT }, { fetchImpl: async () => json({ access_token: 'fixture', scope: 'https://www.googleapis.com/auth/drive.readonly' }) }), /read-only access was not granted/);
});

test('Gmail imports attachment IDs, inline data and paginated photos/videos/documents/audio; SHA256 duplicates retain both email origins', async t => {
  const f = fixture(t, {
    messages: {
      m1: message('m1', [part('photo', '../../photo.png', 'photo-bytes', 'image/png', true), part('pdf', 'order.pdf', 'pdf-bytes')], 'First order'),
      m2: message('m2', [part('duplicate', 'same-photo.png', 'photo-bytes', 'image/png')], 'Second email with same photo'),
      m3: message('m3', [part('video', 'clip.mp4', 'video-bytes', 'video/mp4'), part('audio', 'note.mp3', 'audio-bytes', 'audio/mpeg'), part('archive', 'parts.zip', 'zip-bytes', 'application/zip')]),
    },
    pages: { first: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'page-two' }, 'page-two': { messages: [{ id: 'm3' }] } },
    bodies: { 'att-photo': { size: 11, data: bytes('photo-bytes') } },
  });
  await f.api.init(); const run = await f.api.sync();
  assert.equal(run.complete, true); assert.equal(run.saved, 5); assert.equal(run.duplicates, 1); assert.equal(run.messages, 3);
  assert.deepEqual(f.records.map(record => record.kind).sort(), ['audio', 'document', 'document', 'image', 'video']);
  const aliases = f.journal(); assert.equal(aliases.length, 6);
  const photos = aliases.filter(alias => alias.provenance.originalFilename.includes('photo.png'));
  assert.equal(photos[0].recordId, photos[1].recordId); assert.notEqual(photos[0].provenance.subject, photos[1].provenance.subject);
  for (const record of f.records) {
    const directory = record.kind === 'image' ? f.cfg.IMAGES_DIR : record.kind === 'video' ? f.cfg.LOCAL_VIDEO_DIR : f.cfg.FILES_DIR;
    assert.equal(path.basename(record.filename), record.filename);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, record.filename))).digest('hex'), record.hash);
  }
  const downloaded = f.requests.filter(request => request.url.pathname.includes('/attachments/')).length;
  const second = await f.api.sync(); assert.equal(second.saved, 0); assert.equal(second.skipped, 6);
  assert.equal(f.requests.filter(request => request.url.pathname.includes('/attachments/')).length, downloaded);
  assert.ok(!fs.existsSync(path.join(f.data, 'gmail-checkpoint.json')));
  assert.ok(f.requests.filter(request => request.url.origin === 'https://gmail.googleapis.com').every(request => request.init.method === 'GET'));
  assert.doesNotMatch(fs.readFileSync(path.join(f.data, 'gmail-attachments.ndjson'), 'utf8'), /unit-test-access-token|unit-test-refresh-token/);
});

test('bounded Gmail runs persist pending messages and page tokens across connector restarts', async t => {
  const f = fixture(t, { settings: { gmailMaxMessagesPerSync: 1 }, messages: { m1: message('m1', [part('a', 'a.pdf', 'a')]), m2: message('m2', [part('b', 'b.pdf', 'b')]), m3: message('m3', [part('c', 'c.pdf', 'c')]) }, pages: { first: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'second' }, second: { messages: [{ id: 'm3' }] } } });
  let run = await f.api.sync(); assert.equal(run.saved, 1); assert.equal(run.complete, false); assert.equal(f.api.status().resumable, true);
  const restarted = createConnector(f.dependencies); restarted.setVault(f.vault); t.after(() => restarted.shutdown()); await restarted.init();
  run = await restarted.sync(); assert.equal(run.saved, 1); assert.equal(run.complete, false);
  run = await restarted.sync(); assert.equal(run.saved, 1); assert.equal(run.complete, true); assert.equal(f.records.length, 3);
  assert.equal(f.requests.filter(request => request.url.pathname.endsWith('/messages') && !request.url.searchParams.get('pageToken')).length, 1);
});

test('stopping Gmail preserves a completed file and resumes unfinished MIME parts without duplicate originals', async t => {
  let stopped = false;
  const f = fixture(t, { messages: { m1: message('m1', [part('first', 'a.pdf', 'first'), part('second', 'b.pdf', 'second')]) }, onSave: (_record, api) => { if (!stopped) { stopped = true; api.stop(); } } });
  const interrupted = await f.api.sync(); assert.equal(interrupted.cancelled, true); assert.equal(f.records.length, 1); assert.equal(f.api.status().resumable, true);
  const resumed = await f.api.sync(); assert.equal(resumed.complete, true); assert.equal(resumed.saved, 1); assert.equal(f.records.length, 2);
  assert.equal(fs.readdirSync(f.cfg.FILES_DIR).filter(name => name.endsWith('.gmail-part')).length, 0);
});

test('Gmail size limits avoid oversized downloads; malformed bytes remain retryable and leave no partial files', async t => {
  const f = fixture(t, { settings: { gmailMaxAttachmentMB: 1 }, messages: { m1: message('m1', [{ partId: 'oversized', filename: 'huge.pdf', mimeType: 'application/pdf', body: { attachmentId: 'too-large', size: 2 * 1024 * 1024 } }, { partId: 'bad', filename: 'bad.pdf', mimeType: 'application/pdf', body: { size: 3, data: '%%%%' } }]) } });
  const result = await f.api.sync(); assert.equal(result.failed, 1); assert.equal(result.skipped, 1); assert.equal(f.records.length, 0);
  assert.equal(f.requests.filter(request => request.url.pathname.includes('/attachments/')).length, 0);
  assert.equal(fs.readdirSync(f.cfg.FILES_DIR).length, 0);
  f.messages.m1.payload.parts.pop();
  assert.equal((await f.api.sync()).complete, true);
  await assert.rejects(saveAttachment({ data: bytes('valid'), directory: f.cfg.FILES_DIR, filename: '../escape', limitBytes: 1024, declaredSize: 5 }), /Invalid attachment filename/);
});

test('Gmail refreshes expired access via secure vault and never writes OAuth tokens into its journal/checkpoint', async t => {
  const f = fixture(t); f.setCredentials({ ...f.credentials(), expiresAt: 1 }); f.api.setClientSecret('fixture-optional-secret');
  assert.equal((await f.api.sync()).saved, 1);
  const refreshed = f.requests.find(request => request.url.href === TOKEN_URL); assert.ok(refreshed);
  const fields = new URLSearchParams(refreshed.init.body); assert.equal(fields.get('grant_type'), 'refresh_token'); assert.equal(fields.get('client_secret'), 'fixture-optional-secret');
  assert.equal(f.secureWrites.length, 1); assert.equal(f.credentials().refreshToken, 'unit-test-refresh-token'); assert.equal(f.credentials().accessToken, 'unit-refreshed-access');
  assert.equal(JSON.stringify(f.api.status()).includes('unit-refreshed-access'), false);
  await f.api.disconnect(); assert.equal(f.credentials(), null); assert.equal(f.records.length, 1); assert.equal(f.api.status().linked, false);
});

test('Gmail retries one rejected access token, and revoked refresh grants require reconnection', async t => {
  let rejected = false;
  const f = fixture(t, { intercept: (url, init) => { if (url.pathname.endsWith('/profile') && !rejected) { rejected = true; return json({}, 401); } } });
  assert.equal((await f.api.sync()).saved, 1); assert.equal(f.requests.filter(request => request.url.href === TOKEN_URL).length, 1);
  const revoked = fixture(t, { intercept: url => url.href === TOKEN_URL ? json({ error: 'invalid_grant', error_description: 'Never leak raw errors' }, 400) : null });
  revoked.setCredentials({ ...revoked.credentials(), expiresAt: 1 });
  const result = await revoked.api.sync(); assert.equal(result.ok, false); assert.match(result.error, /revoked/); assert.equal(revoked.api.status().linked, false);
});

test('Gmail API bounds response bytes and retries temporary read failures with a bounded delay', async () => {
  let calls = 0; const delays = [];
  const api = createApi({ getAccessToken: async () => 'fixture', refreshToken: async () => 'fixture', delay: async ms => delays.push(ms), fetchImpl: async () => ++calls === 1 ? json({}, 429) : json({ emailAddress: 'owner@example.test' }) });
  assert.equal((await api.profile()).emailAddress, 'owner@example.test'); assert.deepEqual(delays, [1000]);
  const large = createApi({ getAccessToken: async () => 'fixture', refreshToken: async () => 'fixture', fetchImpl: async () => new Response('"data"', { headers: { 'content-length': '2000000' } }) });
  await assert.rejects(large.profile(), /more data/);
});

test('Gmail connector requires secure desktop storage and exposes explicit OAuth setup failures', async t => {
  const f = fixture(t); f.api.setVault(null);
  assert.match((await f.api.beginConnect()).error, /installed desktop app/);
  f.api.setVault(f.vault); f.setPrefs({ gmailClientId: '' });
  assert.match((await f.api.beginConnect()).error, /Desktop app client ID/);
  assert.equal(f.api.status().busy, false);
  f.setPrefs({ gmailClientId: CLIENT });
  const pending = await f.api.beginConnect(); assert.equal(pending.ok, true); assert.equal(f.api.status().status, 'connecting');
  assert.equal((await f.api.beginConnect()).ok, false);
  assert.equal(f.api.stop().ok, true); await f.api.shutdown();
});
