'use strict';
// Pass 2: one text-only call that turns a pile of labels into named groups.
//
// Three things make the result feel stable rather than reshuffled:
//   - existing groups are sent WITH their ids, and the model is asked to move
//     items into them rather than invent a fresh taxonomy every run;
//   - the user's past corrections are replayed as house rules;
//   - members are referenced by ordinal index (1, 2, 3…), never by record id —
//     echoing 400+ thirty-character ids costs thousands of output tokens and
//     silently truncates.
const ai = require('./store');
const { complete } = require('./provider');

const ARRANGE_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      description: 'The groups. Reuse an existing id when a group already covers the same idea; leave id empty for a new group.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'An existing group id, or an empty string for a new group.' },
          name: { type: 'string', description: 'A short human name in the language of the items themselves.' },
          description: { type: 'string', description: 'One sentence on what belongs here.' },
          emoji: { type: 'string', description: 'A single emoji, or empty.' },
          members: { type: 'array', items: { type: 'integer' }, description: 'The item numbers in this group.' },
        },
        required: ['id', 'name', 'description', 'emoji', 'members'],
        additionalProperties: false,
      },
    },
    unsorted: { type: 'array', items: { type: 'integer' }, description: 'Item numbers that do not belong with any others.' },
  },
  required: ['groups', 'unsorted'],
  // Deliberately no minItems/maxItems: OpenAI's strict schema mode rejects
  // those keywords outright. Group-size rules are stated in the prompt and
  // enforced in code below.
  additionalProperties: false,
};

const SYSTEM = [
  'You organise a personal archive into groups that a human would recognise.',
  'You are given numbered items, each with a few facts about it.',
  'Group items that belong to the same real thing: the same project, job, supplier, event, household matter or recurring kind of paperwork.',
  'Do not group by superficial similarity like colour or file type, and never create a group called "Other" or "Miscellaneous" — leave those items unsorted instead.',
  'Aim for between 3 and 20 groups. Every group needs at least 3 items; anything thinner belongs in unsorted.',
  'Name each group in the language the items themselves use.',
  'An item may appear in at most one group.',
].join(' ');

// One line per item, cheap to read and cheap to bill.
function factLine(n, entry) {
  const l = entry.label || {};
  const bits = [];
  if (l.caption) bits.push(l.caption);
  if (l.summary && l.summary !== l.caption) bits.push(l.summary);
  const tags = [...(l.tags || []), ...(l.topics || [])].filter(Boolean);
  if (tags.length) bits.push(tags.slice(0, 6).join(', '));
  if (l.text_in_image) bits.push(`text: "${String(l.text_in_image).replace(/\s+/g, ' ').slice(0, 80)}"`);
  if (entry.chat) bits.push(`from ${entry.chat}`);
  if (entry.when) bits.push(entry.when);
  return `${n}. ${bits.join(' · ').slice(0, 300)}`;
}

function housRules() {
  const rows = ai.recentCorrections(40);
  if (!rows.length) return '';
  const seen = new Set();
  const lines = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.detail); } catch (_) { continue; }
    let line = null;
    if (r.action === 'rename' && d.name) line = `A group the user renamed to "${d.name}" must keep that exact name.`;
    else if (r.action === 'move' && d.groupName) line = `The user placed "${(d.summary || '').slice(0, 60)}" in "${d.groupName}" — respect that kind of placement.`;
    else if (r.action === 'unfile' && d.summary) line = `The user took "${(d.summary || '').slice(0, 60)}" out of every group — leave that kind of item unsorted.`;
    else if (r.action === 'reject' && d.name) line = `Do not recreate a group called "${d.name}" — the user removed it.`;
    if (line && !seen.has(line)) { seen.add(line); lines.push(line); }
  }
  return lines.length ? `\n\nHouse rules from the user's own corrections — follow these over your own judgement:\n${lines.map((l) => '- ' + l).join('\n')}` : '';
}

function existingBlock(kind) {
  const groups = ai.listGroups(kind);
  if (!groups.length) return '';
  const lines = groups.map((g) => `- ${g.id} — "${g.name}"${g.description ? ': ' + g.description : ''}${g.pinned ? ' (the user named this one; keep the name exactly)' : ''}`);
  return `\n\nGroups that already exist. Reuse their id when the same idea applies, and keep their names:\n${lines.join('\n')}`;
}

