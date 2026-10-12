'use strict';
// Corrections to whatsapp-web.js that have to be in place before the library
// loads: Client.js takes its own reference to these helpers at require time,
// so this module is required first, wherever the library is.

const pup = require('whatsapp-web.js/src/util/Puppeteer');

// Adding a page function (an "exposed function") registers it in every frame
// of the page. At startup WhatsApp Web opens a short-lived embedded frame; if
// it closes while the function is being registered, Puppeteer rejects the
// whole call with "Protocol error (Runtime.addBinding): Target closed". The
// library does not catch that inside its "synced" handler, so the client
// stops halfway through hooking into WhatsApp and never says ready — seen on
// 2026-10-12 as a link stuck at "authenticated", five starts in a row.
//
// The main frame is the only one that matters, and it usually got the
// function. So: a closed frame is not a failure if the main page has it; if
// it does not, the registration is cleared and made once more.
const TRANSIENT = /Target closed|Session closed|detached|No target with given id|Execution context was destroyed|Cannot find context|already exists/i;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasFunction(page, name) {
  try { return await page.evaluate((n) => typeof window[n] === 'function', name); }
  catch (_) { return false; }
}

async function exposeFunctionIfAbsent(page, name, fn, { log = console.warn, waitMs = 2000 } = {}) {
  if (await hasFunction(page, name)) return;
  try {
    await page.exposeFunction(name, fn);
    return;
  } catch (e) {
    const why = String((e && e.message) || e);
    if (!TRANSIENT.test(why)) throw e;
    for (let waited = 0; waited <= waitMs; waited += 200) {
      if (await hasFunction(page, name)) {
        log(`[link] ${name}: a page frame closed while it was being added (${why.slice(0, 80)}); the main page has it`);
        return;
      }
      await pause(200);
    }
    try { await page.removeExposedFunction(name); } catch (_) {}
    await page.exposeFunction(name, fn);
    log(`[link] ${name}: added again after a page frame closed (${why.slice(0, 80)})`);
  }
}

pup.exposeFunctionIfAbsent = exposeFunctionIfAbsent;

module.exports = { exposeFunctionIfAbsent, TRANSIENT };
