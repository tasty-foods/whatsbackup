const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localPlan, sanitizePlan, passages, rank } = require('../src/content/search');
const entry = (id, label, kind = 'image', metadata = {}) => ({ id, passages: passages({ kind, ...metadata }, label) });
test('content search understands descriptive phrases, synonyms and explicit object states', () => {
  const rows = [entry('closed', { caption: 'A wooden cabinet with shut doors in the kitchen.' }), entry('open', { caption: 'An open wooden cupboard with visible shelves.' }), entry('misleading-name', null, 'image', { filename: 'closed-cupboard.jpg' })];
  const result = rank(rows, localPlan('find a picture with a closed cupboard'), { scope: 'content' });
  assert.deepEqual(result.map(r => r.id), ['closed']);
  assert.equal(rank(rows, localPlan('gesloten kast'), { scope: 'content' })[0].id, 'closed');
  assert.equal(rank(rows, localPlan('closed cupboard'), { scope: 'names' })[0].id, 'misleading-name');
});
test('negated objects do not count as positive evidence and exclusions narrow results', () => {
  const rows = [entry('none', { caption: 'A kitchen with no cupboard.' }), entry('wood', { caption: 'A wooden cupboard.' }), entry('metal', { caption: 'A metal cupboard.' })];
  assert.deepEqual(rank(rows, localPlan('cupboard without wood')).map(r => r.id), ['metal']);
});
test('video results retain the matching frame timestamp; context-only old labels cannot claim visual matches', () => {
  const rows = [entry('clip', { visual: true, caption: 'A room tour.', frames: [{ seconds: 2, description: 'Open shelving.' }, { seconds: 14.5, description: 'A closed cabinet in the hallway.' }] }, 'video'), entry('guess', { visual: false, caption: 'A closed cupboard.' }, 'video')];
  const result = rank(rows, localPlan('closed cupboard'), { scope: 'content' });
  assert.equal(result.length, 1); assert.equal(result[0].seconds, 14.5); assert.equal(result[0].evidence, 'Video frame');
});
test('document matches return the actual page and preserve product numbers', () => {
  const row = entry('pdf', { chunks: [{ page: 1, text: 'Delivery invoice INV-4821' }, { page: 7, text: 'Spare part ABC-779 costs 129 EUR.' }] }, 'document');
  const result = rank([row], localPlan('ABC-779'), { scope: 'content' });
  assert.equal(result[0].page, 7); assert.match(result[0].excerpt, /129 EUR/);
});
test('malformed AI query expansion falls back to local matching and remains bounded', () => {
  assert.deepEqual(sanitizePlan({ groups: [null, 42] }, 'closed cupboard'), localPlan('closed cupboard'));
  assert.equal(sanitizePlan({ groups: Array.from({length: 40}, () => ['a']) }, 'q').groups.length, 8);
});
