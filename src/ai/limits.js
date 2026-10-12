'use strict';
// Living within free tiers: when to stop asking a provider, for how long, and
// how fast to ask in the first place.
//
// A free tier refuses with HTTP 429 in two very different situations: too many
// requests this minute (wait a minute) and today's allowance used up (wait for
// the reset — midnight Pacific at Gemini). Resting every refusal for 45 minutes
// made the runner sit out a one-minute limit for most of an hour, then hammer a
// spent daily quota again, and when every provider was resting it marked the
// whole queue as failed in seconds (3,288 items on 2026-10-12). The refusal
// says which kind it is — in its body, in a Retry-After header, in "Please
// retry in 41s" — so it is read, and the rest fits it.
//
// Rests are per model where the provider counts per model (Gemini, Groq), so
// the next model of the same provider carries on with its own allowance; per
// provider where the limit or the problem belongs to the account (a refused
// key, no credit, OpenRouter's daily free allowance, Anthropic's org limits).
// They are written to disk, so a restart does not spend a request finding out
// again that today's quota is gone.
const fs = require('fs');
const crypto = require('crypto');

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------- reading a refusal ---------------- */

// "1m26.4s", "41s", "2h3m", "500ms", "41.2" (seconds) -> ms
function parseDuration(s) {
  if (s == null) return 0;
  const str = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * SEC);
  let ms = 0, matched = false, m;
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)(?![a-z])/gi;
  while ((m = re.exec(str))) {
    matched = true;
    const v = parseFloat(m[1]), u = m[2].toLowerCase();
    ms += u === 'h' ? v * HOUR : u === 'm' ? v * MIN : u === 's' ? v * SEC : v;
  }
  return matched ? Math.round(ms) : 0;
}

function header(headers, name) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get(name) || '');
    const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
    return k ? String(headers[k]) : '';
  } catch (_) { return ''; }
}

// What a refusal says about itself. Works on the raw body text, so it does not
// matter whether the provider wrapped its error in an object, an array, or
// plain words.
function readRefusal(status, body, headers, now = Date.now()) {
  const text = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body || ''); } catch (_) { return String(body); } })();
  const out = { status, retryAfterMs: 0, scope: 'unknown', limitZero: false, billing: false, badKey: false, busy: false, accountWide: false, text: text.slice(0, 400) };

  const ra = header(headers, 'retry-after').trim();
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra)) out.retryAfterMs = Math.round(parseFloat(ra) * SEC);
    else { const t = Date.parse(ra); if (!Number.isNaN(t)) out.retryAfterMs = Math.max(0, t - now); }
  }
  const reset = header(headers, 'x-ratelimit-reset').trim();          // OpenRouter: epoch ms
  if (!out.retryAfterMs && /^\d{12,}$/.test(reset)) out.retryAfterMs = Math.max(0, Number(reset) - now);
  if (!out.retryAfterMs) {
    const m = /retry(?:Delay)?["\s:]*(?:in\s*)?"?(\d+(?:\.\d+)?\s*(?:ms|s|m|h)?)"?/i.exec(text)
      || /try again in\s*([\d.hms ]+)/i.exec(text);
    if (m) out.retryAfterMs = parseDuration(m[1]);
  }

  if (/per\s*day|PerDay|\bRPD\b|\bTPD\b|\bdaily\b|free-models-per-day|requests per day|tokens per day/i.test(text)) out.scope = 'day';
  else if (/per\s*minute|PerMinute|\bRPM\b|\bTPM\b|free-models-per-min|requests per minute|tokens per minute/i.test(text)) out.scope = 'minute';
  out.limitZero = /\blimit["':\s]+0(?![\d.])/i.test(text);
  out.billing = status === 402 || /credit balance|insufficient[_ ](credits|funds|balance|quota)|payment required|billing (is )?(not )?(active|enabled|required)/i.test(text);
  out.badKey = /api[_ ]?key[_ ]?(not valid|invalid)|invalid[_ ]api[_ ]?key|incorrect api key|API_KEY_INVALID|authentication[_ ]error/i.test(text);
  out.busy = status === 503 || status === 529 || /overloaded|UNAVAILABLE|high demand|temporarily unavailable/i.test(text);
  out.accountWide = /free-models-per-(day|min)/i.test(text);
  return out;
}

// Gemini's daily allowance resets at midnight Pacific time.
function msToPacificMidnight(now = Date.now()) {
  try {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now))) p[x.type] = x.value;
    const into = ((Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second)) * SEC;
    return 24 * HOUR - into;
  } catch (_) { return HOUR; }
}

