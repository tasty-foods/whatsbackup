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
// A 64×64 red square. It was 8×8, and Groq refuses anything under 32 pixels
// a side ("Image must have at least 32 pixels in each dimension") — which
// marked a model that reads photos perfectly well as blind.
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';

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
    // Kept off the JSON, for whoever asked to decide whether to rest it.
    Object.defineProperty(out, 'error', { value: e, enumerable: false });
    out.json = step(false, 'not tested');
    out.vision = step(false, 'not tested');
    return out;
  }

  // 2. Structured output actually honoured
  try {
    const r = await complete(cfg, {
      system: 'You return JSON only.',
      user: 'Return {"ok": true}.',
      schema: OK_SCHEMA, schemaName: 'probe', maxTokens: 300,
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
      schema: COLOUR_SCHEMA, schemaName: 'colour', maxTokens: 300,
    });
    const said = String((r.json && r.json.colour) || r.text || '').toLowerCase();
    // Asked for a colour word, a model that answers "#ff0000" has read the
    // square perfectly and only disagreed about the wording. Failing it here is
    // not cosmetic: a failed probe marks the provider blind, and the runner then
    // skips every photo. So the hex and rgb spellings count as seeing red too.
    const flat = said.replace(/\s+/g, '');
    const saysRed = /red|rood|rouge|rot|rojo|rosso|vermelho|crimson|scarlet/.test(said)
      || /#?ff0000|#f00(?![0-9a-f])/.test(flat)
      || /rgba?\(255,0,0/.test(flat)
      || /(^|[^0-9])255,0,0([^0-9]|$)/.test(flat);
    out.vision = saysRed
      ? step(true, 'the model can see images')
      : step(false, `shown a red square, it said "${said.slice(0, 40)}" — image sorting will be unavailable`);
    out.visionVerdict = saysRed ? 'yes' : 'no';
  } catch (e) {
    // Only a refusal of the image itself says the model is blind. Running out
    // of quota, a busy server or a dropped connection on this third request
    // says nothing about its eyes — on 2026-10-12 a daily limit reached here
    // marked Gemini and Groq blind, and every photo would have skipped them.
    const aboutImages = (e.kind === 'model' || e.status === 400) && e.kind !== 'billing' && e.kind !== 'auth';
    out.vision = step(false, aboutImages ? 'this model cannot accept images — image sorting will be unavailable (' + String(e.message || '').slice(0, 200) + ')' : e.message);
    out.visionVerdict = aboutImages ? 'no' : 'unknown';
    if (!aboutImages) Object.defineProperty(out, 'visionError', { value: e, enumerable: false });
  }

  return out;
}

module.exports = { probe, RED_PNG };
