'use strict';
window.FileActions = (() => {
  const notify = text => window.Workspace?.toast(text);
  const locations = id => requestJson('/api/media/' + encodeURIComponent(id) + '/where');
  const preferred = where => where.local || where.cloud;
  const label = { folder: 'Open folder', paths: 'Copy path', links: 'Copy file link', files: 'Copy for attachment' };
  const description = {
    folder: 'Open Explorer with this file selected',
    paths: 'Copy the full storage path',
    links: 'Copy a file:/// link. It works only on computers that can access the same path; it is not a public share link.',
    files: 'Copy original files, then press Ctrl+V in a chat, email or folder that accepts file attachments.',
  };
  async function resolveSelection(records) {
    if (!records.length) throw new Error('Select a file first.');
    if (records.length > 1000) throw new Error('Select 1,000 files or fewer for clipboard actions.');
    const result = [];
    // Bound filesystem work when a large selection lives on a mounted drive.
    for (let i = 0; i < records.length; i += 8) result.push(...await Promise.all(records.slice(i, i + 8).map(async record => {
      const where = await locations(record.id);
      if (!preferred(where)) throw new Error('A selected file is unavailable. Reconnect its drive and try again.');
      return where;
    })));
    return result;
  }
  async function perform(action, targets) {
    const paths = [...new Set(targets.map(preferred))];
    if (action === 'folder') {
      if (paths.length !== 1) throw new Error('Select one file to open its folder.');
      if (!bridge?.showInFolder) throw new Error('Open folder is available in the desktop app. Use Copy path in this browser.');
      if (!await bridge.showInFolder(paths[0])) throw new Error('Could not open this file’s folder. Check that its drive is connected.');
      return 'Folder opened with the file selected.';
    }
    const method = { paths: 'copyPaths', links: 'copyFileLinks', files: 'copyFiles' }[action];
    if (bridge?.[method]) {
      const result = await bridge[method](paths);
      if (!result?.ok) throw new Error(result?.error || 'Could not copy. Try again.');
    } else {
      if (action === 'files') throw new Error('Copy for attachment is available in the updated desktop app.');
      const text = action === 'links' ? targets.map(w => w.local ? w.localLink : w.cloudLink).join('\r\n') : paths.join('\r\n');
      if (!text) throw new Error('This file has no available path to copy.');
      await navigator.clipboard.writeText(text);
    }
    if (action === 'files') return `${paths.length === 1 ? 'File' : paths.length + ' files'} copied. Press Ctrl+V where you want to attach ${paths.length === 1 ? 'it' : 'them'}.`;
    if (action === 'links') return 'File link copied. It requires access to the same storage path; it is not a public link.';
    return paths.length === 1 ? 'Full file path copied.' : paths.length + ' file paths copied.';
  }
  async function run(action, records, button) {
    if (button?.dataset.fileBusy === '1') return;
    const original = button?.textContent;
    if (button) { button.dataset.fileBusy = '1'; button.disabled = true; button.textContent = 'Working…'; }
    try { notify(await perform(action, await resolveSelection(records))); }
    catch (error) { notify(error.message); }
    finally { if (button?.isConnected) { delete button.dataset.fileBusy; button.textContent = original; button.disabled = false; if (button.dataset.fileAction) window.Workspace?.refreshFileActions(); } }
  }
  async function viewer(record) {
    const host = document.getElementById('lb-file-actions');
    if (!host) return;
    host.textContent = 'Checking file locations…';
    try {
      const where = await locations(record.id);
      if (!host.isConnected || lbId !== record.id) return;
      host.replaceChildren();
      const heading = document.createElement('b'); heading.textContent = 'File & location'; host.append(heading);
      const status = document.createElement('p'); status.className = 'file-location-status';
      status.textContent = where.local && where.cloud ? 'Saved on this PC and in the pCloud drive folder.'
        : where.local ? 'Saved on this PC.' : where.cloud ? 'Stored on the pCloud drive. No separate PC copy was found.'
          : 'File unavailable. Check that its storage drive is connected.';
      host.append(status);
      if(record.source==='gmail'){
        const origin=document.createElement('p');origin.textContent=`Gmail · ${record.sender||record.gmailAccount||''}${record.subject?' · '+record.subject:''}`;host.append(origin);
      }
      if (preferred(where)) {
        const buttons = document.createElement('div'); buttons.className = 'file-action-buttons';
        for (const action of ['folder', 'paths', 'files', 'links']) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'btn small';
          button.textContent = label[action]; button.title = description[action];
          if (action === 'folder') button.classList.add('primary');
          button.addEventListener('click', () => run(action, [record], button)); buttons.append(button);
        }
        host.append(buttons);
        const hint = document.createElement('p'); hint.className = 'file-location-note'; hint.textContent = 'File links work only where the same storage path is accessible.'; host.append(hint);
      }
      for (const [key, name] of [['local', 'On this PC'], ['cloud', 'pCloud drive']]) {
        if (!where[key]) continue;
        const row = document.createElement('div'); row.className = 'file-location-row';
        const title = document.createElement('label'); title.textContent = name;
        const input = document.createElement('input'); input.className = 'txt'; input.readOnly = true; input.value = where[key]; input.setAttribute('aria-label', name + ' file path');
        input.title = where[key]; input.addEventListener('click', () => input.select()); title.append(input); row.append(title);
        if (where.local && where.cloud) {
          const open = document.createElement('button'); open.type = 'button'; open.className = 'btn small'; open.textContent = key === 'local' ? 'Open PC folder' : 'Open pCloud folder';
          open.onclick = async () => { try { notify(await perform('folder', [{ local: where[key] }])); } catch (e) { notify(e.message); } }; row.append(open);
        }
        host.append(row);
      }
      if (!where.cloud && where.cloudExpected && where.local) {
        const note = document.createElement('p'); note.className = 'file-location-note'; note.textContent = 'No pCloud drive copy found yet. Check Storage & copies.'; host.append(note);
      }
    } catch (_) { if (host.isConnected) host.textContent = 'Could not check file locations. Reconnect the storage drive and reopen this preview.'; }
  }
  return { run, viewer };
})();
