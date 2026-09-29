// A quiet "quack" cue for checking off a task, and a small parade sound
// for filling all five ducks. Synthesized with the Web Audio API so there
// is no audio file to fetch and no licensing question for a public repo.
//
// Revised 2026-09-29 (v2): the first synthesized version was noise through
// a swept bandpass filter alone, which read as thin/breathy rather than a
// real quack. Real duck quacks have a buzzy vocal-fold component under the
// breathy noise, not just noise. This layers a fast-sweeping sawtooth
// (through a soft clipper for grit) underneath the same noise sweep, which
// is what gives it body instead of a whisper.

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

let clipCurveCache = null;
function softClipCurve_() {
  if (clipCurveCache) return clipCurveCache;
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 3); // gentle saturation, adds grit not harshness
  }
  clipCurveCache = curve;
  return curve;
}

// The breathy layer: noise through a swept bandpass filter.
function noiseLayer_(dest, startTime, duration, freqStart, freqEnd, gainPeak) {
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
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  noise.connect(filter).connect(gain).connect(dest);
  noise.start(startTime);
  noise.stop(startTime + duration);
}

// The buzzy layer: a fast downward-sweeping sawtooth through a soft
// clipper, this is what gives the quack actual body instead of a hiss.
function buzzLayer_(dest, startTime, duration, freqStart, freqEnd, gainPeak) {
  const c = ctx_();
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freqStart, startTime);
  osc.frequency.exponentialRampToValueAtTime(freqEnd, startTime + duration);

  const shaper = c.createWaveShaper();
  shaper.curve = softClipCurve_();

  const gain = c.createGain();
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(shaper).connect(gain).connect(dest);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

// One "wonk": both layers together, same envelope shape, same sweep
// direction, so they read as one sound rather than two separate ones.
function quackBurst_(startTime, duration, freqStart, freqEnd, gainPeak) {
  const c = ctx_();
  noiseLayer_(c.destination, startTime, duration, freqStart * 2.2, freqEnd * 1.6, gainPeak * 0.8);
  buzzLayer_(c.destination, startTime, duration, freqStart * 0.6, freqEnd * 0.45, gainPeak);
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
    quackBurst_(t, 0.16, 900, 300, 0.7);
    quackBurst_(t + 0.13, 0.11, 750, 260, 0.5);
  } catch (e) { /* audio blocked until a user gesture; fine, silent no-op */ }
}

export function playParade() {
  if (getLocal().muted) return;
  try {
    const c = ctx_();
    const t = c.currentTime;
    // A little chorus of quacks (the five ducks), then a bright flourish.
    const quacks = [0, 0.18, 0.36];
    quacks.forEach((offset, i) => quackBurst_(t + offset, 0.14, 900 - i * 60, 300 - i * 20, 0.6));
    const notes = [620, 720, 820];
    notes.forEach((f, i) => tone_(f, t + 0.58 + i * 0.1, 0.14, 0.1));
  } catch (e) { /* no-op */ }
}
