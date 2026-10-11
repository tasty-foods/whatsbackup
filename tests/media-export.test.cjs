const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { planSelection, register } = require('../src/media-export');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-export-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('whatsbackup-export-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const records = new Map(), hidden = new Set();
  function add(id, docName = 'invoice.pdf') {
    const record = { id, docName, filename: id + '.pdf' };
    records.set(id, record); fs.writeFileSync(path.join(root, record.filename), 'contents of ' + id);
    return record;
  }
  return { root, add, records, hidden, getRecord:id => records.get(id), hiddenIds:() => hidden, pathsFor:r => [path.join(root, r.filename)] };
}

function zipNames(bytes) {
  const names = [];
  for (let offset = 0; offset < bytes.length - 46; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const length = bytes.readUInt16LE(offset + 28);
    names.push(bytes.subarray(offset + 46, offset + 46 + length).toString('utf8'));
    offset += 45 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return names;
}

test('selected exports deduplicate IDs and preserve colliding file names safely', async t => {
  const f = fixture(t);
  f.add('one', '../invoice.pdf'); f.add('two', 'C:\\files\\INVOICE.pdf');
  f.add('three', 'invoice (2).pdf'); f.add('four', '...'); f.add('five', 'CON.pdf');
  const entries = await planSelection(['one', 'one', 'two', 'three', 'four', 'five'], f);
  assert.equal(entries.length, 5);
  assert.equal(new Set(entries.map(e => e.name.toLowerCase())).size, 5);
  assert.ok(entries.every(e => !/[\\/]/.test(e.name)));
  assert.equal(entries[3].name, 'file');
  assert.equal(entries[4].name, '_CON.pdf');
});

test('unknown, quarantined and missing files reject the whole selection', async t => {
  const f = fixture(t); f.add('one'); f.add('hidden'); f.hidden.add('hidden');
  const missing = f.add('missing'); fs.unlinkSync(path.join(f.root, missing.filename));
  for (const id of ['unknown', 'hidden', 'missing']) await assert.rejects(() => planSelection(['one', id], f), error => error.status === 409);
  await assert.rejects(() => planSelection([], f), error => error.status === 400);
  await assert.rejects(() => planSelection([null], f), error => error.status === 400);
});

test('an available cloud copy is exported when its local original is unavailable', async t => {
  const f = fixture(t), record = f.add('cloud-only');
  const source = path.join(f.root,record.filename);
  const cloud = path.join(f.root,'cloud-copy.pdf');fs.renameSync(source,cloud);
  const entries=await planSelection([record.id],{...f,pathsFor:()=>[source,cloud]});
  assert.equal(entries[0].file,cloud);
  assert.equal(fs.readFileSync(cloud,'utf8'),'contents of cloud-only');
});

test('download tickets stream the selected ZIP once and expire without retaining file data', async t => {
  const f = fixture(t); f.add('one'); f.add('two'); f.add('not-selected');
  let time = Date.now();
  const app = express(); app.use(express.json());
  register(app, { ...f, now:() => time, sameOrigin:(req,res,next) => next() });
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const prepare = ids => fetch(base+'/api/export/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
  const response = await prepare(['two','one','two']);
  assert.equal(response.status,200);
  const ticket = await response.json(); assert.equal(ticket.count,2);
  const download = await fetch(base+'/api/export/media?ticket='+ticket.ticket);
  assert.equal(download.status,200);
  assert.match(download.headers.get('content-disposition'),/attachment;.*\.zip/);
  assert.deepEqual(zipNames(Buffer.from(await download.arrayBuffer())).sort(),['invoice (2).pdf','invoice.pdf']); // ZIP entry order follows asynchronous filesystem reads.
  assert.equal((await fetch(base+'/api/export/media?ticket='+ticket.ticket)).status,410);
  const expired = await (await prepare(['one'])).json(); time += 120001;
  assert.equal((await fetch(base+'/api/export/media?ticket='+expired.ticket)).status,410);
  assert.equal((await prepare(['one','unknown'])).status,409);
});
