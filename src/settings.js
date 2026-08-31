'use strict';
// Persistent, user-editable settings. Written by the Settings panel and the
// first-run wizard, read by config.js at startup. Lives at <appHome>/data.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const FILE = path.join(paths.DATA_DIR, 'settings.json');

const DEFAULTS = {
  // Dashboard
  port: 8788,

  // Where things are kept. Empty mediaRoot means "<appHome>\media"; empty
  // cloudRoot means no cloud copy at all — a fresh PC has no pCloud drive.
  mediaRoot: '',
  cloudRoot: '',
  mirrorImages: false,

  // What to capture
  captureImages: true,
  captureVideos: true,
  captureVoice: false,
  captureAudio: false,
  captureDocuments: false,
  captureStickers: false,
  captureSent: true,
  captureReceived: true,
  captureGroups: true,
  excludedChats: [],
  captureConversations: true,

  // History import
  backfillLimit: 400,
  downloadTimeoutSec: 90,
  autoImportHours: 0,        // 0 = only when asked; otherwise run the import this often
  lastImportAt: 0,           // when the last import finished, kept across restarts

  // Desktop behaviour
  startWithWindows: false,
  startMinimized: false,
  closeToTray: true,
  notifyOnProblem: true,
  autoUpdate: true,

  // AI sorting. Off until the user turns it on and accepts the notice — this
  // is the only feature that sends anything off the PC.
  aiEnabled: false,
  aiConsent: false,
  aiProvider: 'anthropic',
  aiModel: 'claude-haiku-4-5',
  aiBaseUrl: '',
  aiKeyEnc: '',              // DPAPI ciphertext; the plaintext key is never stored
  aiMode: 'assist',          // manual | assist (manual, then auto for new items) | auto
  aiAnalyseImages: true,
  aiAnalyseChats: true,
  aiMonthlyBudget: 5,        // USD; 0 = no cap
  aiJsonSchema: true,        // set from the connection probe

  // Housekeeping
  logMaxMB: 5,
  retentionDays: 0,          // 0 = keep everything

  // Status Studio. Off until the notice is accepted, and dry-run until the
  // user deliberately goes live — the two most reversible defaults there are.
  statusEnabled: false,
  statusConsent: false,
  statusPaused: false,
  statusDryRun: true,
  statusMaxPerDay: 3,
  statusMinGapMin: 120,
  statusCatchupMin: 120,
  statusQuietFrom: '',
  statusQuietTo: '',
  statusFolder: '',
  statusFooter: '',
  statusAiPrompt: '',
  statusAiChatAware: false,

  // First run
  setupComplete: false,
  consentAccepted: false,
};

// The last successful read. A file that exists but momentarily can't be read
// or parsed (locked mid-write, transient I/O) must not be mistaken for a fresh
// install: that would show the first-run wizard on a configured machine, and
// the next write() would merge the user's patch over defaults — wiping the
// stored folders and the encrypted AI key.
let lastGood = null;

function read() {
  let s = {};
  let existed = false;
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    existed = true;
    lastGood = s;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // The file is there (or unknowable) but unreadable right now. Serve the
      // last good copy; failing that, defaults that can't hijack a configured
      // install into setup.
      if (lastGood) { s = lastGood; existed = true; }
      else return { ...DEFAULTS, setupComplete: true, consentAccepted: true };
    }
    // ENOENT falls through: a genuinely missing file is a genuine first run.
  }
  // Someone already running the pre-desktop version has a settings file but no
  // setupComplete flag — they've long since linked, so don't send them through
  // the first-run wizard.
  if (existed && s.setupComplete === undefined) s.setupComplete = true;
  if (existed && s.consentAccepted === undefined) s.consentAccepted = true;
  return { ...DEFAULTS, ...s };
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(paths.DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);   // atomic — a crash mid-write can't truncate settings
  return next;
}

module.exports = { read, write, FILE, DEFAULTS };
