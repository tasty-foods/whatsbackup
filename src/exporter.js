'use strict';
// Writes a full conversation transcript to a LOCAL folder (kept off the cloud
// for privacy). Produces one HTML file per chat + an index + a JSON dump.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const messages = require('./messages');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function safeFile(s) { return String(s || 'chat').replace(/[^\p{L}\p{N}\-_. ]/gu, '_').slice(0, 60) || 'chat'; }

const PAGE_CSS = `body{background:#0b141a;color:#e9edef;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;max-width:820px;margin:0 auto}
h1{font-size:20px}a{color:#53bdeb}.msg{max-width:75%;margin:6px 0;padding:8px 10px;border-radius:8px;background:#202c33;clear:both;float:left}
.msg.out{background:#005c4b;float:right}.meta{font-size:11px;color:#8696a0;margin-top:3px}.day{clear:both;text-align:center;color:#8696a0;margin:16px 0;font-size:12px}
.media{color:#8696a0;font-style:italic}.row{overflow:hidden}`;

function dayLabel(ms) { return new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
function timeLabel(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function renderChat(name, rows) {
  let html = `<!doctype html><meta charset="utf-8"><title>${esc(name)}</title><style>${PAGE_CSS}</style><h1>${esc(name)}</h1><p><a href="index.html">← all chats</a></p>`;
  let lastDay = null;
  for (const m of rows) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    const media = m.mediaKind ? `<div class="media">[${esc(m.mediaKind)}]</div>` : '';
    const body = m.body ? esc(m.body).replace(/\n/g, '<br>') : '';
    html += `<div class="row"><div class="msg ${m.fromMe ? 'out' : ''}">${media}${body}<div class="meta">${m.fromMe ? 'You' : esc(m.author || name)} · ${timeLabel(m.ts)}</div></div></div>`;
  }
  return html;
}

function exportTranscript() {
  const rows = messages.allForExport();
  const dir = path.join(cfg.DATA_DIR, 'exports', 'transcript-' + stamp());
  fs.mkdirSync(dir, { recursive: true });

  // Group by chat.
  const byChat = new Map();
  for (const m of rows) {
    const key = m.chatId;
    if (!byChat.has(key)) byChat.set(key, { name: m.chatName || key, rows: [] });
    byChat.get(key).rows.push(m);
  }

  const chatsMeta = [];
  const usedNames = new Set();
  for (const [key, { name, rows: rr }] of byChat) {
    let file = safeFile(name) + '.html';
    let i = 2; while (usedNames.has(file)) file = safeFile(name) + '-' + (i++) + '.html';
    usedNames.add(file);
    fs.writeFileSync(path.join(dir, file), renderChat(name, rr));
    chatsMeta.push({ name, file, count: rr.length, lastTs: rr.length ? rr[rr.length - 1].ts : 0 });
  }
  chatsMeta.sort((a, b) => b.lastTs - a.lastTs);

  const index = `<!doctype html><meta charset="utf-8"><title>WhatsApp transcript</title><style>${PAGE_CSS}
    table{width:100%;border-collapse:collapse}td{padding:8px 6px;border-bottom:1px solid #202c33}</style>
    <h1>WhatsApp transcript</h1><p>${byChat.size} chats · ${rows.length} messages · exported ${new Date().toLocaleString()}</p>
    <table>${chatsMeta.map((c) => `<tr><td><a href="${esc(c.file)}">${esc(c.name)}</a></td><td>${c.count} msgs</td><td>${c.lastTs ? dayLabel(c.lastTs) : ''}</td></tr>`).join('')}</table>`;
  fs.writeFileSync(path.join(dir, 'index.html'), index);
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(rows));

  return { dir, chats: byChat.size, messages: rows.length, index: path.join(dir, 'index.html') };
}

module.exports = { exportTranscript };
