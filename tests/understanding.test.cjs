// The local, free parts of understanding: text out of documents, a query read
// for its dates and kinds, plurals searched by their stem, versions of one
// thing clustered, a model's topic list validated. No network, no database
// file: what needs SQLite runs in memory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const extract = require('../src/ai/extract');
const search = require('../src/search');
const topics = require('../src/ai/topics');

/* ---- a zip, the way seed-dev.js makes one ---- */
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8'), def = zlib.deflateRawSync(data), nb = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(def.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    parts.push(h, nb, def);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(def.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nb); offset += h.length + nb.length + def.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('a Word document gives up its paragraphs, a spreadsheet its cells', async () => {
  const docx = zip([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Quotation Q-2026-118</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">500 x cake box, </w:t></w:r><w:r><w:t>EUR 210.00</w:t></w:r></w:p></w:body></w:document>']]);
  const d = await extract.extractText(docx, 'docx');
  assert.equal(d.text, 'Quotation Q-2026-118\n500 x cake box, EUR 210.00');
  const xlsx = zip([
    ['xl/sharedStrings.xml', '<sst><si><t>Item</t></si><si><t>Cake box</t></si></sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c><c><v>210</v></c></row></sheetData></worksheet>'],
  ]);
  const x = await extract.extractText(xlsx, 'xlsx');
  assert.match(x.text, /Item \| 42/);
  assert.match(x.text, /Cake box \| 210/);
  const none = await extract.extractText(Buffer.from('OggS'), 'ogg');
  assert.equal(none.text, '');
  assert.equal(none.note, 'unsupported type');
});

test('a PDF with real text is read, page count and all', async () => {
  const content = 'BT /F1 18 Tf 50 760 Td (INVOICE 4021) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const r = await extract.extractText(Buffer.from(out, 'latin1'), 'pdf');
  assert.equal(r.pages, 1);
  assert.match(r.text, /INVOICE 4021/);
});

test('a query is read for its month, kind and direction, and the rest is searched', () => {
  const now = new Date(2026, 9, 11, 12).getTime();   // 11 October 2026
  const a = search.parseQuery('invoices from Van Dam last month', now);
  assert.equal(a.kind, 'document');
  assert.equal(a.docType, 'invoice');
  assert.equal(a.chat, 'Van Dam');
  assert.equal(new Date(a.from).getMonth(), 8);
  assert.equal(new Date(a.to).getMonth(), 9);
  const b = search.parseQuery('photos sent in march 2026', now);
  assert.equal(b.kind, 'image');
  assert.equal(b.dir, 'out');
  assert.equal(new Date(b.from).toISOString().slice(0, 10), new Date(2026, 2, 1).toISOString().slice(0, 10));
  assert.equal(b.text, '');
  const c = search.parseQuery('oven thermostat', now);
  assert.equal(c.text, 'oven thermostat');
  assert.equal(c.from, 0);
  const d = search.parseQuery('voice notes yesterday', now);
  assert.equal(d.kind, 'audio');
  assert.equal(d.from, new Date(2026, 9, 10).getTime());
});

test('messages are found by the stem of a plural and by any word of a question', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsbackup-fts-'));
  process.env.WB_HOME = root;
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/](messages|config|settings|paths)\.js$/.test(k)) delete require.cache[k];
  const messages = require('../src/messages');
  messages.init();
  messages.addMany([
    { id: 'a', chatId: 'c1', chatName: 'Supplier', ts: 1000, fromMe: false, body: 'Here is the quote for the 500 cake boxes' },
    { id: 'b', chatId: 'c1', chatName: 'Supplier', ts: 2000, fromMe: true, body: 'Can you deliver on Thursday?' },
    { id: 'c', chatId: 'c2', chatName: 'Mum', ts: 3000, fromMe: false, body: 'Lovely, see you Sunday' },
  ]);
  assert.equal(messages.ftsQuery('cake boxes'), '"cake"* AND "box"*');
  assert.deepEqual(messages.search('box', 10).map((m) => m.id), ['a']);
  assert.deepEqual(messages.search('cake boxes', 10).map((m) => m.id), ['a']);
  assert.equal(messages.search('when will the boxes be delivered', 10).length, 0);
  const any = messages.search('when will the boxes be delivered', 10, { mode: 'any' }).map((m) => m.id).sort();
  assert.deepEqual(any, ['a', 'b']);
  assert.match(messages.search('thursday', 10)[0].snippet, /\[\[Thursday\]\]/);
  messages.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('versions of one thing cluster by near fingerprint or alike captions, inside the window', () => {
  const finals = require('../src/ai/finals');
  const H = 3600000;
  const rec = (id, ts, caption) => ({ id, ts, caption, chat: 'Designer', kind: 'image' });
  const items = [
    { rec: rec('a', 0, 'Spring sale advert, version 1'), fp: { hash: 'ffff000000000000' }, label: { kind: 'design', caption: 'spring sale poster' } },
    { rec: rec('b', H, 'Spring sale advert, version 2'), fp: { hash: 'ffff000000000001' }, label: { kind: 'design', caption: 'spring sale poster green' } },
    { rec: rec('c', 2 * H, 'Lunch'), fp: { hash: '0f0f0f0f0f0f0f0f' }, label: { kind: 'photo', caption: 'a plate of food' } },
    { rec: rec('d', 200 * H, 'Spring sale advert, version 3'), fp: { hash: 'ffff000000000002' }, label: { kind: 'design', caption: 'spring sale poster' } },
  ];
  const groups = finals.cluster(items, (x, y) => finals.related(x.rec, y.rec, x.fp, y.fp, x.label, y.label));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((g) => g.rec.id), ['a', 'b']);   // d is a week later: not the same afternoon's versions
  assert.equal(finals.stem('offer v2 final.docx'), 'offer');
});

test('a topic list from a model is bounded to the messages it was shown', () => {
  const out = topics.validate({ topics: [
    { title: 'Oven repair', summary: 's', keywords: ['Oven'], people: [], decisions: ['Fixed on Monday'], first_index: 2, last_index: 90 },
    { title: '', first_index: 1, last_index: 2 },
    { title: 'Backwards', summary: '', keywords: [], people: [], decisions: [], first_index: 7, last_index: 3 },
  ] }, 10);
  assert.equal(out.length, 2);
  assert.equal(out[0].b, 10);
  assert.deepEqual(out[0].keywords, ['oven']);
  assert.equal(out[1].a, 3);
  assert.equal(out[1].b, 7);
});
