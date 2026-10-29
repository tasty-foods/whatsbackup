'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');

// localPathFor is asynchronous and may fall back to the mounted cloud drive.
// Keep the two actual copies distinct; a mounted drive is not a second PC copy.
async function locate(record, { backup = require('./backup'), stat = fs.stat } = {}) {
  const [candidate, cloudExpected] = await Promise.all([backup.localPathFor(record), backup.cloudPathFor(record)]);
  let cloud = null;
  if (cloudExpected) {
    try { if ((await stat(cloudExpected)).isFile()) cloud = cloudExpected; } catch (_) {}
  }
  const same = candidate && cloudExpected && path.resolve(candidate).toLowerCase() === path.resolve(cloudExpected).toLowerCase();
  const local = same ? null : candidate || null;
  return {
    local, cloud, cloudExpected: cloudExpected || null,
    preferred: local || cloud,
    localLink: local ? pathToFileURL(local).href : null,
    cloudLink: cloud ? pathToFileURL(cloud).href : null,
  };
}

module.exports = { locate };
