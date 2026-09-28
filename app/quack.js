// A quiet "quack" cue for checking off a task, and a small parade sound
// for filling all five ducks. Synthesized with the Web Audio API so there
// is no audio file to fetch. It's a placeholder blip more than a real
// quack; swap in a recorded sound later if Stephanie finds one she likes
// better, same two function names, nothing else needs to change.

import { getLocal } from './store.js';

let ctx = null;
function ctx_() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

function tone_(freq, startTime, duration, gainPeak = 0.15) {
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
    tone_(620, t, 0.09);
    tone_(420, t + 0.08, 0.12);
  } catch (e) { /* audio blocked until a user gesture; fine, silent no-op */ }
}

export function playParade() {
  if (getLocal().muted) return;
  try {
    const c = ctx_();
    const t = c.currentTime;
    const notes = [520, 620, 520, 720, 820];
    notes.forEach((f, i) => tone_(f, t + i * 0.12, 0.14, 0.12));
  } catch (e) { /* no-op */ }
}