// Whatever a model returns, only sane things reach the database.
function validate(result, itemCount) {
  const groups = [];
  const claimed = new Set();
  // Ollama and LM Studio get json_object mode rather than a strict schema, so
  // "groups" can come back as something truthy that is not an array; for..of
  // would throw and lose the whole pass.
  const rawGroups = result && Array.isArray(result.groups) ? result.groups : [];
  for (const g of rawGroups) {
    const name = String(g.name || '').trim().slice(0, 60);
    if (!name || /^(other|misc|miscellaneous|unsorted|various)$/i.test(name)) continue;
    const members = [];
    for (const raw of (Array.isArray(g.members) ? g.members : [])) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > itemCount) continue;   // hallucinated index
      if (claimed.has(n)) continue;                                    // first group wins
      claimed.add(n);
      members.push(n);
    }
    if (members.length < 3) { for (const m of members) claimed.delete(m); continue; }
    groups.push({
      id: typeof g.id === 'string' ? g.id.trim() : '',
      name,
      description: String(g.description || '').slice(0, 240),
      emoji: String(g.emoji || '').slice(0, 4),
      members,
    });
  }
  return { groups, placed: claimed.size };
}

// What of a local model's context can be spent on the list itself. Ollama's
// default is 4096 for everything, and the reply needs room too.
const LOCAL_PROMPT_TOKENS = 2800;

// entries: [{ kind, refId, label, chat, when }]
async function arrange(cfg, kind, entries, { signal } = {}) {
  if (entries.length < 4) return { groups: 0, placed: 0, unsorted: entries.length, note: 'too few items to group' };

  const list = entries.map((e, i) => factLine(i + 1, e)).join('\n');
  const user = `Here are ${entries.length} items.\n\n${list}${existingBlock(kind)}${housRules()}`
    + '\n\nGroup them. Refer to items by their number only.';

  // A model on this machine answers 200 whatever it is sent: Ollama drops
  // what will not fit its context from the front of the prompt and says
  // nothing. Measured here, an 18,000-token list was reported back as 2,050
  // tokens and answered from the tail of it alone. A set of albums built from
  // the last tenth of the library, presented as if it had seen all of it, is
  // worse than no albums at all — so this is not attempted blind. Existing
  // albums are left exactly as they are.
  if (cfg.local) {
    const approx = Math.round((SYSTEM.length + user.length) / 4);
    if (approx > LOCAL_PROMPT_TOKENS) {
      return {
        groups: 0, placed: 0, unsorted: entries.length, coverage: 0,
        note: 'too many items to group on a model running here (' + entries.length + ' items, about '
          + approx + ' tokens against a ' + LOCAL_PROMPT_TOKENS + ' budget) — the labels are all there, and the albums were left alone',
      };
    }
  }

  // Enough room for group names plus a few hundred small integers.
  const maxTokens = Math.min(8000, 1200 + entries.length * 6);
  const res = await complete(cfg, { system: SYSTEM, user, schema: ARRANGE_SCHEMA, schemaName: 'arrangement', maxTokens, signal });

  const { groups, placed } = validate(res.json, entries.length);

  // "Nothing groups well" is a legitimate answer, and so is one where every
  // proposal was too thin to keep. Either way the rewrite below would empty
  // every album and then delete it — including one the user named. Keep what
  // is already there instead; the call is still billed because it happened.
  if (!groups.length) {
    return {
      groups: 0, placed: 0, unsorted: entries.length, coverage: 0,
      usage: res.usage, cost: res.cost, costCap: res.costCap,
      note: 'the model proposed no usable groups — the existing albums were left alone',
    };
  }

  // Existing user placements are re-applied after the AI's, so a correction is
  // never undone by a later re-arrange.
  const userPlaced = ai.db().prepare(`SELECT kind, ref_id, group_id FROM ai_group_members WHERE source = 'user' AND kind IN (${kindFilter(kind)})`).all();
  ai.clearAiMembers(kind === 'media' ? 'image' : 'chat');
  if (kind === 'media') ai.clearAiMembers('video');

  const existing = ai.listGroups(kind);
  const byId = new Map(existing.map((g) => [g.id, g]));
  // Not every model echoes the ids it was given — some return a fresh list with
  // the same names. Falling back to a name match keeps that from silently
  // creating a second "Deliveries" alongside the first. Names the album used to
  // carry count too, so an album the user renamed is still recognised by the
  // name the model remembers it by.
  const byName = new Map();
  for (const g of existing) for (const alias of ai.aliasesOf(g)) byName.set(alias.trim().toLowerCase(), g);
  for (const g of existing) byName.set(g.name.trim().toLowerCase(), g);   // current names win
  const used = new Set();

  for (const g of groups) {
    let match = (g.id && byId.get(g.id)) || byName.get(g.name.trim().toLowerCase()) || null;
    if (match && used.has(match.id)) match = null;      // two proposed groups can't claim one existing group
    const id = match ? match.id : ai.createGroup({ kind, name: g.name, description: g.description, emoji: g.emoji });
    used.add(id);
    if (match) {
      // A name the user chose is theirs; only the description follows the AI.
      ai.db().prepare(`UPDATE ai_groups SET description = ?, emoji = COALESCE(NULLIF(?, ''), emoji),
        name = CASE WHEN pinned = 1 THEN name ELSE ? END WHERE id = ?`)
        .run(g.description, g.emoji, g.name, id);
    }
    for (const n of g.members) {
      const e = entries[n - 1];
      if (e) ai.setMember(e.kind, e.refId, id, 'ai');
    }
  }
  for (const row of userPlaced) ai.setMember(row.kind, row.ref_id, row.group_id, 'user');
  ai.mergeDuplicateNames(kind);
  ai.pruneEmptyGroups(kind);

  return {
    groups: groups.length,
    placed,
    unsorted: entries.length - placed,
    coverage: entries.length ? Math.round((placed / entries.length) * 100) : 0,
    usage: res.usage,
    cost: res.cost,
    costCap: res.costCap,
  };
}

