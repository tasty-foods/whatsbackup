'use strict';
const { readJson } = require('./auth');
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason || new Error('Import stopped.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
function createApi({ getAccessToken, refreshToken, fetchImpl = fetch, delay = wait }) {
  async function get(resource, query = {}, { signal, limit = 1024 * 1024, token } = {}) {
    const url = new URL(resource, API_BASE);
    if (url.origin !== 'https://gmail.googleapis.com' || !url.href.startsWith(API_BASE)) throw new Error('Invalid Gmail resource.');
    url.search = new URLSearchParams(query).toString();
    let retriedAuthorization = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      const access = token || await getAccessToken(signal);
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + access }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
      if (response.status === 401 && !token && !retriedAuthorization) {
        await response.body?.cancel(); retriedAuthorization = true; await refreshToken(signal); continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        const after = Number(response.headers?.get('retry-after')) || 2 ** attempt;
        await delay(Math.max(100, Math.min(30000, after * 1000)), signal); continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(response.status === 401 ? 'Gmail authorization is no longer valid. Connect Gmail again.' : response.status === 403 ? 'Gmail denied this request. Enable the Gmail API in your Google project and check the read-only permission or quota.' : response.status === 404 ? 'This Gmail message or attachment is no longer available.' : response.status === 400 ? 'Gmail could not continue this search. Check the query or restart the scan.' : 'Gmail is temporarily unavailable. Retry the import later.');
        error.status = response.status; error.reconnect = response.status === 401; throw error;
      }
      return readJson(response, limit);
    }
    throw new Error('Gmail is busy. Retry the import later.');
  }
  return {
    profile: options => get('profile', {}, options),
    list: ({ query, pageToken, maxResults, signal }) => get('messages', { q: query, maxResults, ...(pageToken ? { pageToken } : {}) }, { signal, limit: 1024 * 1024 }),
    message: (id, options) => get('messages/' + encodeURIComponent(id), { format: 'full' }, options),
    attachment: (messageId, attachmentId, options) => get('messages/' + encodeURIComponent(messageId) + '/attachments/' + encodeURIComponent(attachmentId), {}, options),
  };
}
module.exports = { API_BASE, createApi, wait };
