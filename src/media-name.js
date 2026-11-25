'use strict';
// The part of a captured file's name that keeps it apart from every other:
//
//   <yyyymmdd-hhmmss>__<in|out>__<chat>__<tag>.<ext>
//
// The tag was the last ten letters and digits of the whole message key. For a
// message in a group that key ends with the sender (…_<message id>_<sender>),
// so the tag was the tail of the sender's number: two pictures from one
// person in the same second — an album, every time — got the same name, and
// the second file overwrote the first. The tag now comes from the message's
// own id, which is what the name was always meant to carry. One-to-one chats
// keep exactly the names they had, because there the key ends with that id.
const alnum = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

// key: the serialized message key, <fromMe>_<chat>_<message id>[_<sender>].
function tagFor(msg, key) {
  const own = (msg && msg.id && typeof msg.id.id === 'string' && msg.id.id) || String(key || '').split('_')[2] || String(key || '');
  return alnum(own).slice(-10) || alnum(key).slice(-10);
}

// A name no other record holds: the name itself, or the first of name-2,
// name-3 … that is free. Whatever a future id looks like, one saved file is
// never written over another's.
function unused(filename, taken) {
  if (!taken(filename)) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

module.exports = { tagFor, unused };
