'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createVault } = require('../electron/gmail-vault');

function secureFixture() {
  const key = crypto.randomBytes(32), writes = [];
  let value = { gmailClientId: 'fixture.apps.googleusercontent.com', gmailClientSecretEnc: 'secret-cipher-already-saved' }, available = true;
  const settings = { read: () => ({ ...value }), write: patch => { writes.push(patch); value = { ...value, ...patch }; return value; } };
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: text => { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), data]); },
    decryptString: bytes => { const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
  return { settings, safeStorage, writes, setAvailable: enabled => { available = enabled; } };
}
const tokens = { clientId: 'fixture.apps.googleusercontent.com', account: 'owner@example.test', accessToken: 'private-access-token-fixture', refreshToken: 'private-refresh-token-fixture', scope: 'https://www.googleapis.com/auth/gmail.readonly', expiresAt: 2000000000000 };

test('Gmail vault writes only encrypted credentials and decrypts them through the native secure-storage interface', async () => {
  const f = secureFixture(), vault = createVault(f);
  assert.deepEqual(await vault('load'), { ok: true, tokens: null });
  assert.deepEqual(await vault('save', tokens), { ok: true });
  assert.deepEqual(Object.keys(f.writes[0]), ['gmailTokensEnc']);
  const stored = f.settings.read().gmailTokensEnc;
  assert.ok(Buffer.from(stored, 'base64').length > 28);
  assert.ok(!JSON.stringify(f.settings.read()).includes(tokens.accessToken));
  assert.ok(!JSON.stringify(f.settings.read()).includes(tokens.refreshToken));
  assert.deepEqual(await vault('load'), { ok: true, tokens });
  assert.deepEqual(await vault('clear'), { ok: true });
  assert.equal(f.settings.read().gmailTokensEnc, '');
  assert.equal(f.settings.read().gmailClientSecretEnc, 'secret-cipher-already-saved');
  assert.equal(f.settings.read().gmailClientId, tokens.clientId);
});

test('Gmail vault rejects unknown or malformed actions and unavailable encryption without storing plaintext', async () => {
  const f = secureFixture(), vault = createVault(f);
  for (const [action, value] of [['read-all', tokens], ['save', null], ['save', []], ['save', 'token']]) assert.equal((await vault(action, value)).ok, false);
  assert.equal(f.writes.length, 0);
  f.setAvailable(false);
  assert.match((await vault('save', tokens)).error, /secure storage is unavailable/);
  assert.equal(f.writes.length, 0);
  f.setAvailable(true);
  assert.equal((await vault('save', { accessToken: 'x'.repeat(70000) })).ok, false);
  assert.equal(f.writes.length, 0);
});

