'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Windows PowerShell 5.1's -LiteralPath writes a native FileDropList (CF_HDROP),
// so pasting attaches the original files instead of pasting their path as text.
// Paths arrive as base64 JSON on stdin; they are never interpolated into code.
// https://learn.microsoft.com/powershell/module/microsoft.powershell.management/set-clipboard?view=powershell-5.1
const FILE_CLIPBOARD_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  $files = [string[]]@($json | ConvertFrom-Json)
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      Set-Clipboard -LiteralPath $files -ErrorAction Stop
      $copied = @(Get-Clipboard -Format FileDropList -Raw -ErrorAction Stop)
      if ($copied.Count -ne $files.Count) { throw 'The file clipboard could not be verified.' }
      [Console]::Out.Write('ok')
      exit 0
    } catch {
      if ($attempt -eq 2) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
} catch {
  [Console]::Error.Write('The Windows file clipboard is unavailable.')
  exit 1
}`;

function writeFileDropList(files, { execFile = require('node:child_process').execFile, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  return new Promise((resolve, reject) => {
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-Command', FILE_CLIPBOARD_SCRIPT];
    try {
      const child = execFile(executable, args, { timeout: 15000, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, output) => {
        if (error || String(output).trim() !== 'ok') reject(new Error('Windows could not copy the files. Make cloud files available offline, close any busy clipboard app, and try again.'));
        else resolve();
      });
      // A process that cannot start may close its stdin before the payload lands.
      child.stdin.on('error', () => {});
      child.stdin.end(Buffer.from(JSON.stringify(files), 'utf8').toString('base64'));
    } catch (_) { reject(new Error('The Windows file clipboard could not start. Try copying the path instead.')); }
  });
}

function createFileActions({ getRoots, writeText, writeFiles = writeFileDropList, platform = process.platform }) {
  const canonical = value => platform === 'win32' ? value.toLowerCase() : value;
  async function validate(targets) {
    const input = typeof targets === 'string' ? [targets] : targets;
    if (!Array.isArray(input) || !input.length || input.length > 1000) throw new Error('Select between 1 and 1,000 files to copy.');
    if (input.some(value => typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value))) throw new Error('A selected file has an invalid path.');
    const roots = (await Promise.all(getRoots().filter(Boolean).map(root => fs.realpath(root).catch(() => null)))).filter(Boolean);
    const seen = new Set(), files = [];
    for (const target of input) {
      let real, stat;
      try { real = await fs.realpath(target); stat = await fs.stat(real); }
      catch (_) { throw new Error('A selected file is missing or its drive is disconnected.'); }
      if (!stat.isFile()) throw new Error('Select files, not folders.');
      if (!roots.some(root => { const relative = path.relative(canonical(root), canonical(real)); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); })) throw new Error('Only files in your archive or configured cloud folder can be copied.');
      const key = canonical(real);
      if (!seen.has(key)) { files.push(real); seen.add(key); }
    }
    return files;
  }
  async function perform(targets, action) {
    try { const files = await validate(targets); await action(files); return { ok: true, count: files.length }; }
    catch (error) { return { ok: false, count: 0, error: error.message || 'Could not copy the selected files.' }; }
  }
  return {
    copyPaths: targets => perform(targets, files => writeText(files.join('\r\n'))),
    copyFileLinks: targets => perform(targets, files => writeText(files.map(file => pathToFileURL(file).href).join('\r\n'))),
    copyFiles: targets => perform(targets, files => {
      if (platform !== 'win32') throw new Error('Copying file attachments is available in the Windows desktop app.');
      return writeFiles(files);
    }),
  };
}
module.exports = { createFileActions, writeFileDropList, FILE_CLIPBOARD_SCRIPT };