const kindFilter = (kind) => (kind === 'media' ? `'image','video'` : `'chat'`);

// Placing one new item without re-arranging the world.
const ASSIGN_SCHEMA = {
  type: 'object',
  properties: {
    group_id: { type: 'string', description: 'The id of the group it belongs in, or an empty string for none.' },
    confidence: { type: 'number', description: '0 to 1.' },
  },
  required: ['group_id', 'confidence'],
  additionalProperties: false,
};

async function assignOne(cfg, kind, entry) {
  const groups = ai.listGroups(kind);
  if (!groups.length) return { assigned: null };
  const list = groups.map((g) => `- ${g.id} — "${g.name}": ${g.description || ''}`).join('\n');
  const res = await complete(cfg, {
    system: 'You place one new item into an existing group, or into none. Only choose a group if it clearly belongs; an empty string is the right answer more often than not.',
    user: `Existing groups:\n${list}\n\nThe new item:\n${factLine(1, entry).slice(3)}\n\nWhich group?`,
    schema: ASSIGN_SCHEMA, schemaName: 'assignment', maxTokens: 100,
  });
  // Every other call in this module is wrapped by a run row that records what
  // it cost. This one is reachable from outside and was not: whatever it spent
  // was invisible to the monthly total and to the cap that is supposed to stop
  // it. Its own row is small, and honest.
  try {
    const runId = ai.startRun('assign', cfg.model, cfg.provider);
    ai.updateRun(runId, {
      items: 1, ok: 1, failed: 0, skipped: 0,
      tokens_in: (res.usage && res.usage.in) || 0,
      tokens_out: (res.usage && res.usage.out) || 0,
      cost_usd: res.cost || 0, cost_cap_usd: res.costCap || 0,
      finished_at: Date.now(),
    });
  } catch (_) {}

  const id = res.json && res.json.group_id;
  const conf = (res.json && res.json.confidence) || 0;
  if (id && conf >= 0.6 && groups.some((g) => g.id === id)) {
    ai.setMember(entry.kind, entry.refId, id, 'ai');
    return { assigned: id, confidence: conf, usage: res.usage, cost: res.cost };
  }
  return { assigned: null, confidence: conf, usage: res.usage, cost: res.cost };
}

module.exports = { arrange, assignOne, validate, factLine, ARRANGE_SCHEMA };
