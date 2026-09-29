// A quiet "quack" cue for checking off a task, and a small parade sound
// for filling all five ducks. Synthesized with the Web Audio API so there
// is no audio file to fetch, fetch, and no licensing question for a public
// repo. The quack is filtered noise with a fast downward pitch sweep,
// which is the standard trick for a duck-quack sound (a clean oscillator
// tone, which is what the first version used, just reads as a beep).

import { getLocal } from './store.js';

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

// One "wonk": noise through a swept bandpass filter, which is what gives it
// the nasal, buzzy quack character instead of a pure electronic tone.
function quackBurst_(startTime, duration, freqStart, freqEnd, gainPeak) {
  const c = ctx_();
  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer_();
  noise.loop = true;

  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 5;
  filter.frequency.setValueAtTime(freqStart, startTime);
  filter.frequency.exponentialRampToValueAtTime(freqEnd, startTime + duration);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  noise.connect(filter).connect(gain).connect(c.destination);
  noise.start(startTime);
  noise.stop(startTime + duration);
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
    // Classic two-part "quack-quack": a longer wonk then a shorter one.
    quackBurst_(t, 0.13, 1500, 550, 0.5);
    quackBurst_(t + 0.11, 0.09, 1200, 450, 0.35);
  } catch (e) { /* audio blocked until a user gesture; fine, silent no-op */ }
}

export function playParade() {
  if (getLocal().muted) return;
  try {
    const c = ctx_();
    const t = c.currentTime;
    // A little chorus of quacks (the five ducks), then a bright flourish.
    const quacks = [0, 0.16, 0.32];
    quacks.forEach((offset, i) => quackBurst_(t + offset, 0.12, 1500 - i * 80, 500 - i * 30, 0.4));
    const notes = [620, 720, 820];
    notes.forEach((f, i) => tone_(f, t + 0.5 + i * 0.1, 0.14, 0.1));
  } catch (e) { /* no-op */ }
}
