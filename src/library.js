'use strict';
// Personal organisation stays beside the archive, independently of AI labels.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const FILE = path.join(paths.DATA_DIR, 'library.json');
const FILTER_KEYS = ['q', 'source', 'kind', 'exact', 'dir', 'album', 'project', 'tag', 'backup', 'from', 'to', 'sort', 'favorite'];

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || (data.favorites !== undefined && (!Array.isArray(data.favorites) || data.favorites.some(id => typeof id !== 'string')))
      || (data.views !== undefined && (!Array.isArray(data.views) || data.views.some(view => !view || typeof view.id !== 'string' || typeof view.name !== 'string' || !view.filters || typeof view.filters !== 'object' || Array.isArray(view.filters))))) {
      throw new Error('Invalid library preferences');
    }
    return { favorites: Array.isArray(data.favorites) ? data.favorites : [], views: Array.isArray(data.views) ? data.views : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { favorites: [], views: [] };
    throw new Error('Your library preferences could not be read. Your archive is unchanged.');
  }
}
function write(data) {
  fs.mkdirSync(paths.DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return data;
}
function favorite(ids, enabled) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !id || id.length > 500) || typeof enabled !== 'boolean') throw new Error('Choose valid archive items.');
  const data = read(), set = new Set(data.favorites);
  for (const id of ids) enabled ? set.add(id) : set.delete(id);
  data.favorites = [...set];
  return write(data);
}
function saveView(name, filters) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new Error('Give this view a name of up to 60 characters.');
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Invalid saved view.');
  const clean = {};
  for (const key of FILTER_KEYS) {
    if (key === 'favorite') { clean[key] = filters[key] === true; continue; }
    if (typeof filters[key] === 'string') clean[key] = filters[key].slice(0, 300);
  }
  const data = read();
  if (data.views.length >= 30) throw new Error('You have 30 saved views. Remove one to make room.');
  data.views.push({ id: require('crypto').randomUUID(), name: name.trim(), filters: clean });
  return write(data);
}
function deleteView(id) {
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Choose a saved view.');
  const data = read();
  data.views = data.views.filter(view => view.id !== id);
  return write(data);
}
module.exports = { read, favorite, saveView, deleteView, FILTER_KEYS };
