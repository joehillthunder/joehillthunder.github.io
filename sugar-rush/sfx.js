// sfx.js — every sound is synthesised here with Web Audio (no audio files).

let ctx = null;
let muted = false;

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.15, slide = 0, delay = 0 } = {}) {
  const a = ac();
  if (!a || muted) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  unlock: () => ac(),
  setMuted(v) {
    muted = v;
  },
  get muted() {
    return muted;
  },
  jump: () => tone(420, 0.16, { type: 'square', gain: 0.06, slide: 380 }),
  bounce: () => tone(220, 0.35, { type: 'sine', gain: 0.18, slide: 700 }),
  dash: () => tone(900, 0.18, { type: 'sawtooth', gain: 0.04, slide: -600 }),
  seal: () => [660, 880, 1320].forEach((f, i) => tone(f, 0.22, { type: 'triangle', gain: 0.12, delay: i * 0.07 })),
  hurt: () => tone(300, 0.4, { type: 'square', gain: 0.07, slide: -220 }),
  locked: () => tone(180, 0.2, { type: 'triangle', gain: 0.1 }),
  win: () => [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.35, { type: 'triangle', gain: 0.12, delay: i * 0.1 })),
};
