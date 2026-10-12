'use strict';

const ORIGIN = 'https://photos.google.com';

function photoLink(href) {
  try {
    const url = new URL(href, ORIGIN);
    if (url.origin !== ORIGIN) return null;
    const match = url.pathname.match(/^(?:\/u\/\d+)?\/photo\/([A-Za-z0-9_-]+)\/?$/);
    return match ? { mediaId: match[1], url: url.origin + url.pathname } : null;
  } catch (_) { return null; }
}

// Executed in the page. Read every viewport before moving it: Photos recycles
// its grid nodes, so collecting only the final DOM loses earlier pictures.
function readViewport() {
  const items = [];
  for (const anchor of document.querySelectorAll('a[href*="/photo/"]')) {
    const image = anchor.querySelector('img');
    const time = anchor.querySelector('time[datetime]');
    items.push({
      href: anchor.href,
      label: anchor.getAttribute('aria-label') || image?.alt || '',
      datetime: time?.getAttribute('datetime') || '',
    });
  }
  const candidates = [document.scrollingElement, ...document.querySelectorAll('main, [role="main"], [role="main"] *')]
    .filter(el => el && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2
      && (el === document.scrollingElement || /auto|scroll/.test(getComputedStyle(el).overflowY)));
  const scroller = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
    || document.scrollingElement || document.body;
  return {
    items,
    top: scroller.scrollTop,
    height: scroller.scrollHeight,
    viewport: scroller.clientHeight,
    empty: /(?:no photos|your photos will appear here|back up your first photo)/i.test(document.body.innerText),
  };
}

function advanceViewport() {
  const candidates = [document.scrollingElement, ...document.querySelectorAll('main, [role="main"], [role="main"] *')]
    .filter(el => el && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2
      && (el === document.scrollingElement || /auto|scroll/.test(getComputedStyle(el).overflowY)));
  const scroller = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
    || document.scrollingElement || document.body;
  scroller.scrollTop += Math.max(1, Math.floor(scroller.clientHeight * 0.7));
}

async function walkLibrary(page, visit, { signal, maxScrolls = 10000, settleRounds = 5, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const seen = new Set();
  let settled = 0, previous = '', empty = false;
  for (let round = 0; round < maxScrolls; round++) {
    signal?.throwIfAborted();
    const view = await page.evaluate(readViewport);
    empty = view.empty;
    let added = 0;
    for (const candidate of view.items) {
      const link = photoLink(candidate.href);
      if (!link || seen.has(link.mediaId)) continue;
      seen.add(link.mediaId); added++;
      signal?.throwIfAborted();
      await visit({ ...candidate, ...link });
    }
    const position = `${view.top}:${view.height}:${seen.size}`;
    const atBottom = view.top + view.viewport >= view.height - 4;
    settled = !added && atBottom && position === previous ? settled + 1 : 0;
    if (settled >= settleRounds) {
      if (!seen.size && !empty) throw new Error('Google Photos loaded, but its photo links could not be read. The page may have changed; try signing in again.');
      return { complete: true, found: seen.size };
    }
    previous = position;
    await page.evaluate(advanceViewport);
    await wait(1000);
  }
  return { complete: false, found: seen.size };
}

function photoTime(item, fallback) {
  const text = String(item.datetime || item.label || '').replace(/^(?:photo|video)\s*[-–:]\s*/i, '').trim();
  // Do not interpret generic labels or filenames such as IMG_2024 as dates.
  const ts = /\b(?:19|20)\d{2}\b/.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(ts) && ts > 0 ? { ts, dateSource: 'googlephotos' } : { ts: fallback, dateSource: 'import' };
}

module.exports = { ORIGIN, photoLink, readViewport, advanceViewport, walkLibrary, photoTime };
