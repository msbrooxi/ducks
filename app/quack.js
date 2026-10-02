// A real "quack" cue for checking off a task, and a small parade sound for
// filling all five ducks. Synthesized with the Web Audio API so there is no
// audio file to fetch and no licensing question for a public repo.
//
// Revised 2026-10-02 (v3): v2 (noise + swept bandpass, plus a sawtooth
// "buzz" layer) was closer but still read as a kazoo/computerized "squeak"
// rather than a duck, per direct feedback ("the awful quack noise", "more
// like a computerized rubber duckie"). The missing piece is a duck quack's
// actual acoustic structure: a buzzy source (vocal folds) with a FAST
// downward pitch glide, shaped by two fixed formant resonances (the vocal
// tract), plus a fast amplitude "tremolo" that gives it the characteristic
// rough, warbly texture instead of a clean tone. This version builds that
// directly: one sawtooth source with a steep pitch drop, split through two
// parallel bandpass filters tuned to duck-like formants (~700Hz, ~2200Hz),
// recombined, and amplitude-modulated at ~140Hz for the buzzy texture.

import { getLocal } from './store.js?v=2026-10-02.8';

let ctx = null;
function ctx_() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

let noiseBufferCache = null;
function noiseBuffer_() {
  const c = ctx_();
  if (noiseBufferCache && noiseBufferCache.sampleRate === c.sampleRate) return noiseBufferCache;
  const seconds = 0.3;
  const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBufferCache = buffer;
  return buffer;
}

let clipCurveCache = null;
function softClipCurve_() {
  if (clipCurveCache) return clipCurveCache;
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 4); // more saturation than v2: more grit, less tone
  }
  clipCurveCache = curve;
  return curve;
}

// One "wonk": a buzzy sawtooth source with a fast downward pitch glide
// (the single biggest thing that makes something sound like a quack
// instead of a tone), split through two parallel formant filters, an
// onset noise chuff for the breathy attack, and a fast tremolo for the
// rough, buzzy texture real duck quacks have instead of a clean note.
function quackBurst_(dest, startTime, duration, pitchStart, pitchEnd, gainPeak) {
  const c = ctx_();

  // Source: sawtooth through a soft clipper, fast glide down in pitch.
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(pitchStart, startTime);
  osc.frequency.exponentialRampToValueAtTime(pitchEnd, startTime + duration * 0.85);

  const shaper = c.createWaveShaper();
  shaper.curve = softClipCurve_();
  osc.connect(shaper);

  // Tremolo: fast amplitude wobble on the source itself, this is what
  // reads as "buzzy/rough" rather than a clean synth tone.
  const tremolo = c.createOscillator();
  tremolo.type = 'sine';
  tremolo.frequency.value = 135;
  const tremoloGain = c.createGain();
  tremoloGain.gain.value = 0.5;
  const tremoloOffset = c.createConstantSource();
  tremoloOffset.offset.value = 0.5;
  const sourceGain = c.createGain();
  tremolo.connect(tremoloGain).connect(sourceGain.gain);
  tremoloOffset.connect(sourceGain.gain);
  shaper.connect(sourceGain);

  // Two parallel formant resonances (vocal-tract-like peaks), then a
  // shared envelope and out.
  const formant1 = c.createBiquadFilter();
  formant1.type = 'bandpass';
  formant1.frequency.value = 700;
  formant1.Q.value = 6;
  const formant2 = c.createBiquadFilter();
  formant2.type = 'bandpass';
  formant2.frequency.value = 2200;
  formant2.Q.value = 5;

  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0, startTime);
  envelope.gain.linearRampToValueAtTime(gainPeak, startTime + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  sourceGain.connect(formant1).connect(envelope);
  sourceGain.connect(formant2).connect(envelope);
  envelope.connect(dest);

  // A short burst of noise at the very onset: the breathy "chuff" at the
  // start of a real quack, layered under the tonal part.
  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer_();
  const noiseFilter = c.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 1800;
  noiseFilter.Q.value = 1.2;
  const noiseGain = c.createGain();
  noiseGain.gain.setValueAtTime(gainPeak * 0.5, startTime);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration * 0.3);
  noise.connect(noiseFilter).connect(noiseGain).connect(dest);

  osc.start(startTime); osc.stop(startTime + duration);
  tremolo.start(startTime); tremolo.stop(startTime + duration);
  tremoloOffset.start(startTime); tremoloOffset.stop(startTime + duration);
  noise.start(startTime); noise.stop(startTime + duration);
}

function tone_(freq, startTime, duration, gainPeak = 0.12) {
  const c = ctx_();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

export function playQuack() {
  if (getLocal().muted) return;
  try {
    const c = ctx_();
    const t = c.currentTime;
    // Classic two-part "quack-quack": a longer wonk then a shorter one,
    // each with its own downward pitch glide.
    quackBurst_(c.destination, t, 0.17, 480, 230, 0.9);
    quackBurst_(c.destination, t + 0.15, 0.12, 420, 210, 0.65);
  } catch (e) { /* audio blocked until a user gesture; fine, silent no-op */ }
}

export function playParade() {
  if (getLocal().muted) return;
  try {
    const c = ctx_();
    const t = c.currentTime;
    // A little chorus of quacks (the five ducks), then a bright flourish.
    const quacks = [0, 0.19, 0.38];
    quacks.forEach((offset, i) => quackBurst_(c.destination, t + offset, 0.15, 480 - i * 30, 230 - i * 15, 0.75));
    const notes = [620, 720, 820];
    notes.forEach((f, i) => tone_(f, t + 0.62 + i * 0.1, 0.14, 0.1));
  } catch (e) { /* no-op */ }
}
