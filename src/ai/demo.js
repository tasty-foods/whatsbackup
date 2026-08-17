'use strict';
// Demo mode: answers the same call shapes as a real provider, deterministically
// and for free. It exists so the whole pipeline — queue, costs, albums,
// corrections, the UI — can be exercised and verified before anyone pays for a
// key, and so a user can see what sorting looks like before deciding.
//
// It reads only what a real call would see (the caption text, the chat name),
// so its guesses are plausible without pretending to be intelligent.
const crypto = require('crypto');

const pick = (seed, list) => list[parseInt(crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8), 16) % list.length];

const SCENES = ['workshop', 'delivery van', 'office desk', 'shop floor', 'kitchen', 'outdoors'];
const SUBJECTS = [['machine', 'panel'], ['boxes', 'pallet'], ['document', 'paperwork'], ['food', 'packaging'], ['person', 'tools']];
const TAGS = [['equipment', 'repair'], ['delivery', 'logistics'], ['invoice', 'admin'], ['product', 'stock'], ['team', 'onsite']];
const CATEGORIES = ['work', 'logistics', 'admin', 'product', 'personal'];

function labelImage(seed, hint) {
  const subjects = pick(seed + 'sub', SUBJECTS);
  return {
    caption: `A photo showing ${subjects.join(' and ')}${hint ? ` (${hint})` : ''}.`,
    subjects,
    scene: pick(seed + 'scene', SCENES),
    text_in_image: '',
    tags: pick(seed + 'tags', TAGS),
  };
}

function labelChat(seed, name) {
  return {
    summary: `Conversation with ${name || 'a contact'} covering day-to-day coordination.`,
    topics: pick(seed + 'topics', TAGS),
    category: pick(seed + 'cat', CATEGORIES),
    is_project: /project|install|order|bouw|werk/i.test(name || ''),
  };
}

// The arrange call: group items by the first tag their fact line carries, which
// mimics a real clustering result closely enough to test everything downstream.
function arrange(user) {
  const lines = user.split('\n').filter((l) => /^\s*\d+[.|)]/.test(l));
  const buckets = new Map();
  for (const line of lines) {
    const idx = parseInt(line.match(/^\s*(\d+)/)[1], 10);
    const key = pick(line.replace(/^\s*\d+/, ''), ['Equipment & repairs', 'Deliveries', 'Paperwork', 'Products', 'People & places']);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(idx);
  }
  const groups = [...buckets.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([name, members]) => ({ id: '', name, description: `Demo grouping: ${name.toLowerCase()}.`, emoji: '📁', members }));
  const placed = new Set(groups.flatMap((g) => g.members));
  return { groups, unsorted: lines.map((l) => parseInt(l.match(/^\s*(\d+)/)[1], 10)).filter((i) => !placed.has(i)) };
}

async function complete(cfg, req) {
  await new Promise((r) => setTimeout(r, 60));   // enough delay to see progress move
  const seed = (req.user || '').slice(0, 400);
  let json = null;
  if (req.schema) {
    const props = req.schema.properties || {};
    if (props.groups) json = arrange(req.user || '');
    else if (props.caption) json = labelImage(seed, (req.user.match(/caption:\s*(.+)/i) || [])[1]);
    else if (props.summary) json = labelChat(seed, (req.user.match(/chat:\s*(.+)/i) || [])[1]);
    else if (props.ok) json = { ok: true };
    else if (props.colour) json = { colour: 'red' };
    else if (props.group_id) json = { group_id: null, confidence: 0 };
    else json = {};
  }
  return { json, text: JSON.stringify(json), usage: { in: 0, out: 0 } };
}

module.exports = { complete };
