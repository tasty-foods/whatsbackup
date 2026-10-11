'use strict';
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const list = (value, count = 12) => Array.isArray(value) ? value.map(v => text(v, 500)).filter(Boolean).slice(0, count) : [];
function visualLabel(value) {
  const v = value && typeof value === 'object' ? value : {};
  const result = { caption: text(v.caption, 3000), scene: text(v.scene, 500), text_in_image: text(v.text_in_image, 3000), subjects: list(v.subjects, 12), tags: list(v.tags, 20), details: list(v.details, 12) };
  if (!result.caption && !result.details.length && !result.text_in_image) throw new Error('The AI returned no usable description. Try another model or retry this file.');
  return result;
}
function frameLabels(value, allowed) {
  if (!Array.isArray(value)) throw new Error('The AI did not describe the sampled video frames. Retry this file.');
  const times = new Set(allowed), seen = new Set();
  const frames = [];
  for (const row of value) {
    if (!row || !times.has(row.seconds) || seen.has(row.seconds)) continue;
    const description = text(row.description, 3000);
    if (!description) continue;
    seen.add(row.seconds); frames.push({ seconds: row.seconds, description });
  }
  if (!frames.length) throw new Error('The AI returned no descriptions at the supplied video timestamps. Retry this file.');
  return frames.sort((a, b) => a.seconds - b.seconds);
}
module.exports = { visualLabel, frameLabels };
