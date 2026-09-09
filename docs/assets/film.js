/* Small, optional enhancements. No tracking, autoplay audio or animation loop. */
(function () {
  'use strict';
  var hero = document.querySelector('.film-hero');
  if (!hero) return;
  var stage = hero.querySelector('.archive-stage');
  var controls = hero.querySelector('.experience-controls');
  var motionButton = hero.querySelector('[data-motion-toggle]');
  var soundButton = hero.querySelector('[data-sound-toggle]');
  var preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  var precisePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  var motion = !preference.matches;
  var sound = false;
  var context = null;
  var master = null;
  var voices = [];
  var frame = null;
  var latestPointer = null;
  var inView = true;
  try { if (localStorage.getItem('whatsbackup-motion') === 'off') motion = false; } catch (_) {}
  var requestedMotion = motion;

  function setMotion(enabled, save) {
    if (save) requestedMotion = enabled;
    motion = enabled && !preference.matches;
    document.documentElement.classList.toggle('motion-allowed', motion);
    document.documentElement.classList.toggle('motion-on', motion && !preference.matches && !document.hidden && inView);
    motionButton.textContent = preference.matches ? 'Reduced motion' : motion ? 'Pause motion' : 'Motion: off';
    motionButton.disabled = preference.matches;
    motionButton.setAttribute('aria-pressed', String(motion));
    if (!motion || preference.matches || !inView) {
      stage.style.removeProperty('--rx'); stage.style.removeProperty('--ry');
    }
    if (save) { try { localStorage.setItem('whatsbackup-motion', motion ? 'on' : 'off'); } catch (_) {} }
  }
  controls.hidden = false;
  setMotion(motion, false);
  motionButton.addEventListener('click', function () { setMotion(!motion, true); });
  preference.addEventListener('change', function () { setMotion(requestedMotion, false); });
  stage.addEventListener('pointermove', function (event) {
    if (!motion || preference.matches || !precisePointer.matches) return;
    latestPointer = { x: event.clientX, y: event.clientY };
    if (frame !== null) return;
    frame = requestAnimationFrame(function () {
      frame = null;
      if (!motion || preference.matches) return;
      var rect = stage.getBoundingClientRect();
      stage.style.setProperty('--ry', ((latestPointer.x - rect.left) / rect.width * 12 - 6).toFixed(2) + 'deg');
      stage.style.setProperty('--rx', (5 - (latestPointer.y - rect.top) / rect.height * 10).toFixed(2) + 'deg');
    });
  });
  stage.addEventListener('pointerleave', function () {
    stage.style.removeProperty('--rx'); stage.style.removeProperty('--ry');
  });

  function paintSound() {
    soundButton.textContent = sound ? 'Sound: on' : 'Sound: off';
    soundButton.setAttribute('aria-pressed', String(sound));
  }
  async function stopSound() {
    sound = false; paintSound();
    if (!context) return;
    voices.forEach(function (voice) { try { voice.stop(); } catch (_) {} });
    voices = [];
    var closing = context;
    context = null; master = null;
    try { await closing.close(); } catch (_) {}
  }
  soundButton.addEventListener('click', async function () {
    if (sound) { await stopSound(); return; }
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) { soundButton.textContent = 'Sound unavailable'; soundButton.disabled = true; return; }
    soundButton.disabled = true;
    try {
      context = new AudioContext();
      await context.resume();
      if (document.hidden) { await stopSound(); return; }
      master = context.createGain();
      master.gain.setValueAtTime(0, context.currentTime);
      master.gain.linearRampToValueAtTime(0.018, context.currentTime + 1.5);
      master.connect(context.destination);
      [130.81, 196, 261.63].forEach(function (frequency, i) {
        var oscillator = context.createOscillator();
        var gain = context.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.value = 0.45 / (i + 1);
        oscillator.connect(gain); gain.connect(master); oscillator.start(); voices.push(oscillator);
      });
      sound = true; paintSound();
    } catch (_) { await stopSound(); soundButton.textContent = 'Sound unavailable'; }
    finally { soundButton.disabled = false; }
  });
  function cue() {
    if (!sound || !context || !master) return;
    var oscillator = context.createOscillator(), gain = context.createGain(), time = context.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(523.25, time);
    oscillator.frequency.exponentialRampToValueAtTime(659.25, time + 0.16);
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(0.35, time + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
    oscillator.connect(gain); gain.connect(master); oscillator.start(); oscillator.stop(time + 0.35);
    oscillator.onended = function () { oscillator.disconnect(); gain.disconnect(); };
  }

  var story = document.querySelector('.story-stage');
  var steps = Array.from(document.querySelectorAll('[data-story-step]'));
  function showStep(step) {
    if (!story) return;
    story.setAttribute('data-active', step);
    steps.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.storyStep === step)); });
    story.querySelectorAll('[data-step-caption]').forEach(function (caption) { caption.hidden = caption.dataset.stepCaption !== step; });
  }
  steps.forEach(function (button) {
    button.addEventListener('click', function () { showStep(button.dataset.storyStep); cue(); });
  });
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.target === hero) { inView = entry.isIntersecting; setMotion(motion, false); }
        else if (entry.isIntersecting) showStep(entry.target.dataset.chapter);
      });
    }, { rootMargin: '-20% 0px -30% 0px', threshold: 0 });
    observer.observe(hero);
    document.querySelectorAll('[data-chapter]').forEach(function (chapter) { observer.observe(chapter); });
  }
  document.querySelectorAll('.demo-tabs button').forEach(function (button) { button.addEventListener('click', cue); });
  document.addEventListener('visibilitychange', function () {
    setMotion(motion, false);
    if (document.hidden) stopSound();
  });
  window.addEventListener('pagehide', function () {
    if (frame !== null) cancelAnimationFrame(frame);
    stopSound();
  });
})();
