'use strict';
(function (root) {
  const normalize = value => ({ provider: String(value?.provider || ''), model: String(value?.model || '').trim(), modelMode: value?.modelMode === 'auto' ? 'auto' : 'manual', baseUrl: String(value?.baseUrl || (value?.provider === 'openai' ? 'https://api.openai.com/v1' : '')).trim().replace(/\/+$/, ''), apiMode: String(value?.apiMode || 'auto'), effort: String(value?.effort || 'auto') });
  const signature = value => JSON.stringify(normalize(value));
  const preferred = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra'];
  function normalizeCatalogue(value) {
    const seen = new Set(), rank = id => { const index = preferred.indexOf(id); return index < 0 ? preferred.length : index; };
    return (Array.isArray(value) ? value : []).filter(model => model && typeof model.id === 'string' && model.id.length > 0 && model.id.length <= 1024 && !seen.has(model.id) && seen.add(model.id)).slice(0, 20000)
      .map(model => ({ ...model, selectable: model.selectable === true && model.category !== 'retired' }))
      .sort((a, b) => Number(b.selectable) - Number(a.selectable) || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  }
  function createValidationState() {
    let saved = null, manualSaved = null, pending = null, tested = null;
    return {
      setSaved(value) { saved = normalize(value); manualSaved = normalize({ ...saved, modelMode: 'manual' }); if (tested && signature(tested) !== signature(manualSaved)) tested = null; },
      saved: () => saved && { ...saved },
      pending: () => pending && { ...pending },
      invalidate() { pending = null; tested = null; },
      modeChanged() { pending = null; },
      start(value) { pending = normalize(value); tested = null; },
      finish(value, current, ok) {
        const reported = normalize(value), matching = pending && signature(pending) === signature(reported);
        if (!matching) return false;
        pending = null;
        if (signature(current) !== signature(reported)) return false;
        tested = { ...reported, ok: !!ok }; return true;
      },
      canSave(value) { const candidate = normalize(value); return candidate.provider !== 'openai' || candidate.modelMode === 'auto' || !!(candidate.model && (manualSaved && signature(manualSaved) === signature(candidate) || tested?.ok && signature(tested) === signature(candidate))); },
      state(value) {
        if (normalize(value).provider === 'openai' && normalize(value).modelMode === 'auto') return 'automatic';
        if (pending) return signature(pending) === signature(value) ? 'testing' : 'testing-other';
        if (manualSaved && signature(manualSaved) === signature(value)) return 'active';
        if (tested && signature(tested) === signature(value)) return tested.ok ? 'passed' : 'failed';
        return 'untested';
      },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { normalize, signature, normalizeCatalogue, createValidationState };
  if (!root?.document) return;

  const document = root.document, $ = id => document.getElementById(id), validation = createValidationState();
  let panel, modelRow, originalAnchor, manual, originalAria, mounted = false, catalogue = [], catalogueProvider = '', loading = false, fetchSequence = 0, fetchController = null, feedback = '', feedbackState = '', lastData = null, lastModelMode = 'manual', routingSequence = 0, routingController = null, routingLoaded = false;
  const candidate = () => normalize({ provider: $('set-aiProvider')?.value, model: $('set-aiModel')?.value, modelMode: $('set-aiOpenaiModelMode')?.value, baseUrl: $('set-aiBaseUrl')?.value, apiMode: $('set-aiOpenaiApiMode')?.value, effort: $('set-aiOpenaiReasoningEffort')?.value });
  const currentOpenAI = () => candidate().provider === 'openai';
  const automatic = () => currentOpenAI() && candidate().modelMode === 'auto';
  const labels = { chat: 'Chat and image understanding', text: 'Text models', embedding: 'Embeddings', embeddings: 'Embeddings', image: 'Image generation', images: 'Image generation', audio: 'Audio', speech: 'Speech', transcription: 'Speech transcription', realtime: 'Realtime', moderation: 'Moderation', retired: 'Retired models', other: 'Other API models', unknown: 'Other API models' };
  const categoryLabel = value => labels[value] || String(value || 'Other API models').replace(/[_-]/g, ' ');
  function renderOptions() {
    if (!mounted) return;
    const select = $('ai-model-catalogue'), query = ($('ai-model-search').value || '').toLowerCase().trim().split(/\s+/).filter(Boolean), selected = candidate().model;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.disabled = true; placeholder.textContent = loading ? 'Loading available models…' : 'Choose a model to test'; select.append(placeholder);
    const groups = new Map(); let visible = 0;
    for (const model of catalogue) {
      const hay = [model.id, model.category, model.reason].filter(Boolean).join(' ').toLowerCase();
      if (!query.every(word => hay.includes(word))) continue;
      const groupName = model.selectable ? 'Models you can test here' : categoryLabel(model.category);
      if (!groups.has(groupName)) { const group = document.createElement('optgroup'); group.label = groupName; groups.set(groupName, group); select.append(group); }
      const option = document.createElement('option'); option.value = model.id; option.disabled = !model.selectable;
      const reason = model.reason || (model.category === 'retired' ? 'Retired; cannot be selected.' : 'Uses a separate API; cannot be the archive’s chat model.');
      option.textContent = model.id + (model.selectable ? '' : ' — ' + reason); option.title = model.selectable ? model.id : reason;
      groups.get(groupName).append(option); visible++;
    }
    select.value = [...select.options].some(option => option.value === selected && !option.disabled) ? selected : '';
    select.disabled = loading || !visible;
    if (!loading && !visible) placeholder.textContent = query.length ? 'No models match this search' : 'No catalogue available — use an exact model ID below';
    const available = catalogue.filter(model => model.selectable).length, others = catalogue.length - available;
    let status = loading ? 'Loading models available to the saved OpenAI key…' : catalogue.length ? `${available} ${available === 1 ? 'model' : 'models'} can be tested here · ${others} specialised or retired${query.length ? ' · ' + visible + ' shown' : ''}.` : 'Save an OpenAI key, then refresh the catalogue. Exact model IDs can also be tested below.';
    if (lastData?.fetchedAt && !loading) { const date = new Date(lastData.fetchedAt); if (!Number.isNaN(date.getTime())) status += ' Updated ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (lastData.cached ? ' · cached' : '') + '.'; }
    $('ai-model-catalogue-status').textContent = status;
  }
  function renderValidation() {
    if (!mounted) return;
    const value = candidate(), phase = validation.state(value), saved = validation.saved();
    $('ai-model-active').textContent = saved?.provider === 'openai' && saved.model ? (saved.modelMode === 'auto' ? 'Retained manual model: ' : 'Active model: ') + saved.model : 'A new primary model takes effect only after its test passes and it is saved.';
    const output = $('ai-model-validation'); output.dataset.state = phase;
    const matchingFeedback = feedbackState === signature(value) ? feedback : '';
    output.textContent = phase === 'automatic' ? 'Automatic selection. Your manual model choice is kept for later.' : phase === 'active' ? saved?.modelMode === 'auto' ? 'Your retained manual choice. Save to use this model instead of Auto.' : 'Current saved model. You can keep using it or test a different choice.'
      : phase === 'testing' ? 'Testing this model. Your saved choice and queue stay in place.'
      : phase === 'testing-other' ? 'A previous selection is still being tested. This new choice has not been applied.'
      : phase === 'passed' ? matchingFeedback || 'Test passed. This model can now be saved.'
      : phase === 'failed' ? matchingFeedback || 'Test failed. Your saved model is still active. Try another model or keep the current one.'
      : value.model ? 'Selected: ' + value.model + '. Test connection before saving this choice.' : 'Choose a model from the list or enter an exact model ID.';
    $('ai-model-test-selected').disabled = !value.model || !!validation.pending();
    $('ai-model-keep-current').disabled = !saved || signature(saved) === signature(value);
  }
  function syncMode() {
    if (!mounted) return;
    const value = candidate(), isAuto = automatic();
    if (lastModelMode !== value.modelMode) { validation.modeChanged(); feedback = ''; feedbackState = ''; }
    lastModelMode = value.modelMode;
    $('ai-model-auto-summary').hidden = !isAuto; $('ai-model-manual-choice').hidden = isAuto;
    const testRow = $('btn-ai-test')?.closest('.row'); if (testRow) testRow.hidden = isAuto;
    const probe = $('ai-probe'); if (probe) probe.hidden = isAuto;
    const advanced = $('ai-openai-options'); if (advanced && currentOpenAI()) advanced.classList.toggle('hidden', isAuto);
    if (isAuto) {
      fetchSequence++; fetchController?.abort(); loading = false; $('ai-model-refresh').disabled = false;
      if (!routingLoaded) refreshAutoSummary();
    }
  }
  function changed() { feedback = ''; feedbackState = ''; syncMode(); renderOptions(); renderValidation(); }
  function mount() {
    if (mounted) return true;
    const input = $('set-aiModel'), provider = $('set-aiProvider');
    if (!input || !provider) return false;
    modelRow = input.closest('.row') || input.parentElement; originalAria = input.getAttribute('aria-label');
    originalAnchor = document.createComment('original model field position'); modelRow.after(originalAnchor);
    panel = document.createElement('section'); panel.id = 'ai-model-picker'; panel.className = 'ai-model-picker'; panel.hidden = true; panel.setAttribute('aria-label', 'OpenAI model selection');
    panel.innerHTML = `<label class="preference-row ai-model-mode"><span><b>Model selection</b></span><select id="set-aiOpenaiModelMode" class="txt"><option value="auto">Auto (choose for each job)</option><option value="manual" selected>Choose a model myself</option></select></label>
      <div id="ai-model-auto-summary" class="ai-model-auto-summary" hidden><p>Chooses an available OpenAI model for each job. Keeps your manual choice for later.</p><div id="ai-model-auto-routes" class="ai-model-auto-routes"></div><p id="ai-model-auto-status" class="muted small" role="status">Availability is checked when work starts.</p><button id="ai-model-auto-refresh" type="button" class="btn small">Refresh routing summary</button></div>
      <div id="ai-model-manual-choice"><div class="ai-model-heading"><label for="ai-model-search">Models available to your OpenAI key</label><button id="ai-model-refresh" type="button" class="btn small">Refresh models</button></div>
      <input id="ai-model-search" type="search" class="txt" placeholder="Search model names or types…" aria-label="Search available OpenAI models" autocomplete="off" spellcheck="false">
      <select id="ai-model-catalogue" class="txt ai-model-catalogue" size="7" aria-label="OpenAI model catalogue" aria-describedby="ai-model-catalogue-status"></select>
      <p id="ai-model-catalogue-status" class="muted small" role="status"></p>
      <p class="muted small ai-model-api-note">Other model types are listed for reference. Image generation, speech, embeddings and Realtime use separate APIs.</p>
      <details class="ai-model-manual"><summary>Enter an exact model ID</summary><p class="muted small">For fine-tuned models or an ID not shown above. This choice must pass the same connection test.</p></details>
      <p id="ai-model-active" class="small"></p><p id="ai-model-validation" class="ai-model-validation" role="status" aria-live="polite"></p>
      <div class="row wrap ai-model-actions"><button id="ai-model-test-selected" type="button" class="btn primary">Test selected model</button><button id="ai-model-keep-current" type="button" class="btn">Keep current model</button></div></div>`;
    modelRow.before(panel); manual = panel.querySelector('.ai-model-manual'); mounted = true;
    $('ai-model-search').addEventListener('input', renderOptions);
    $('ai-model-refresh').addEventListener('click', () => refresh(true));
    $('set-aiOpenaiModelMode').addEventListener('change', () => { changed(); if (!automatic() && catalogueProvider !== 'openai') refresh(); });
    $('ai-model-auto-refresh').addEventListener('click', () => { routingLoaded = false; refreshAutoSummary(); });
    $('ai-model-catalogue').addEventListener('change', () => {
      const choice = catalogue.find(model => model.id === $('ai-model-catalogue').value && model.selectable); if (!choice) return;
      input.value = choice.id; input.dispatchEvent(new Event('input', { bubbles: true })); changed();
    });
    input.addEventListener('input', changed); input.addEventListener('change', changed);
    document.addEventListener('change', event => { if (['set-aiBaseUrl', 'set-aiOpenaiApiMode', 'set-aiOpenaiReasoningEffort'].includes(event.target?.id)) changed(); });
    $('set-aiBaseUrl')?.addEventListener('input', changed);
    $('ai-model-test-selected').addEventListener('click', () => { const button = $('btn-ai-test'); if (button && !button.disabled) button.click(); });
    $('ai-model-keep-current').addEventListener('click', keepCurrent);
    return true;
  }
  async function refresh(force = false) {
    if (!mount() || !currentOpenAI() || automatic()) return;
    const ticket = ++fetchSequence; fetchController?.abort(); fetchController = new AbortController(); loading = true;
    $('ai-model-refresh').disabled = true; renderOptions();
    try {
      const response = await root.fetch('/api/ai/models?provider=openai' + (force ? '&refresh=1' : ''), { signal: fetchController.signal });
      let data; try { data = await response.json(); } catch (_) { throw new Error('The model catalogue could not be read. Try refreshing it.'); }
      if (!response.ok || data.error || data.ok === false) throw new Error(data.error || data.message || 'The OpenAI model catalogue is unavailable.');
      if (data.provider && data.provider !== 'openai') throw new Error('The server returned a different provider’s catalogue. Refresh and try again.');
      if (ticket !== fetchSequence || !currentOpenAI() || automatic()) return;
      catalogue = normalizeCatalogue(data.models); lastData = data; catalogueProvider = 'openai';
    } catch (error) {
      if (ticket !== fetchSequence || error.name === 'AbortError') return;
      $('ai-model-catalogue-status').textContent = error.message; manual.open = true;
      catalogue = []; lastData = null; catalogueProvider = '';
      loading = false; $('ai-model-refresh').disabled = false; renderOptions();
      $('ai-model-catalogue-status').textContent = error.message + ' You can enter an exact model ID below.';
      return;
    } finally {
      if (ticket === fetchSequence) { loading = false; $('ai-model-refresh').disabled = false; }
    }
    if (ticket === fetchSequence) { renderOptions(); renderValidation(); }
  }
  function applyValues(value) {
    if (value.provider != null && $('set-aiProvider')) $('set-aiProvider').value = value.provider;
    if (value.model != null && $('set-aiModel')) $('set-aiModel').value = value.model;
    if (value.modelMode != null && $('set-aiOpenaiModelMode')) $('set-aiOpenaiModelMode').value = value.modelMode;
    if (value.baseUrl != null && $('set-aiBaseUrl')) $('set-aiBaseUrl').value = value.baseUrl;
    if (value.apiMode != null && $('set-aiOpenaiApiMode')) $('set-aiOpenaiApiMode').value = value.apiMode;
    if (value.effort != null && $('set-aiOpenaiReasoningEffort')) $('set-aiOpenaiReasoningEffort').value = value.effort;
  }
  function providerChanged(value = {}) {
    if (!mount()) return;
    if (typeof value === 'string') value = { provider: value };
    applyValues(value);
    if (value.savedModel != null) validation.setSaved({ ...candidate(), model: value.savedModel });
    const openai = currentOpenAI(); panel.hidden = !openai;
    if (openai) { manual.append(modelRow); $('set-aiModel').setAttribute('aria-label', 'Exact model ID'); }
    else {
      originalAnchor.before(modelRow);
      if (originalAria == null) $('set-aiModel').removeAttribute('aria-label'); else $('set-aiModel').setAttribute('aria-label', originalAria);
      fetchSequence++; fetchController?.abort(); loading = false;
    }
    changed();
    if (openai && !automatic() && catalogueProvider !== 'openai' && !loading) refresh();
  }
  function setSaved(value) { validation.setSaved({ ...candidate(), ...value }); if (mount()) { syncMode(); renderOptions(); renderValidation(); } }
  function keepCurrent() {
    const saved = validation.saved(); if (!saved || !mount()) return;
    const wasProvider = candidate().provider; applyValues(saved);
    if (wasProvider !== saved.provider) $('set-aiProvider').dispatchEvent(new Event('change', { bubbles: true }));
    applyValues(saved); providerChanged(saved);
  }
  function testStarted(value = candidate()) { const current = { ...candidate(), ...value }; validation.start(current); feedback = ''; feedbackState = ''; if (mount()) renderValidation(); return normalize(current); }
  function testFinished(value) {
    const result = { ...(validation.pending() || candidate()), ...value }, accepted = validation.finish(result, candidate(), value?.ok);
    if (accepted) { feedback = String(value?.message || ''); feedbackState = signature(result); }
    if (mount()) renderValidation(); return accepted;
  }
  function invalidateTests() {
    validation.invalidate(); feedback = ''; feedbackState = '';
    fetchSequence++; fetchController?.abort(); catalogue = []; catalogueProvider = ''; lastData = null; loading = false;
    routingSequence++; routingController?.abort(); routingLoaded = false;
    if (mounted) { $('ai-model-auto-routes').replaceChildren(); $('ai-model-auto-status').textContent = 'Availability is checked when work starts.'; }
    if (mount()) { renderOptions(); renderValidation(); if (currentOpenAI()) { if (automatic()) refreshAutoSummary(); else refresh(true); } }
  }
  async function refreshAutoSummary() {
    if (!mount() || !automatic()) return;
    const ticket = ++routingSequence; routingController?.abort(); routingController = new AbortController(); routingLoaded = true;
    $('ai-model-auto-refresh').disabled = true; $('ai-model-auto-status').textContent = 'Checking the automatic routes…';
    try {
      const response = await root.fetch('/api/ai/auto-routing?preview=1', { signal: routingController.signal });
      if (!response.ok) throw new Error('The routing summary is unavailable.');
      const data = await response.json(); if (ticket !== routingSequence || !automatic()) return;
      const routing = data.autoRouting || {}, rawRoutes = Array.isArray(routing.routes) ? routing.routes : [];
      const container = $('ai-model-auto-routes'); container.replaceChildren();
      for (const [role, title] of [['routine', 'Everyday work'], ['visual', 'Photos and video'], ['complex', 'Complex questions']]) {
        const route = rawRoutes.find(item => item?.role === role), row = document.createElement('div'), label = document.createElement('b'), model = document.createElement('span');
        label.textContent = typeof route?.label === 'string' ? route.label : title;
        model.textContent = typeof route?.model === 'string' && route.model ? route.model + (route.available === false ? ' · not currently available' : route.available === true ? ' · listed for your key' : '') : 'Chosen when the job starts';
        row.append(label, model); container.append(row);
      }
      $('ai-model-auto-status').textContent = typeof routing.notice === 'string' ? routing.notice : 'Availability is checked when work starts. Your monthly limit applies to every route.';
    } catch (error) { if (ticket === routingSequence && error.name !== 'AbortError') { $('ai-model-auto-routes').replaceChildren(); $('ai-model-auto-status').textContent = 'Availability will be checked when work starts. The summary could not be loaded.'; } }
    finally { if (ticket === routingSequence) $('ai-model-auto-refresh').disabled = false; }
  }
  root.AiModels = { mount, providerChanged, setSaved, candidate, canSave: () => validation.canSave(candidate()), testStarted, testFinished, invalidateTests, refresh, refreshAutoSummary, keepCurrent };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})(typeof window !== 'undefined' ? window : null);
