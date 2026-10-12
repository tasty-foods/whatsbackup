'use strict';
// Housekeeping for the sign-in browser profiles the ChatGPT and Gemini
// connectors keep (chatgpt-session, gemini-session).
//
// A browser cut off mid-session — the engine restarted during an import, the
// PC slept, the app was closed hard — leaves its open tabs recorded in the
// profile, and the next window opens all of them again. On 2026-10-12 the
// Gemini sign-in window came up with some thirty tabs from interrupted
// imports, and the one tab that mattered was the last. Before a window
// opens, the recorded tabs are forgotten and the last exit is marked clean,
// so there is no "Restore pages?" either.
//
// Only tab and window state is touched. The sign-in lives in the cookie and
// login stores, which are left exactly as they are.
const fs = require('fs');
const path = require('path');

const TAB_STATE = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];

function forgetTabs(profileDir) {
  const out = { removed: 0, cleanExit: false };
  if (!profileDir) return out;
  const dir = path.join(profileDir, 'Default');
  if (!fs.existsSync(dir)) return out;
  const sessions = path.join(dir, 'Sessions');
  try {
    for (const f of fs.readdirSync(sessions)) {
      if (/^(Session|Tabs|Apps)_\d+$/.test(f)) { fs.rmSync(path.join(sessions, f), { force: true }); out.removed++; }
    }
  } catch (_) {}
  for (const f of TAB_STATE) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); out.removed++; } } catch (_) {}
  }
  const prefs = path.join(dir, 'Preferences');
  try {
    const j = JSON.parse(fs.readFileSync(prefs, 'utf8'));
    j.profile = j.profile || {};
    if (j.profile.exit_type !== 'Normal' || j.profile.exited_cleanly !== true) {
      j.profile.exit_type = 'Normal';
      j.profile.exited_cleanly = true;
      fs.writeFileSync(prefs, JSON.stringify(j));
      out.cleanExit = true;
    }
  } catch (_) {}
  return out;
}

// Flags for a sign-in or import browser: no crash-restore bubble, nothing
// offered about launching it with Windows or making it the default browser.
const QUIET_ARGS = ['--hide-crash-restore-bubble', '--disable-session-crashed-bubble', '--no-first-run', '--no-default-browser-check'];

module.exports = { forgetTabs, QUIET_ARGS };
