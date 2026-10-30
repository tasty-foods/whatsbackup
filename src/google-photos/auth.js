'use strict';
const ORIGIN = 'https://photos.google.com';
const TAKEOUT_HELP = 'Use Import Takeout folder for a supported full-library import. Export Google Photos at takeout.google.com, extract the ZIP files, then choose the extracted folder.';

// Run inside the page; return only readiness flags, never account details.
function readAuthSignals() {
  const text = String(document.body?.innerText || '').slice(0, 24000);
  return {
    blocked: /(?:this browser or app may not be secure|browser.*not secure|couldn[’']t sign you in|ce navigateur.*pas s[eé]curis[eé]|navigateur ou.*application.*pas s[eé]curis[eé]|browser.*niet veilig|dieser browser.*nicht sicher|לא ניתן להיכנס)/i.test(text),
    account: !!document.querySelector('a[href*="accounts.google.com/SignOutOptions"], a[href*="accounts.google.com/SignOut"], a[href^="https://myaccount.google.com/"], [aria-label*="Google Account"], [aria-label*="Google-account"], [aria-label*="Compte Google"], [aria-label*="Google-Konto"], [aria-label*="חשבון Google"]'),
    photos: [...document.querySelectorAll('a[href*="/photo/"]')].some(anchor => {
      try { const url = new URL(anchor.href); return url.origin === 'https://photos.google.com' && /^(?:\/u\/\d+)?\/photo\/[A-Za-z0-9_-]+\/?$/.test(url.pathname); } catch (_) { return false; }
    }),
  };
}

async function inspect(page) {
  if (page.isClosed()) return { ready: false, closed: true };
  let url;
  try { url = new URL(page.url()); } catch (_) { return { ready: false }; }
  let signals = {};
  try { signals = await page.evaluate(readAuthSignals); } catch (_) {}
  const blocked = (!!signals.blocked && (url.hostname === 'accounts.google.com' || !(signals.account || signals.photos)))
    || (url.hostname === 'accounts.google.com' && /\/(?:rejected|denied)\b/.test(url.pathname));
  return { ready: url.origin === ORIGIN && !!(signals.account || signals.photos), blocked, login: url.hostname === 'accounts.google.com', closed: false };
}

const blockedMessage = () => 'Google rejected sign-in in the app’s automated browser. WhatsBackUp cannot bypass Google’s browser security. ' + TAKEOUT_HELP;
module.exports = { inspect, readAuthSignals, TAKEOUT_HELP, blockedMessage };
