const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { zipSync, strToU8 } = require('fflate');

function pdf(text) {
  const content = `BT /F1 18 Tf 20 160 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let output = '%PDF-1.4\n', offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const start = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}
test('desktop file worker reads PDF, Office and text, resizes photos, and samples real video frames', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsbackup-content-'));
  const worker = new Worker(path.resolve(__dirname, '../src/content/worker.js'));
  t.after(async () => { await worker.terminate(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(root).startsWith('whatsbackup-content-')); await fs.rm(root, { recursive: true, force: true }); });
  let next = 0;
  const run = task => new Promise((resolve, reject) => {
    const id = ++next;
    const handler = m => { if (m.id !== id) return; worker.off('message', handler); m.error ? reject(new Error(m.error)) : resolve(m.result); };
    worker.on('message', handler); worker.postMessage({ id, dirs: [root], ...task });
  });
  await fs.writeFile(path.join(root, 'invoice.pdf'), pdf('Invoice INV-4821 Total 129 EUR Supplier Tasty Foods Belgium'));
  const readPdf = await run({ kind: 'document', filename: 'invoice.pdf', pages: 30, ocrPages: 0 });
  assert.match(readPdf.chunks[0].text, /INV-4821/); assert.equal(readPdf.chunks[0].page, 1); assert.equal(readPdf.totalPages, 1);
  assert.equal(readPdf.scans.length, 0, 'OCR limit zero must never prepare pages for an AI call');
  const rendered = await run({ kind: 'document', filename: 'invoice.pdf', pages: 30, ocrPages: 1 });
  assert.equal(rendered.scans.length, 1); assert.ok(Buffer.from(rendered.scans[0].data, 'base64').length > 1000);
  await fs.writeFile(path.join(root, 'order.docx'), zipSync({ 'word/document.xml': strToU8('<w:document><w:p><w:r><w:t>Order ZX-778 closed cabinet</w:t></w:r></w:p></w:document>'), 'unrelated.bin': new Uint8Array(100) }));
  const readDoc = await run({ kind: 'document', filename: 'order.docx' }); assert.match(readDoc.chunks[0].text, /ZX-778 closed cabinet/);
  await fs.writeFile(path.join(root, 'stock.xlsx'), zipSync({ 'xl/sharedStrings.xml': strToU8('<sst><si><t>Cabinet ABC-779</t></si></sst>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c><c><v>129</v></c></row></sheetData></worksheet>') }));
  const sheet = await run({ kind: 'document', filename: 'stock.xlsx' }); assert.match(sheet.chunks[0].text, /Cabinet ABC-779 \| 129/);
  await fs.writeFile(path.join(root, 'notes.txt'), 'Cupboard doors are closed. Receipt 5729.');
  assert.match((await run({ kind: 'document', filename: 'notes.txt' })).chunks[0].text, /5729/);
  await fs.writeFile(path.join(root, 'large.txt'), 'A'.repeat(210000));
  assert.equal((await run({ kind: 'document', filename: 'large.txt' })).truncated, true);
  await require('sharp')({ create: { width: 2200, height: 1400, channels: 3, background: '#a2774d' } }).png().toFile(path.join(root, 'photo.png'));
  const photo = await run({ kind: 'image', filename: 'photo.png' });
  const meta = await require('sharp')(Buffer.from(photo.image.data, 'base64')).metadata(); assert.equal(meta.width, 1280); assert.equal(meta.format, 'jpeg');
  const imageDocument = await run({ kind: 'document', filename: 'photo.png', ocrPages: 1 });
  assert.equal(imageDocument.scans[0].documentImage, true);
  assert.equal((await run({ kind: 'document', filename: 'photo.png', ocrPages: 0 })).scans.length, 0);
  await new Promise((resolve, reject) => execFile(require('ffmpeg-static'), ['-hide_banner','-nostdin','-y','-f','lavfi','-i','testsrc=size=320x240:rate=10','-t','4','-c:v','mpeg4',path.join(root,'clip.mp4')], { windowsHide: true, timeout: 20000 }, err => err ? reject(err) : resolve()));
  const clip = await run({ kind: 'video', filename: 'clip.mp4', frames: 4, poster: path.join(root, 'poster.jpg') });
  assert.equal(clip.duration, 4); assert.equal(clip.frames.length, 2); assert.ok(clip.frames[1].seconds > clip.frames[0].seconds); assert.ok((await fs.stat(path.join(root,'poster.jpg'))).size > 500);
  await assert.rejects(run({ kind: 'document', filename: '../escape.txt' }), /Invalid file name/);
  await fs.writeFile(path.join(root, 'old.doc'), 'unsupported'); await assert.rejects(run({ kind: 'document', filename: 'old.doc' }), /Unsupported document/);
});
