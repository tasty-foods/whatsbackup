// The name a captured file is saved under must be its own. Two pictures sent
// by one person to a group in the same second used to share a name, and the
// second was written over the first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tagFor, unused } = require('../src/media-name');

const oldTag = (key) => key.replace(/[^A-Za-z0-9]/g, '').slice(-10);

test('two messages from one sender in a group get different tags', () => {
  const a = 'false_120363000000000001@g.us_3EB0C767D26B8F8A2D9E_32470000011@c.us';
  const b = 'false_120363000000000001@g.us_3EB0A1B2C3D4E5F60718_32470000011@c.us';
  assert.equal(oldTag(a), oldTag(b));                     // the fault: both were "0000011cus"
  assert.notEqual(tagFor(null, a), tagFor(null, b));
  assert.equal(tagFor(null, a), '6B8F8A2D9E');
  // The message's own id is used when the library hands it over directly.
  assert.equal(tagFor({ id: { id: '3EB0A1B2C3D4E5F60718' } }, a), 'D4E5F60718');
  // The same holds for senders known only by a linked id.
  const lidA = 'false_120363000000000001@g.us_AAAA1111_98765432111@lid';
  const lidB = 'false_120363000000000001@g.us_BBBB2222_98765432111@lid';
  assert.notEqual(tagFor(null, lidA), tagFor(null, lidB));
});

test('one-to-one chats keep exactly the names they always had', () => {
  for (const key of ['false_32470000001@c.us_3EB0C767D26B8F8A2D9E', 'true_32470000001@c.us_AC5F3B0E9D1C2A', 'true_98765432100@lid_3A00FF11EE22DD33CC44']) {
    assert.equal(tagFor(null, key), oldTag(key));
    assert.equal(tagFor({ id: { id: key.split('_')[2] } }, key), oldTag(key));
  }
});

test('an id of an unexpected shape still gives a tag', () => {
  assert.equal(tagFor(null, 'sample_12'), 'sample12');
  assert.equal(tagFor({ id: { id: '' } }, 'gm_abcdef0123456789'), 'abcdef0123456789'.slice(-10));
  assert.equal(tagFor(null, ''), '');
});

test('a name another record holds is never reused', () => {
  const held = new Set(['a.jpg', 'a-2.jpg', 'noext']);
  const taken = (n) => held.has(n);
  assert.equal(unused('b.jpg', taken), 'b.jpg');
  assert.equal(unused('a.jpg', taken), 'a-3.jpg');
  assert.equal(unused('noext', taken), 'noext-2');
});