/* ---------------- rests ---------------- */

function create({ file = null } = {}) {
  let path = file;
  const rests = new Map();          // "provider|model" or "provider|*" -> { until, why }
  const streaks = new Map();        // key -> consecutive unexplained 429s
  const lanes = new Map();          // pacing: key -> { next, interval, base }
  let version = 0;                  // bumped on every change, so a waiting runner can wake early
  // provider -> first 8 hex of sha256(key): enough to notice a different key,
  // nothing that could be turned back into one. Kept with the rests so a key
  // replaced while the app was closed still starts clean.
  let prints = {};

  const keyOf = (provider, model) => provider + '|' + (model || '*');

  function save() {
    if (!path) return;
    const now = Date.now(), out = {};
    for (const [k, v] of rests) if (v.until > now) out[k] = v;
    try { fs.writeFileSync(path, JSON.stringify({ rests: out, keys: prints })); } catch (_) {}
  }
  function load() {
    rests.clear();
    prints = {};
    if (!path) return;
    try {
      const j = JSON.parse(fs.readFileSync(path, 'utf8')) || {};
      const now = Date.now();
      for (const [k, v] of Object.entries(j.rests || {})) if (v && v.until > now) rests.set(k, { until: v.until, why: String(v.why || '') });
      if (j.keys && typeof j.keys === 'object') prints = { ...j.keys };
    } catch (_) {}
  }
  function configure(opts = {}) { if ('file' in opts) { path = opts.file || null; load(); } }

  function rest(provider, model, ms, why) {
    if (!provider) return;
    const k = keyOf(provider, model);
    const until = Date.now() + Math.max(0, ms);
    const had = rests.get(k);
    if (had && had.until >= until) return;                 // never shorten a rest that is already longer
    rests.set(k, { until, why: why || '' });
    version++;
    save();
    const span = ms >= HOUR ? (ms / HOUR).toFixed(ms >= 10 * HOUR ? 0 : 1) + ' h' : ms >= MIN ? Math.round(ms / MIN) + ' min' : Math.round(ms / SEC) + ' s';
    console.warn(`[ai] ${provider}${model ? ' / ' + model : ''} resting ${span} — ${why}`);
  }
  // The rest that applies to this model: its own, or the whole provider's.
  function restOf(provider, model) {
    const now = Date.now();
    const a = rests.get(keyOf(provider, null)), b = model ? rests.get(keyOf(provider, model)) : null;
    const live = [a, b].filter((x) => x && x.until > now).sort((x, y) => y.until - x.until)[0];
    return live ? { until: live.until, why: live.why } : { until: 0, why: '' };
  }
  const restingUntil = (provider, model) => restOf(provider, model).until;
  function clear(provider, model) {
    let changed = false;
    for (const k of [...rests.keys()]) {
      if (k === keyOf(provider, model) || (!model && k.startsWith(provider + '|'))) { rests.delete(k); changed = true; }
    }
    if (changed) { version++; save(); }
  }
  // Only the provider-wide rest (a refused key, no credit), keeping each
  // model's own quota rests.
  function clearWide(provider) {
    if (rests.delete(keyOf(provider, null))) { version++; save(); }
  }
  function allRests() {
    const now = Date.now(), out = [];
    for (const [k, v] of rests) if (v.until > now) { const i = k.indexOf('|'); out.push({ provider: k.slice(0, i), model: k.slice(i + 1) === '*' ? null : k.slice(i + 1), until: v.until, why: v.why }); }
    return out;
  }

  // Decide and apply the rest a failed request earned. Returns what was done,
  // or null when the failure is about the item rather than the provider.
  function restAfter(err, cfg, now = Date.now()) {
    if (!err || !cfg || !cfg.provider) return null;
    const kind = err.kind || '', status = Number(err.status) || 0;
    const r = err.refusal || {};
    const provider = cfg.provider;
    const model = cfg.restModel || cfg.model || null;
    let ms = 0, why = '', wide = false;

    if (kind === 'billing' || r.billing) { ms = 6 * HOUR; why = 'no credit left on this account'; wide = true; }
    else if (kind === 'auth' || status === 401 || r.badKey) {
      // A 403 can be about one model ("you do not have access to this model")
      // rather than the key; only that model rests then.
      if (status === 403 && /model/i.test(r.text || err.message || '')) { ms = 24 * HOUR; why = 'this key cannot use this model'; }
      else { ms = 6 * HOUR; why = 'the key was refused — paste a new one in AI settings'; wide = true; }
    }
    else if (status === 429 || kind === 'rate') {
      const k = keyOf(provider, model);
      if (r.limitZero) { ms = 12 * HOUR; why = 'this model has no free allowance on this key'; }
      else if (r.scope === 'day') {
        ms = provider === 'gemini' ? Math.max(r.retryAfterMs || 0, msToPacificMidnight(now) + MIN) : (r.retryAfterMs ? r.retryAfterMs + SEC : HOUR);
        why = "today's free allowance is used up";
      } else if (r.retryAfterMs) {
        ms = r.retryAfterMs + SEC;
        why = r.scope === 'minute' ? 'too many requests this minute' : 'asked to wait';
      } else if (r.scope === 'minute') { ms = 65 * SEC; why = 'too many requests this minute'; }
      else {
        const n = (streaks.get(k) || 0) + 1;
        streaks.set(k, n);
        ms = Math.min(HOUR, 2 * MIN * 2 ** (n - 1));
        why = 'rate-limited';
      }
      wide = !!r.accountWide || provider === 'anthropic';
    }
    else if (kind === 'busy' || r.busy) { ms = 2 * MIN; why = 'busy right now'; }
    // Slow is the model's state today more often than the item's fault: rest it
    // briefly and let the next model try (the runner caps how often one item
    // may do this, so an item that is slow everywhere still ends).
    else if (kind === 'timeout') { ms = 5 * MIN; why = 'too slow to answer'; }
    else if (kind === 'model' || status === 404) { ms = 24 * HOUR; why = 'this model is not available'; }
    else if (kind === 'length') { ms = 6 * HOUR; why = 'its answers were cut off'; }
    else if (kind === 'down') { ms = 3 * MIN; why = 'not answering'; wide = true; }
    else return null;

    ms = clamp(Math.round(ms), 5 * SEC, 26 * HOUR);
    rest(provider, wide ? null : model, ms, why);
    return { ms, why, wide, until: Date.now() + ms };
  }

  // A success clears the record of unexplained refusals for that model.
  function noteSuccess(provider, model) { streaks.delete(keyOf(provider, model)); }

  /* ---------------- pacing ---------------- */
  // A steady trickle rather than bursts: each provider/model has a minimum gap
  // between requests, which widens when told "too many this minute" and slowly
  // narrows back after successes. Requests queue for their slot in order.
  async function pace(key, baseMs) {
    if (!baseMs || baseMs <= 0) return;
    const lane = lanes.get(key) || { next: 0, interval: baseMs, base: baseMs };
    lane.base = baseMs;
    if (lane.interval < baseMs) lane.interval = baseMs;
    const now = Date.now();
    const at = Math.max(now, lane.next);
    lane.next = at + lane.interval;
    lanes.set(key, lane);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  function slower(key) { const l = lanes.get(key); if (l) l.interval = Math.min(30 * SEC, Math.round(l.interval * 1.6)); }
  function faster(key) { const l = lanes.get(key); if (l) l.interval = Math.max(l.base, Math.round(l.interval * 0.95)); }
  const intervalOf = (key) => { const l = lanes.get(key); return l ? l.interval : 0; };

  // Told which key a provider now has. A different key from the one the rests
  // were earned with starts clean; the same key keeps them, restart or not.
  function noteKey(provider, key) {
    if (!provider) return false;
    const fp = key ? crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8) : '';
    const had = prints[provider];
    if (had === fp) return false;
    prints[provider] = fp;
    if (had !== undefined) { clear(provider); save(); return true; }
    save();
    return false;
  }

  function reset() { rests.clear(); streaks.clear(); lanes.clear(); prints = {}; version++; }
  const changes = () => version;

  load();
  return { configure, rest, restOf, restingUntil, clear, clearWide, allRests, restAfter, noteSuccess, noteKey, pace, slower, faster, intervalOf, reset, changes };
}

// One shared instance: the runner, the provider client and the probe must agree
// on who is resting and how fast to go.
const shared = create();
module.exports = Object.assign(shared, { create, readRefusal, parseDuration, msToPacificMidnight, SEC, MIN, HOUR });
