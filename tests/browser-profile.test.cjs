const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { forgetTabs, QUIET_ARGS } = require('../src/browser-profile');

test('an interrupted session’s tabs are forgotten; the sign-in is left alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-profile-'));
  try {
    const d = path.join(root, 'Default');
    fs.mkdirSync(path.join(d, 'Sessions'), { recursive: true });
    for (const f of ['Session_13433423555248641', 'Tabs_13433423588643970', 'Session_1', 'Tabs_2']) fs.writeFileSync(path.join(d, 'Sessions', f), 'x');
    fs.writeFileSync(path.join(d, 'Current Session'), 'x');
    fs.writeFileSync(path.join(d, 'Last Tabs'), 'x');
    fs.writeFileSync(path.join(d, 'Cookies'), 'the sign-in');
    fs.mkdirSync(path.join(d, 'Network'));
    fs.writeFileSync(path.join(d, 'Network', 'Cookies'), 'the sign-in');
    fs.writeFileSync(path.join(d, 'Login Data'), 'saved logins');
    fs.writeFileSync(path.join(d, 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Person 1' }, other: 1 }));
    const r = forgetTabs(root);
    assert.equal(r.removed, 6);
    assert.deepEqual(fs.readdirSync(path.join(d, 'Sessions')), []);
    assert.ok(!fs.existsSync(path.join(d, 'Current Session')) && !fs.existsSync(path.join(d, 'Last Tabs')));
    assert.equal(fs.readFileSync(path.join(d, 'Cookies'), 'utf8'), 'the sign-in');
    assert.equal(fs.readFileSync(path.join(d, 'Network', 'Cookies'), 'utf8'), 'the sign-in');
    assert.equal(fs.readFileSync(path.join(d, 'Login Data'), 'utf8'), 'saved logins');
    const prefs = JSON.parse(fs.readFileSync(path.join(d, 'Preferences'), 'utf8'));
    assert.equal(prefs.profile.exit_type, 'Normal');
    assert.equal(prefs.profile.exited_cleanly, true);
    assert.equal(prefs.profile.name, 'Person 1', 'other preferences kept');
    assert.equal(prefs.other, 1);
    assert.deepEqual(forgetTabs(root), { removed: 0, cleanExit: false }, 'nothing to do the second time');
    assert.deepEqual(forgetTabs(path.join(root, 'missing')), { removed: 0, cleanExit: false }, 'a profile not made yet is fine');
    assert.ok(QUIET_ARGS.includes('--hide-crash-restore-bubble'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
