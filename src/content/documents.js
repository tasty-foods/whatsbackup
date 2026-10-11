'use strict';
let state = { running: false, done: 0, total: 0, failed: 0, message: '', issues: [] };
function run() {
  if (state.running) return { ok: true, alreadyRunning: true };
  const ai = require('../ai'), labels = require('../ai/store'), settings = require('../settings').read();
  if (ai.status().running) return { ok: false, message: 'AI indexing already includes document text. Pause it before starting a separate document scan.' };
  const records = require('../store').listRecords({ kind: 'document' }).filter(rec => !require('../ai/label').currentLabel(labels.getLabel('document', rec.id), settings));
  state = { running: true, done: 0, total: records.length, failed: 0, message: '', issues: [] };
  (async () => {
    try {
      for (const record of records) {
        try { await require('../ai/label').labelDocument(null, record, { localOnly: true }); state.done++; }
        catch (e) { state.failed++; state.issues.push({ name: record.docName || record.filename, state: 'error', error: e.message }); }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } finally { state.running = false; state.message = `${state.done} documents read locally${state.failed ? ` · ${state.failed} could not be read (Show skipped & failed)` : ''}. Scanned pages need AI transcription.`; }
  })();
  return { ok: true, started: true };
}
module.exports = { run, status: () => ({ ...state, issues: state.issues.slice(-25) }) };
