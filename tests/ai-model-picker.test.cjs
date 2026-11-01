'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createValidationState, normalize, signature, normalizeCatalogue } = require('../public/ai-models');
const saved = { provider: 'openai', model: 'gpt-6-luna', modelMode: 'manual', baseUrl: 'https://api.openai.com/v1', apiMode: 'auto', effort: 'auto' };

test('Auto can be saved without testing a model and retains the separate manual model ID', () => {
  const state = createValidationState(); state.setSaved(saved);
  const automatic = { ...saved, modelMode: 'auto' };
  assert.equal(state.canSave(automatic), true); assert.equal(state.state(automatic), 'automatic');
  assert.equal(state.canSave({ ...automatic, model: '' }), true);
  assert.equal(normalize(automatic).model, saved.model);
  assert.equal(normalize({ provider: 'openai', model: saved.model }).modelMode, 'manual');
  assert.equal(normalize({ ...automatic, modelMode: 'unknown' }).modelMode, 'manual');
  state.setSaved(automatic); assert.equal(state.saved().model, saved.model);
  assert.equal(state.canSave(saved), true, 'returning to the retained manual choice requires no new test');
  assert.equal(state.canSave({ ...saved, model: 'gpt-6.1-sol' }), false);
});

test('switching mode cancels a pending probe and Auto never validates an untested manual choice', () => {
  const state = createValidationState(), candidate = { ...saved, model: 'gpt-6.1-terra' };
  state.setSaved(saved); state.start(candidate); state.modeChanged();
  assert.equal(state.pending(), null);
  assert.equal(state.canSave({ ...candidate, modelMode: 'auto' }), true);
  assert.equal(state.finish(candidate, candidate, true), false, 'a late test cannot apply after switching modes');
  assert.equal(state.canSave(candidate), false);
  assert.equal(state.canSave(saved), true); assert.deepEqual(state.saved(), saved);
});

test('a default OpenAI endpoint is equivalent to the preset address filled by the settings form',()=>{
  const state=createValidationState();state.setSaved({...saved,baseUrl:''});assert.equal(state.canSave(saved),true);
  assert.equal(signature({...saved,baseUrl:''}),signature(saved));
  assert.notEqual(signature({...saved,baseUrl:'https://other.example/v1'}),signature(saved));
});

test('an untested or failed candidate cannot replace a saved primary model; keeping current settings remains possible', () => {
  const state = createValidationState(), candidate = { ...saved, model: 'gpt-6.1-sol' };
  state.setSaved(saved); assert.equal(state.canSave(saved), true); assert.equal(state.canSave(candidate), false);
  state.start(candidate); assert.equal(state.canSave(candidate), false);
  assert.equal(state.finish(candidate, candidate, false), true); assert.equal(state.canSave(candidate), false); assert.equal(state.state(candidate), 'failed');
  assert.deepEqual(state.saved(), saved); assert.equal(state.canSave(state.saved()), true);
  assert.equal(state.canSave({ ...saved, provider: 'gemini', model: 'gemini-test' }), true);
});

test('a successful probe unlocks only the exact tested model, endpoint, API mode and reasoning effort', () => {
  const state = createValidationState(), candidate = { ...saved, model: 'gpt-6.1-terra', apiMode: 'responses', effort: 'low' };
  state.setSaved(saved); state.start(candidate); assert.equal(state.finish(candidate, candidate, true), true); assert.equal(state.canSave(candidate), true);
  for (const mutation of [{ model: 'another-model' }, { baseUrl: 'https://other.example/v1' }, { apiMode: 'chat' }, { effort: 'high' }]) assert.equal(state.canSave({ ...candidate, ...mutation }), false);
  assert.equal(signature({ ...candidate, baseUrl: candidate.baseUrl + '/' }), signature(candidate));
  state.setSaved(candidate); assert.equal(state.state(candidate), 'active');
});

test('late probe results cannot validate a newer selected candidate or a newer pending test', () => {
  const state = createValidationState(), first = { ...saved, model: 'gpt-6.1-sol' }, next = { ...saved, model: 'gpt-6.1-terra' };
  state.setSaved(saved); state.start(first);
  assert.equal(state.finish(first, next, true), false); assert.equal(state.canSave(next), false); assert.equal(state.canSave(first), false);
  state.start(next); assert.equal(state.finish(first, next, true), false); assert.deepEqual(state.pending(), next);
  assert.equal(state.finish(next, next, true), true); assert.equal(state.canSave(next), true);
});

test('saving or clearing a key invalidates candidate proofs and pending probe results without changing the current saved choice', () => {
  const state = createValidationState(), candidate = { ...saved, model: 'gpt-6-astra' };
  state.setSaved(saved); state.start(candidate); state.finish(candidate, candidate, true); assert.equal(state.canSave(candidate), true);
  state.invalidate(); assert.equal(state.canSave(candidate), false); assert.equal(state.canSave(saved), true);
  state.start(candidate); state.invalidate(); assert.equal(state.finish(candidate, candidate, true), false); assert.equal(state.canSave(candidate), false);
  const copy = state.saved(); copy.model = 'changed externally'; assert.deepEqual(state.saved(), saved);
});

test('available preferred models appear first without inventing unavailable IDs or enabling retired/other API models', () => {
  const models = normalizeCatalogue([{ id: 'z-chat', category: 'chat', selectable: true }, { id: 'gpt-6.1-sol', category: 'chat', selectable: true }, { id: 'image-model', category: 'images', selectable: false }, { id: 'gpt-6-luna', category: 'chat', selectable: true }, { id: 'retired-model', category: 'retired', selectable: true }, { id: 'gpt-6.1-sol', category: 'chat', selectable: true }, null]);
  assert.deepEqual(models.filter(model => model.selectable).map(model => model.id), ['gpt-6-luna', 'gpt-6.1-sol', 'z-chat']);
  assert.equal(models.find(model => model.id === 'retired-model').selectable, false);
  assert.equal(models.some(model => model.id === 'gpt-6-astra'), false);
  assert.equal(models.find(model => model.id === 'image-model').selectable, false);
});

test('catalogue accepts backend-sized model IDs and complete large catalogues while rejecting malformed rows', () => {
  const longId = 'ft:'.padEnd(1024, 'x');
  const models = normalizeCatalogue([{ id: longId, selectable: true }, ...Array.from({ length: 5500 }, (_, index) => ({ id: 'model-' + index, selectable: true })), { id: '', selectable: true }, { id: 'x'.repeat(1025), selectable: true }]);
  assert.equal(models.length, 5501); assert.ok(models.some(model => model.id === longId));
  assert.equal(normalizeCatalogue(Array.from({ length: 20001 }, (_, index) => ({ id: 'model-' + index, selectable: true }))).length, 20000);
  assert.equal(normalize({ provider: 'openai', model: '  exact-model  ' }).model, 'exact-model');
});
