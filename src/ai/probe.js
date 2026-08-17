'use strict';
// "Test connection" asks the model three separate questions, because a single
// green tick hides the failures that actually cost money:
//   1. reachable — is the key valid and the model name real?
//   2. json     — is structured output honoured, or quietly ignored? (Ollama
//                 accepts response_format and ignores it)
//   3. vision   — do image parts survive the route? (a gateway can hand the
//                 request to a text-only model and drop them)
// Answering these once, for a few hundred tokens, is the difference between
// knowing and finding out over 427 charged failures.
const { complete, AiError } = require('./provider');

// 8x8 solid red PNG, 75 bytes.
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

const OK_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
const COLOUR_SCHEMA = {
  type: 'object',
  properties: { colour: { type: 'string' } },
  required: ['colour'],
  additionalProperties: false,
};

const step = (ok, detail) => ({ ok, detail });

async function probe(cfg) {
  const out = { provider: cfg.provider, model: cfg.model, at: Date.now() };

  // 1. Reachable
  try {
    const r = await complete(cfg, { system: 'Answer with one word.', user: 'Say READY.', maxTokens: 16 });
    out.reachable = step(true, `answered in ${r.ms} ms`);
    out.usage = r.usage;
  } catch (e) {
    out.reachable = step(false, e.message);
    out.errorKind = e.kind;
    out.json = step(false, 'not tested');
    out.vision = step(false, 'not tested');
    return out;
  }

  // 2. Structured output actually honoured
  try {
    const r = await complete(cfg, {
      system: 'You return JSON only.',
      user: 'Return {"ok": true}.',
      schema: OK_SCHEMA, schemaName: 'probe', maxTokens: 64,
    });
    out.json = r.json && r.json.ok === true
      ? step(true, 'structured replies work')
      : step(false, `asked for {"ok":true}, got ${JSON.stringify(r.json)}`);
  } catch (e) {
    out.json = step(false, e.kind === 'schema'
      ? 'this model accepts the request but ignores the requested format — the app will ask it in plain words instead'
      : e.message);
  }

  // 3. Images survive the route
  try {
    const r = await complete(cfg, {
      system: 'You describe images literally.',
      user: 'What colour fills this image? Answer with one colour word.',
      images: [{ mediaType: 'image/png', data: RED_PNG }],
      schema: COLOUR_SCHEMA, schemaName: 'colour', maxTokens: 64,
    });
    const said = String((r.json && r.json.colour) || r.text || '').toLowerCase();
    out.vision = /red|rood|rouge|rot|rojo/.test(said)
      ? step(true, 'the model can see images')
      : step(false, `shown a red square, it said "${said.slice(0, 40)}" — image sorting will be unavailable`);
  } catch (e) {
    out.vision = step(false, e.kind === 'model' || e.status === 400
      ? 'this model cannot accept images — image sorting will be unavailable'
      : e.message);
  }

  return out;
}

module.exports = { probe, RED_PNG };
