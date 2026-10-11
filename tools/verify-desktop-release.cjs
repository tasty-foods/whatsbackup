'use strict';
// Run before publishing: an installer without matching latest.yml cannot be
// discovered or verified by installed copies of WhatsBackUp.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const zlib = require('node:zlib');

async function verify(directory = path.resolve(__dirname, '../dist')) {
  const version = require('../package.json').version;
  const metadata = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
  assert.equal(metadata.version, version, 'The update manifest must match the app version');
  const filename = `WhatsBackUp-Setup-${version}.exe`;
  const installer = path.join(directory, filename);
  const file = metadata.files.find(item => item.url === filename);
  assert.ok(file, 'latest.yml must point to the Windows installer');
  assert.equal(metadata.path, filename);
  assert.equal(fs.statSync(installer).size, file.size, 'Installer size differs from latest.yml');
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(installer)) hash.update(chunk);
  const sha512 = hash.digest('base64');
  assert.equal(file.sha512, sha512, 'Installer checksum differs from latest.yml');
  assert.equal(metadata.sha512, sha512);
  const blockmap = JSON.parse(zlib.gunzipSync(fs.readFileSync(installer + '.blockmap')));
  assert.ok(blockmap.files.length > 0, 'A differential-update blockmap must be included');
  const resources = path.join(directory, 'win-unpacked/resources');
  assert.equal(JSON.parse(fs.readFileSync(path.join(resources, 'app/package.json'))).version, version);
  const feed = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
  assert.equal(feed.provider, 'github');
  assert.equal(feed.owner, 'tasty-foods');
  assert.equal(feed.repo, 'whatsbackup');
  for (const relative of ['src/content/worker.js', 'public/content-search.js', 'public/third-party.html', 'node_modules/ffmpeg-static/ffmpeg.exe', 'node_modules/ffmpeg-static/ffmpeg.exe.LICENSE', 'node_modules/sharp/package.json', 'node_modules/pdfjs-dist/legacy/build/pdf.mjs']) {
    assert.ok(fs.existsSync(path.join(resources, 'app', relative)), `Missing content-search runtime: ${relative}`);
  }
  return { version, installer, bytes: file.size, sha512, feed: 'tasty-foods/whatsbackup', assets: [filename, filename + '.blockmap', 'latest.yml'] };
}

if (require.main === module) verify().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verify };
