'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { locate } = require('../src/media-locations');

test('file locations await asynchronous local lookup and return encoded file links for both copies', async () => {
  const local = path.resolve('local', 'label #1 עברית.png');
  const cloud = path.resolve('cloud', 'label #1 עברית.png');
  let resolved = false;
  const backup = {
    localPathFor: async () => { await new Promise(setImmediate); resolved = true; return local; },
    cloudPathFor: () => cloud,
  };
  const result = await locate({ id: 'one' }, { backup, stat: async () => ({ isFile: () => true }) });
  assert.equal(resolved, true);
  assert.equal(result.local, local);
  assert.equal(result.cloud, cloud);
  assert.equal(result.preferred, local);
  assert.equal(result.localLink, pathToFileURL(local).href);
  assert.equal(result.cloudLink, pathToFileURL(cloud).href);
  assert.ok(result.localLink.includes('%23'));
});

test('a video stored only on the cloud drive is not reported as a separate PC copy', async () => {
  const cloud = path.resolve('cloud', 'clip.mp4');
  const result = await locate({}, { backup: { localPathFor: async () => cloud, cloudPathFor: () => cloud }, stat: async () => ({ isFile: () => true }) });
  assert.equal(result.local, null);
  assert.equal(result.cloud, cloud);
  assert.equal(result.preferred, cloud);
  assert.equal(result.localLink, null);
});

test('missing drives and directories are not presented as existing cloud files', async () => {
  const cloud = path.resolve('cloud', 'gone.pdf');
  const backup = { localPathFor: async () => null, cloudPathFor: () => cloud };
  for (const stat of [async () => { throw Error('offline'); }, async () => ({ isFile: () => false })]) {
    const result = await locate({}, { backup, stat });
    assert.equal(result.preferred, null);
    assert.equal(result.cloud, null);
    assert.equal(result.cloudExpected, cloud);
  }
});
