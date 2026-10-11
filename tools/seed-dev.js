'use strict';
// Fills .dev-home/ with a small, varied archive: photos (three of them versions
// of one advert), a PDF, a Word document, a voice note, conversations with a
// group chat, and an address book — enough to exercise every view and every
// AI pass in demo mode. Idempotent: run it again to start over.
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const HOME = process.env.WB_HOME || path.join(__dirname, '..', '.dev-home');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
const MEDIA = path.join(HOME, 'media');
for (const d of ['images', 'videos', 'files']) fs.mkdirSync(path.join(MEDIA, d), { recursive: true });

fs.writeFileSync(path.join(HOME, 'data', 'settings.json'), JSON.stringify({
  port: 8799, mediaRoot: '', cloudRoot: '', mirrorImages: false,
  captureImages: true, captureVideos: true, captureVoice: true, captureAudio: true, captureDocuments: true, captureStickers: false,
  captureConversations: true, setupComplete: true, consentAccepted: true,
  aiEnabled: true, aiConsent: true, aiProvider: 'demo', aiModel: 'demo', aiMode: 'assist',
  aiAnalyseImages: true, aiAnalyseChats: true, aiAnalyseDocuments: true, aiTranscribeAudio: true, aiAnalyseVideos: true, aiVideoFrames: 6, aiTopics: true, aiEmbeddings: true, aiFinals: true,
  aiMonthlyBudget: 5,
}, null, 2));

/* ---------- pictures ---------- */
let sharp = null;
try { sharp = require('sharp'); } catch (_) {}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
async function picture(file, { w = 1200, h = 800, bg = '#1f6f8b', fg = '#ffffff', title = '', sub = '', shapes = '' } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="${bg}"/>${shapes}
    <text x="60" y="${Math.round(h * 0.42)}" font-family="Arial" font-size="${Math.round(h * 0.12)}" font-weight="bold" fill="${fg}">${esc(title)}</text>
    <text x="60" y="${Math.round(h * 0.58)}" font-family="Arial" font-size="${Math.round(h * 0.06)}" fill="${fg}">${esc(sub)}</text>
  </svg>`;
  const out = path.join(MEDIA, 'images', file);
  if (sharp) await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toFile(out);
  else fs.writeFileSync(out.replace(/\.jpg$/, '.svg'), svg);
  return fs.statSync(sharp ? out : out.replace(/\.jpg$/, '.svg')).size;
}

/* ---------- a PDF with real text ---------- */
function pdf(file, lines) {
  const content = ['BT', '/F1 18 Tf', '50 760 Td', '20 TL']
    .concat(lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`)).concat(['ET']).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const p = path.join(MEDIA, 'files', file);
  fs.writeFileSync(p, out, 'latin1');
  return fs.statSync(p).size;
}

/* ---------- a .docx (a zip of XML) ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0, 12); head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(deflated.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    parts.push(head, nameBuf, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0, 14); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(deflated.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += head.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, end]);
}
function docx(file, paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const p = path.join(MEDIA, 'files', file);
  fs.writeFileSync(p, zip([['[Content_Types].xml', types], ['word/document.xml', doc]]));
  return fs.statSync(p).size;
}

/* ---------- records ---------- */
const DAY = 86400000, H = 3600000;
const now = Date.now();
const stamp = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const records = [];
const msgs = [];
let seq = 100;
// The shape WhatsApp gives a message id: <fromMe>_<chat id>_<hash>.
const mid = (fromMe, chatId) => `${fromMe}_${chatId}_${(seq++).toString(16).toUpperCase().padStart(10, 'A')}`;

async function media({ chatId, chat, ts, dir, kind, ext, make, caption = '', docName = '', mimetype }) {
  const id = mid(dir === 'out', chatId);
  const area = kind === 'video' ? 'videos' : (kind === 'image' || kind === 'sticker') ? 'images' : 'files';
  const filename = `${stamp(ts)}__${dir}__${chat.replace(/[^\p{L}\p{N}\-_. ]/gu, '_')}__${id.replace(/[^A-Za-z0-9]/g, '').slice(-10)}.${ext}`;
  const size = await make(filename);
  const rec = { id, ts, dir, kind, chat, number: chatId.split('@')[0], mimetype, filename, serve: `/media/${area}/` + encodeURIComponent(filename), size, caption, docName, cloud: false };
  records.push(rec);
  msgs.push({ id, chatId, chatName: chat, ts, fromMe: dir === 'out', author: dir === 'out' ? 'me' : null, type: kind === 'voice' ? 'ptt' : kind, body: caption, mediaKind: kind, mediaServe: rec.serve, mediaId: id });
  return rec;
}
const text = (chatId, chat, ts, fromMe, body, author) => msgs.push({ id: mid(fromMe, chatId), chatId, chatName: chat, ts, fromMe, author: fromMe ? 'me' : (author || null), type: 'chat', body });