test('Gmail and Google Photos credential vaults save, load and clear independently and reject unknown fields', async () => {
  const f = secureFixture(), gmail = createVault(f), photos = createVault({ ...f, field: 'googlePhotosTokensEnc' });
  const photoTokens = { accessToken: 'private-photo-picker-token-fixture', refreshToken: 'private-photo-picker-refresh-fixture', scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly', expiresAt: 2000000000000 };
  assert.deepEqual(await photos('load'), { ok: true, tokens: null });
  await gmail('save', tokens); await photos('save', photoTokens);
  const before = f.settings.read();
  assert.notEqual(before.gmailTokensEnc, before.googlePhotosTokensEnc);
  assert.ok(!JSON.stringify(before).includes(photoTokens.accessToken));
  assert.deepEqual(await gmail('load'), { ok: true, tokens }); assert.deepEqual(await photos('load'), { ok: true, tokens: photoTokens });
  await photos('clear');
  assert.equal(f.settings.read().googlePhotosTokensEnc, ''); assert.equal(f.settings.read().gmailTokensEnc, before.gmailTokensEnc);
  assert.deepEqual(await gmail('load'), { ok: true, tokens });
  await photos('save', photoTokens); const photoCipher = f.settings.read().googlePhotosTokensEnc;
  await gmail('clear');
  assert.equal(f.settings.read().gmailTokensEnc, ''); assert.equal(f.settings.read().googlePhotosTokensEnc, photoCipher);
  assert.deepEqual(await photos('load'), { ok: true, tokens: photoTokens });
  const writes = f.writes.length;
  for (const field of ['arbitrarySetting', '__proto__', 'gmailClientSecretEnc', '', null]) assert.throws(() => createVault({ ...f, field }), /Unsupported credential store/);
  assert.equal(f.writes.length, writes);
});

test('Gmail vault handles an unreadable Windows ciphertext and does not overwrite it on crypto or disk failure', async () => {
  const f = secureFixture(), vault = createVault(f); await vault('save', tokens);
  const stored = f.settings.read().gmailTokensEnc;
  f.safeStorage.decryptString = () => { throw Error('Different Windows profile'); };
  assert.match((await vault('load')).error, /Windows account/);
  assert.equal(f.settings.read().gmailTokensEnc, stored);
  f.safeStorage.encryptString = () => { throw Error('Native encryption failed'); };
  await assert.rejects(vault('save', tokens), /encryption failed/);
  assert.equal(f.settings.read().gmailTokensEnc, stored);
  const disk = secureFixture(); disk.settings.write = () => { throw Error('Disk is read-only'); };
  await assert.rejects(createVault(disk)('save', tokens), /Disk is read-only/);
  assert.equal(disk.settings.read().gmailTokensEnc, undefined);
});

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-gmail-vault-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('whatsbackup-gmail-vault-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function loadSource(file, overrides = {}) {
  const context = { module: { exports: {} }, console, process, Buffer, URL, require: name => name in overrides ? overrides[name] : name.startsWith('./') ? {} : require(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8'), context);
  return context.module.exports;
}

test('HTTP settings and diagnostics redact Gmail and Photos ciphertext, reject credential injection and preserve the encrypted connections', async t => {
  const root = temporary(t), settings = loadSource('settings.js', { './paths': { DATA_DIR: root } });
  settings.write({ gmailTokensEnc: 'encrypted-token-sentinel', googlePhotosTokensEnc: 'encrypted-photo-token-sentinel', gmailClientSecretEnc: 'encrypted-secret-sentinel', gmailClientId: tokens.clientId, captureImages: false });
  const cfg = { PUBLIC_DIR: path.resolve(__dirname, '../public'), DATA_DIR: root, IMAGES_DIR: root, VIDEO_DIR: root, FILES_DIR: root, CLOUD_ROOT: '', APP_HOME: root };
  const createApp = loadSource('web.js', { './config': cfg, './settings': settings, './paths': { DATA_DIR: root }, './store': { hiddenIds: () => new Set(), listRecords: () => [] }, './cleanup': { QUARANTINE_DIR: root }, './logger': { FILE: path.join(root, 'absent.log') }, './whatsapp': { getState: () => ({ status: 'off', health: {} }) }, './media-export': require('../src/media-export') });
  const server = await new Promise(resolve => { const value = createApp().listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const endpoint of ['/api/settings', '/api/diagnostics']) {
    const response = await fetch(base + endpoint); assert.equal(response.status, 200); const value = await response.json();
    assert.equal(value.settings.gmailTokensEnc, undefined); assert.equal(value.settings.gmailClientSecretEnc, undefined); assert.equal(value.settings.gmailSecretStored, true);
    assert.equal(value.settings.googlePhotosTokensEnc, undefined);
    assert.ok(!JSON.stringify(value).includes('encrypted-token-sentinel')); assert.ok(!JSON.stringify(value).includes('encrypted-secret-sentinel'));
    assert.ok(!JSON.stringify(value).includes('encrypted-photo-token-sentinel'));
  }
  const changed = await (await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', Origin: base }, body: JSON.stringify({ gmailTokensEnc: 'injected', googlePhotosTokensEnc: 'injected-photo-token', gmailClientSecretEnc: 'injected', gmailClientSecret: 'plaintext', gmailClientId: 'other-client' }) })).json();
  assert.deepEqual(changed.rejected.sort(), ['gmailClientId', 'gmailClientSecret', 'gmailClientSecretEnc', 'gmailTokensEnc', 'googlePhotosTokensEnc'].sort());
  assert.equal(settings.read().gmailTokensEnc, 'encrypted-token-sentinel'); assert.equal(settings.read().gmailClientSecretEnc, 'encrypted-secret-sentinel'); assert.equal(settings.read().captureImages, false);
  assert.equal(settings.read().googlePhotosTokensEnc, 'encrypted-photo-token-sentinel');
});

test('desktop Gmail configuration encrypts an optional secret and rejects invalid setup or unavailable native storage', async t => {
  const root = temporary(t), f = secureFixture(), handlers = new Map();
  const electron = { app: { isPackaged: true, getVersion: () => '2.2.0', setPath() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, exit() {} }, ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, safeStorage: f.safeStorage, Notification: { isSupported: () => false } };
  const directory = path.resolve(__dirname, '../electron');
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'main.js'), 'utf8') + '\nregisterIpc();', {
    module: { exports: {} }, __dirname: directory, console, process: { env: { LOCALAPPDATA: root }, resourcesPath: root, argv: [] }, setTimeout, clearTimeout, setInterval, setImmediate, Buffer, URL,
    require: name => name === 'electron' ? electron : name === './updates' ? require('../electron/updates') : name === './migrate' ? { findOldInstall: () => null } : name.endsWith('src' + path.sep + 'settings.js') ? f.settings : require(name),
  });
  const configure = options => handlers.get('wb:gmailConfigure')({}, options);
  assert.equal((await configure({ clientId: 'not-a-google-client' })).ok, false);
  const result = await configure({ clientId: tokens.clientId, clientSecret: 'optional-desktop-secret-fixture' }); assert.equal(result.ok, true);
  const encrypted = f.settings.read().gmailClientSecretEnc; assert.notEqual(encrypted, 'optional-desktop-secret-fixture');
  assert.equal(f.safeStorage.decryptString(Buffer.from(encrypted, 'base64')), 'optional-desktop-secret-fixture');
  f.setAvailable(false);
  assert.equal((await configure({ clientId: tokens.clientId, clientSecret: 'must-not-be-written' })).ok, false);
  assert.equal(f.settings.read().gmailClientSecretEnc, encrypted);
});
