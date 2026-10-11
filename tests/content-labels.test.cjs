const { test } = require('node:test');
const assert = require('node:assert/strict');
const { visualLabel, frameLabels } = require('../src/content/label-data');
test('image-thumbnail bytes never appear as conversation text or AI context', () => {
  const readable = require('../src/content/message-text');
  assert.equal(readable('/9j/' + 'A'.repeat(10000)), '');
  assert.equal(readable('iVBORw0KGgo' + 'B'.repeat(2000)), '');
  assert.equal(readable('Please measure the closed cupboard. Invoice AB-778.'), 'Please measure the closed cupboard. Invoice AB-778.');
});
test('unstructured AI replies cannot corrupt the index or break the viewer', () => {
  assert.throws(() => visualLabel(null), /no usable/);
  const label = visualLabel({ caption: ' A closed cupboard ', details: 'wrong type', tags: [null, {}, 'wood'], text_in_image: 4 });
  assert.equal(label.caption, 'A closed cupboard');
  assert.deepEqual(label.tags, ['wood']); assert.deepEqual(label.details, []);
  assert.equal(label.text_in_image, '');
});
test('video evidence only accepts real sampled timestamps and useful descriptions', () => {
  assert.throws(() => frameLabels('invalid', [0]), /sampled/);
  assert.throws(() => frameLabels([{ seconds: 99, description: 'invented' }], [0]), /no descriptions/);
  assert.deepEqual(frameLabels([null, { seconds: 2, description: 'Cabinet doors shut' }, { seconds: 2, description: 'Duplicate' }, { seconds: 0, description: 'Entrance' }], [0, 2]), [{ seconds: 0, description: 'Entrance' }, { seconds: 2, description: 'Cabinet doors shut' }]);
});