(async () => {
  const designer = { id: '32470000001@c.us', name: 'Lotte Design' };
  const supplier = { id: '32470000002@c.us', name: 'Van Dam Packaging' };
  const family = { id: '32470000003@c.us', name: 'Mum' };
  const group = { id: '120363000000000001@g.us', name: 'Shop team' };
  const unknown = { id: '98765432100@lid', name: 'unknown' };

  // The advert: three versions in one afternoon, then a decision in words.
  const t0 = now - 3 * DAY + 10 * H;
  for (const [i, bg] of [['1', '#b23a48'], ['2', '#2a9d8f'], ['3', '#e9c46a']].entries()) {
    await media({ chatId: designer.id, chat: designer.name, ts: t0 + i * 25 * 60000, dir: 'in', kind: 'image', ext: 'jpg', mimetype: 'image/jpeg',
      caption: `Spring sale advert, version ${bg[0]}`,
      make: (f) => picture(f, { bg: bg[1], title: 'SPRING SALE', sub: `-20% on all cakes · version ${bg[0]}`, shapes: '<circle cx="1000" cy="200" r="120" fill="rgba(255,255,255,.25)"/>' }) });
  }
  text(designer.id, designer.name, t0 + 80 * 60000, false, 'Three options for the spring sale advert. Which one do you prefer?');
  text(designer.id, designer.name, t0 + 95 * 60000, true, 'The second one, the green. Go with that for print and socials.');
  text(designer.id, designer.name, t0 + 100 * 60000, false, 'Perfect, sending the final files tonight.');
  await media({ chatId: designer.id, chat: designer.name, ts: t0 + 9 * H, dir: 'in', kind: 'document', ext: 'pdf', mimetype: 'application/pdf', docName: 'Spring sale - print ready.pdf',
    make: (f) => pdf(f, ['SPRING SALE 2026', 'Print-ready artwork, A3 poster', 'Tasty Foods - 20% off all cakes', 'Valid 15 March to 15 April 2026', 'Reference SS-2026-02']) });

  // A supplier: a quote, an invoice, a delivery photo, a voice note.
  const t1 = now - 12 * DAY;
  text(supplier.id, supplier.name, t1, false, 'Hello, here is the quote for the 500 cake boxes as discussed.');
  await media({ chatId: supplier.id, chat: supplier.name, ts: t1 + 2 * 60000, dir: 'in', kind: 'document', ext: 'docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docName: 'Quote Q-2026-118.docx',
    make: (f) => docx(f, ['Quotation Q-2026-118', 'Van Dam Packaging BV', '500 x cake box 25x25x10 cm, kraft, printed logo', 'Unit price EUR 0.42, total EUR 210.00 excl. VAT', 'Delivery within 10 working days']) });
  text(supplier.id, supplier.name, t1 + H, true, 'Looks good, please go ahead. Can you deliver on Thursday?');
  text(supplier.id, supplier.name, t1 + 2 * H, false, 'Thursday is fine, between 9 and 11.');
  await media({ chatId: supplier.id, chat: supplier.name, ts: t1 + 6 * DAY, dir: 'in', kind: 'image', ext: 'jpg', mimetype: 'image/jpeg', caption: 'Delivered this morning',
    make: (f) => picture(f, { bg: '#8d6e63', title: 'PALLET', sub: '500 boxes, delivered', shapes: '<rect x="700" y="300" width="400" height="300" fill="#a1887f"/>' }) });
  await media({ chatId: supplier.id, chat: supplier.name, ts: t1 + 7 * DAY, dir: 'in', kind: 'document', ext: 'pdf', mimetype: 'application/pdf', docName: 'Invoice 4021.pdf',
    make: (f) => pdf(f, ['INVOICE 4021', 'Van Dam Packaging BV', 'To: Tasty Foods', '500 x cake box kraft printed  EUR 210.00', 'VAT 21%  EUR 44.10', 'Total EUR 254.10, due 30 days']) });
  await media({ chatId: supplier.id, chat: supplier.name, ts: t1 + 7 * DAY + H, dir: 'in', kind: 'voice', ext: 'ogg', mimetype: 'audio/ogg; codecs=opus', caption: '',
    make: (f) => { const p = path.join(MEDIA, 'files', f); fs.writeFileSync(p, Buffer.from('OggS\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0', 'binary')); return fs.statSync(p).size; } });
  text(supplier.id, supplier.name, t1 + 7 * DAY + 2 * H, true, 'Thanks, paid today.');

  // A group with raw author ids, as WhatsApp hands them over.
  const t2 = now - 2 * DAY;
  const staff = ['32470000011@c.us', '32470000012@c.us', '98765432111@lid'];
  text(group.id, group.name, t2, false, 'Who is opening tomorrow?', staff[0]);
  text(group.id, group.name, t2 + 5 * 60000, false, 'I can do it, 7am', staff[1]);
  text(group.id, group.name, t2 + 6 * 60000, true, 'Great. The oven repair man comes at 10.');
  text(group.id, group.name, t2 + 8 * 60000, false, 'Ok, I will let him in', staff[2]);
  await media({ chatId: group.id, chat: group.name, ts: t2 + 26 * H, dir: 'in', kind: 'image', ext: 'jpg', mimetype: 'image/jpeg', caption: 'Oven fixed',
    make: (f) => picture(f, { bg: '#37474f', title: 'OVEN', sub: 'repaired, new thermostat' }) });

  // Family: a few photos, nothing businesslike.
  const t3 = now - 20 * DAY;
  for (let i = 0; i < 4; i++) {
    await media({ chatId: family.id, chat: family.name, ts: t3 + i * 2 * DAY, dir: i % 2 ? 'out' : 'in', kind: 'image', ext: 'jpg', mimetype: 'image/jpeg', caption: i === 1 ? 'Sunday lunch' : '',
      make: (f) => picture(f, { bg: ['#ff8a65', '#4db6ac', '#9575cd', '#f06292'][i], title: ['GARDEN', 'LUNCH', 'BEACH', 'BIRTHDAY'][i], sub: 'family' }) });
  }
  text(family.id, family.name, t3 + 2 * DAY + H, false, 'Lovely! See you Sunday.');

  // A chat whose name was never found.
  text(unknown.id, unknown.name, now - 5 * DAY, false, 'Hi, is the shop open on Monday?');
  text(unknown.id, unknown.name, now - 5 * DAY + H, true, 'Yes, from 9 to 18.');

  fs.writeFileSync(path.join(HOME, 'data', 'index.ndjson'), records.sort((a, b) => a.ts - b.ts).map((r) => JSON.stringify(r)).join('\n') + '\n');

  process.env.WB_HOME = HOME;
  const messages = require('../src/messages');
  messages.init();
  messages.addMany(msgs);
  messages.upsertContacts([
    { id: designer.id, number: '32470000001', name: 'Lotte Design', pushname: 'Lotte' },
    { id: supplier.id, number: '32470000002', name: 'Van Dam Packaging', pushname: 'Kees' },
    { id: family.id, number: '32470000003', name: 'Mum' },
    { id: staff[0], number: '32470000011', name: 'Sam (shop)' },
    { id: staff[1], number: '32470000012', name: 'Noor' },
    { id: '32470000013@c.us', number: '32470000013', name: 'Youssef', lid: '98765432111@lid' },
    { id: '32470000099@c.us', number: '32470000099', name: 'Oven Service Antwerp', lid: '98765432100@lid' },
  ]);
  messages.upsertChats([
    { id: designer.id, name: 'Lotte Design', isGroup: false, lastTs: t0 + 9 * H },
    { id: supplier.id, name: 'Van Dam Packaging', isGroup: false, lastTs: t1 + 7 * DAY + 2 * H },
    { id: group.id, name: 'Shop team', isGroup: true, lastTs: t2 + 26 * H },
    { id: family.id, name: 'Mum', isGroup: false, lastTs: t3 + 7 * DAY },
    { id: '32470000050@c.us', name: 'Accountant', isGroup: false, lastTs: now - DAY },   // known to WhatsApp, nothing captured yet
  ]);
  console.log(`seeded ${records.length} media records, ${msgs.length} messages into ${HOME}`);
})().catch((e) => { console.error(e); process.exit(1); });
