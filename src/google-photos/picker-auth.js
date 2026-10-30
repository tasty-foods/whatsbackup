'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

async function readJson(response, limit = 1024 * 1024) {
  const declared = Number(response.headers?.get('content-length'));
  if (declared > limit) { await response.body?.cancel().catch(() => {}); throw new Error('Google returned more data than the import limit allows.'); }
  let size = 0; const chunks = [];
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Google returned more data than the import limit allows.');
      chunks.push(Buffer.from(chunk));
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new Error('Google returned an unreadable response. Retry the connection.'); }
}

async function tokenRequest(fields, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const revoked = data.error === 'invalid_grant';
    const error = new Error(revoked ? 'Google authorization expired or was revoked. Connect Google Photos again.' : data.error === 'invalid_client' ? 'Google rejected this OAuth client. Check the Desktop app client ID and optional client secret.' : 'Google could not complete authorization. Check the OAuth setup and retry.');
    error.reconnect = revoked; throw error;
  }
  if (!data.access_token || typeof data.access_token !== 'string' || data.access_token.length > 16384 || (data.token_type && data.token_type.toLowerCase() !== 'bearer')) throw new Error('Google returned no usable access token. Connect Google Photos again.');
  if (data.scope && !String(data.scope).split(/\s+/).includes(SCOPE)) throw new Error('Google Photos Picker access was not granted. Connect again and allow selected-photo access.');
  return {
    accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresAt: Date.now() + Math.max(60, Math.min(86400, Number(data.expires_in) || 3600)) * 1000,
    scope: data.scope || SCOPE,
  };
}

async function startLoopback({ clientId, clientSecret = '', fetchImpl = fetch, onTokens, timeoutMs = 5 * 60000 }) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId.trim())) throw new Error('Add a Google OAuth Desktop app client ID in Google connection setup first.');
  clientId = clientId.trim();
  const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let pending = true, exchanging = false, timer, resolveResult, rejectResult, redirectUri;
  const controller = new AbortController();
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // The caller observes the result, but an early connection failure must not
  // become an unhandled rejection before it has attached that observer.
  result.catch(() => {});
  const finish = (error, value) => {
    if (!pending) return;
    pending = false; clearTimeout(timer); controller.abort(); server.close(); server.closeIdleConnections?.();
    error ? rejectResult(error) : resolveResult(value);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    let url;
    try { url = new URL(req.url, redirectUri); } catch (_) {}
    if (!redirectUri || req.method !== 'GET' || req.headers.host !== new URL(redirectUri).host || url?.pathname !== '/oauth2callback') { res.writeHead(404); res.end('Not found.'); return; }
    const supplied = Buffer.from(url.searchParams.get('state') || ''), expected = Buffer.from(state);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { res.writeHead(400); res.end('This sign-in response could not be verified. Return to WhatsBackUp and retry.'); return; }
    if (!pending || exchanging) { res.writeHead(409); res.end('This sign-in response has already been handled.'); return; }
    exchanging = true;
    try {
      if (url.searchParams.has('error')) throw new Error('Google Photos connection was cancelled or denied. Your account was not changed.');
      const code = url.searchParams.get('code');
      if (!code || code.length > 8192) throw new Error('Google returned no authorization code. Connect Google Photos again.');
      const fields = { client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri };
      if (clientSecret) fields.client_secret = clientSecret;
      const tokens = await tokenRequest(fields, { fetchImpl, signal: controller.signal });
      controller.signal.throwIfAborted();
      const value = await onTokens({ ...tokens, clientId }, controller.signal);
      res.end('<!doctype html><title>Google Photos connected</title><h1>Google Photos is connected.</h1><p>Close this tab and return to WhatsBackUp. Only photos and videos you select can be imported.</p>');
      finish(null, value);
    } catch (error) {
      res.writeHead(400); res.end('<!doctype html><title>Google Photos connection</title><h1>Google Photos could not connect.</h1><p>Close this tab and check the connection message in WhatsBackUp.</p>'); finish(error);
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.maxConnections = 8;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.on('error', error => finish(error));
  redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' }).toString();
  const expiresAt = Date.now() + timeoutMs;
  timer = setTimeout(() => finish(new Error('Google Photos sign-in timed out. Connect again when you are ready.')), timeoutMs); timer.unref?.();
  return { authUrl: authUrl.href, result, expiresAt, cancel: () => finish(new Error('Google Photos sign-in was stopped.')) };
}
module.exports = { SCOPE, TOKEN_URL, AUTH_URL, readJson, tokenRequest, startLoopback };
