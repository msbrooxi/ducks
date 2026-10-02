// A real "quack" cue for checking off a task, and a small parade sound for
// filling all five ducks.
//
// Revised 2026-10-02 (v4): v1-v3 synthesized the quack from raw oscillators
// and filtered noise (no audio file, no licensing question), tuned purely
// from acoustic reasoning since there was no way to actually listen to the
// result turn to turn. After three rounds of "still sounds like a kazoo" /
// "a computerized rubber duckie," Stephanie supplied a real recording
// instead. This now plays that sample directly rather than synthesizing
// anything. See README.md for the required attribution (CC-BY 3.0, not
// public domain, so this stays attributed as long as the file ships here).
// The synthesized tone_() flourish for the five-ducks parade is kept,
// that part was never what anyone complained about.

import { getLocal } from './store.js?v=2026-10-02.19';

let ctx = null;
function ctx_() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

// Kicked off immediately on module load (a plain fetch, no AudioContext
// involved yet) so the clip is already in memory by the time she first
// taps "Done," rather than waiting on a network round trip at that moment.
let quackBufferPromise = null;
function quackBuffer_() {
  if (!quackBufferPromise) {
    quackBufferPromise = fetch('../audio/quack.wav?v=2026-10-02.19')
      .then((res) => res.arrayBuffer())
      .then((data) => ctx_().decodeAudioData(data));
  }
  return quackBufferPromise;
}
quackBuffer_().catch(() => { /* will just retry on first actual play */ });

function playBuffer_(buffer, startTime, gainValue, playbackRate) {
  const c = ctx_();
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = playbackRate;
  const gain = c.createGain();
  gain.gain.value = gainValue;
  source.connect(gain).connect(c.destination);
  source.start(startTime);
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

export async function playQuack() {
  if (getLocal().muted) return;
  try {
    const buffer = await quackBuffer_();
    playBuffer_(buffer, ctx_().currentTime, 1, 1);
  } catch (e) { /* audio blocked until a user gesture, or fetch failed; silent no-op */ }
}

export async function playParade() {
  if (getLocal().muted) return;
  try {
    const buffer = await quackBuffer_();
    const c = ctx_();
    const t = c.currentTime;
    // A little chorus of quacks (the five ducks), each a touch higher
    // pitched than the last (playbackRate nudges pitch along with speed,
    // close enough for a chorus effect from one sample), then a bright
    // tonal flourish.
    const quacks = [0, 0.3, 0.6];
    quacks.forEach((offset, i) => playBuffer_(buffer, t + offset, 0.85, 1 + i * 0.08));
    const notes = [620, 720, 820];
    notes.forEach((f, i) => tone_(f, t + 1.1 + i * 0.1, 0.14, 0.1));
  } catch (e) { /* no-op */ }
}
